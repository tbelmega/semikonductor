// SPDX-License-Identifier: Apache-2.0
// The app's shared client state as plain values and the rules that change
// them, so App.tsx only wires them to React. Three rules:
//
// 1. Loaded data: a value read from the server keeps the request it answers.
//    An answer, or a failure, is taken up only while it answers the newest
//    request of its kind (requestSequencer gives each request its number).
// 2. The save dialog reads the one shared workstreams list. It waits until
//    that list answers a request made no earlier than the dialog opened, so
//    an older answer can neither show nor unlock it.
// 3. Link context: the project a workflow's names resolve in is recorded
//    with the navigation that opened the workflow, whatever its location;
//    any other way of selecting a workflow records none.

import type { LocationId } from "../workflowView.ts";

// ------------------------------------------------------------ loaded data

// at: the request whose answer value is, 0 before any. failed: the newest
// request that failed since, with the reason.
export interface Loaded<T> {
  value: T;
  at: number;
  failed?: { at: number; error: string };
}

export const loaded = <T>(value: T): Loaded<T> => ({ value, at: 0 });

// Request `at` answered with `value`; `newest` says whether it is still the
// newest request of its kind.
export function answered<T>(l: Loaded<T>, at: number, value: T, newest: boolean): Loaded<T> {
  return newest ? { value, at } : l;
}

// Request `at` failed; the last value stays.
export function failedRequest<T>(l: Loaded<T>, at: number, error: string, newest: boolean): Loaded<T> {
  return newest ? { ...l, failed: { at, error } } : l;
}

// What a reader that asked with request `asked` sees: the value once it
// answers that request or a newer one; else the failure of such a request;
// else nothing yet.
export type Reading<T> = { state: "ready"; value: T } | { state: "failed"; error: string } | { state: "waiting" };

export function readingFrom<T>(l: Loaded<T>, asked: number): Reading<T> {
  if (l.at >= asked) return { state: "ready", value: l.value };
  if (l.failed && l.failed.at >= asked) return { state: "failed", error: l.failed.error };
  return { state: "waiting" };
}

// ------------------------------------------------------------ save dialog

// asked: the workstreams request made when the dialog opened; the dialog
// reads the shared list through readingFrom(list, asked). warnings: the
// engine's warnings for the file Save as new would write, and checked: the
// destination and text they were given for, so a second Save writes it
// anyway. confirmed: the Save the user pressed, while its checks run; any
// change in the dialog drops it, and so does Cancel, so a check that answers
// later writes nothing. saving: the file is being written; the dialog stays
// open until that is done.
export type SaveDialog = {
  type: "save";
  asked: number;
  asNew: boolean;
  location: LocationId;
  folder: string;
  name: string;
  error?: string;
  warnings?: string[];
  checked?: string;
  confirmed?: number;
  saving?: boolean;
};
export type NewDialog = { type: "new"; location: LocationId; folder: string; name: string; error?: string };
export type Dialog = SaveDialog | NewDialog;

const DESTINATION = ["asNew", "location", "folder", "name"] as const;

// The user changed the dialog: a pressed Save whose checks still run is
// dropped, and a change of destination drops the warnings given for the old
// one. Nothing changes while the file is being written.
export function changed<D extends Dialog>(d: D, fields: Partial<D>): D {
  if (d.type === "save" && d.saving) return d;
  const destination = DESTINATION.some((k) => k in fields);
  return {
    ...d,
    ...(d.type === "save" ? { confirmed: undefined } : {}),
    ...(d.type === "save" && destination ? { warnings: undefined, checked: undefined } : {}),
    ...fields,
  };
}

// The open text changed under the dialog, as a warning's fix does: the
// engine's warnings and a pressed Save no longer apply.
export function textChanged(d: Dialog | null): Dialog | null {
  return d?.type === "save" ? { ...d, warnings: undefined, checked: undefined, confirmed: undefined } : d;
}

// Save pressed, as press number `token`.
export function confirmedAs(d: SaveDialog, token: number): SaveDialog {
  return { ...d, confirmed: token, error: undefined };
}

// Whether the dialog is still the one whose Save was pressed as `token`.
export const stillConfirmed = (d: Dialog | null, token: number): boolean => d?.type === "save" && d.confirmed === token;

// The pressed Save no longer holds (the text changed): offered again.
export function abandoned(d: Dialog | null, token: number): Dialog | null {
  return d && stillConfirmed(d, token) ? { ...(d as SaveDialog), confirmed: undefined } : d;
}

// Its checks answered for press `token`: the dialog shows `fields`, Save can
// be pressed again. Ignored when the dialog moved on meanwhile.
export function checkedAs(d: Dialog | null, token: number, fields: Partial<SaveDialog>): Dialog | null {
  return d && stillConfirmed(d, token) ? { ...(d as SaveDialog), confirmed: undefined, saving: false, ...fields } : d;
}

// The file is being written for press `token`.
export function savingAs(d: Dialog | null, token: number): Dialog | null {
  return d && stillConfirmed(d, token) ? { ...(d as SaveDialog), saving: true } : d;
}

// Close or Cancel; refused while the file is being written.
export const closed = (d: Dialog | null): Dialog | null => (d?.type === "save" && d.saving ? d : null);

// ------------------------------------------------------------ link context

// The project a followed link was read for, with the file it led to.
export type LinkContext = { key: string; project: string } | null;

// The project the open workflow's names resolve in: the one recorded with the
// navigation that opened it; else, for another project's file, that project;
// else this project.
export function namesResolveIn(args: {
  context: LinkContext;
  currentKey: string | null;
  // The project of another project's file; undefined for this project's.
  ownProject: string | undefined;
  root: string | undefined;
}): string | undefined {
  if (args.context && args.context.key === args.currentKey) return args.context.project;
  return args.ownProject ?? args.root;
}

// The workflow a Compare choice selects, or null when it selects none. A
// choice of the right side alone keeps the left workflow selected, so it
// selects nothing: selecting would record a new selection and drop the
// project the left workflow's names resolve in, though nothing navigated it
// (rvk-state-1). A choice of the left side, or a swap, selects, even the
// workflow already selected, as choosing it from the lane does.
export function compareSelection(
  side: "left" | "right" | "swap",
  select: string | null,
  currentKey: string | null,
): string | null {
  return side === "right" && select === currentKey ? null : select;
}
