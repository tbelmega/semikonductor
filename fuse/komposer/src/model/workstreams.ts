// SPDX-License-Identifier: Apache-2.0
// The Workstreams page as data: the workstreams of each listed project,
// newest first with every child right after its parent, optionally only
// those of one workflow; the one-line summaries the rail and the left lane
// show; and the links between workstreams that the detail offers.

import { formatIssue, parseWorkflowText } from "../../../flow/src/parse.ts";

// The fields of a workstream and a project this file reads, as the server's
// /api/workstreams and /api/projects give them.
export interface WorkstreamSummary {
  project: string;
  slug: string;
  workflow?: string;
  workflowPath?: string;
  // The real path of workflowPath, when a link makes it differ.
  workflowRealPath?: string;
  // Why fuse-flow cannot read the workstream's state file.
  error?: string;
  after?: string;
  parent?: { slug: string; step: string };
  startedAfter?: string[];
  children?: { step: string; pass: number; slug: string; item?: string }[];
  // The state file's steps as recorded.
  steps?: Record<string, unknown>;
  events?: { kind: string; backFrom?: string; backTo?: string; detail: string }[];
  summary?: {
    status: string;
    currentStep?: string;
    started?: string;
    lastEvent?: string;
    ownerWaitMs: number;
    routesBack: { time: string; from: string; to: string }[];
    steps?: Record<string, { status: string }>;
    // Set when the owner closed the workstream with `fuse-flow close`.
    closed?: { date: string; at: string; reason: string };
  };
}

export interface ProjectSummary {
  path: string;
  // The project's own workflow folder.
  workflowsDir?: string;
  missing?: boolean;
  // Why the project's workstreams cannot be read.
  error?: string;
}

// CLOSED is a run's state only: the owner gave the workstream up.
export type RunState = "PENDING" | "IN_PROGRESS" | "AWAITING_OWNER" | "BLOCKED" | "COMPLETED" | "SKIPPED" | "CLOSED";
const STATES: RunState[] = ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED", "COMPLETED", "SKIPPED", "CLOSED"];

export function runState(value?: string): RunState {
  return STATES.includes(value as RunState) ? (value as RunState) : "PENDING";
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// From the start to the last event when completed or closed, else to now.
export function runDuration(run: WorkstreamSummary, now = Date.now()): number {
  const start = Date.parse(run.summary?.started ?? "");
  if (Number.isNaN(start)) return 0;
  const completed = run.summary?.status === "COMPLETED" || run.summary?.status === "CLOSED";
  const end = completed ? Date.parse(run.summary?.lastEvent ?? "") : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

export const workstreamKey = (w: Pick<WorkstreamSummary, "project" | "slug">): string => `${w.project}/${w.slug}`;

export interface WorkstreamRow<W extends WorkstreamSummary = WorkstreamSummary> {
  workstream: W;
  // How many parents above it are listed too: 0 for a top-level row.
  depth: number;
}

export interface ProjectGroup<P extends ProjectSummary = ProjectSummary, W extends WorkstreamSummary = WorkstreamSummary> {
  project: P;
  // Every workstream of the project, whatever the filter.
  total: number;
  rows: WorkstreamRow<W>[];
}

const startedAt = (w: WorkstreamSummary) => {
  const t = Date.parse(w.summary?.started ?? "");
  return Number.isNaN(t) ? -Infinity : t;
};

// Newest started first; a child follows its parent when the parent is in the
// list too, and is otherwise listed where its own start puts it.
export function orderWorkstreams<W extends WorkstreamSummary>(list: W[]): WorkstreamRow<W>[] {
  const sorted = [...list].sort((a, b) => startedAt(b) - startedAt(a) || a.slug.localeCompare(b.slug));
  const listed = new Set(sorted.map(workstreamKey));
  const parentKey = (w: W) => (w.parent ? workstreamKey({ project: w.project, slug: w.parent.slug }) : null);
  const childrenOf = new Map<string, W[]>();
  const roots: W[] = [];
  for (const w of sorted) {
    const parent = parentKey(w);
    if (parent && parent !== workstreamKey(w) && listed.has(parent)) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), w]);
    else roots.push(w);
  }
  const out: WorkstreamRow<W>[] = [];
  const seen = new Set<string>();
  const visit = (w: W, depth: number) => {
    const key = workstreamKey(w);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ workstream: w, depth });
    for (const child of childrenOf.get(key) ?? []) visit(child, depth + 1);
  };
  roots.forEach((w) => visit(w, 0));
  // A cycle of parents has no root; its members are listed at the top level.
  sorted.forEach((w) => visit(w, 0));
  return out;
}

// A workflow file as a workstream is matched to it: its listed path, and the
// real path it leads to when a link makes them differ. A bare string is a
// path without a known real path.
export type WorkflowIdentity = string | { path: string; realPath?: string };

// Whether a workstream follows a workflow file: by the path it recorded, or,
// when a link lies on either path, by the real path both lead to. The run's
// recorded path stays the one its workflow is opened and resolved by.
export function followsWorkflow(
  run: { workflowPath?: string; workflowRealPath?: string },
  workflow: WorkflowIdentity,
): boolean {
  if (!run.workflowPath) return false;
  const { path, realPath } = typeof workflow === "string" ? { path: workflow, realPath: undefined } : workflow;
  return run.workflowPath === path || (run.workflowRealPath ?? run.workflowPath) === (realPath ?? path);
}

// The projects in their listed order, each with its workstreams; with a
// workflow, only the workstreams that follow that file.
export function groupByProject<P extends ProjectSummary, W extends WorkstreamSummary>(
  projects: P[],
  workstreams: W[],
  workflow: WorkflowIdentity | null,
): ProjectGroup<P, W>[] {
  return projects.map((project) => {
    const own = workstreams.filter((w) => w.project === project.path);
    const shown = workflow === null ? own : own.filter((w) => followsWorkflow(w, workflow));
    return { project, total: own.length, rows: orderWorkstreams(shown) };
  });
}

// "1 step", "2 steps".
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A project divider's count: all of them, or how many of them follow the
// selected workflow.
export function projectCount(group: ProjectGroup, filtered: boolean): string {
  if (group.project.missing) return "folder not found";
  if (group.project.error) return "workstreams cannot be read";
  return filtered ? `${group.rows.length} of ${plural(group.total, "workstream")}` : plural(group.total, "workstream");
}

export const isActive = (w: WorkstreamSummary) => w.summary?.status !== "COMPLETED" && w.summary?.status !== "CLOSED";

// A workflow's row in the left lane on the Workstreams page.
export function laneCount(workflow: WorkflowIdentity, workstreams: WorkstreamSummary[]): { text: string; count: number } {
  const own = workstreams.filter((w) => followsWorkflow(w, workflow));
  if (!own.length) return { text: "no workstreams", count: 0 };
  const active = own.filter(isActive).length;
  return { text: `${plural(own.length, "workstream")}${active ? ` · ${active} active` : ""}`, count: own.length };
}

// The workstream's state as its rail row and detail show it. fuse-flow gives
// a workstream the state of its current step, which is PENDING when the
// step has not been handed out yet, though work has happened, as when a
// condition holds it, an edit renamed or inserted the step, or the owner
// sent the work back and every step is PENDING again. Such a workstream has
// started: it is in progress, not "not started".
export const stateOf = (w: WorkstreamSummary): RunState => {
  const state = runState(w.summary?.status);
  return state === "PENDING" && hasProgress(w) ? "IN_PROGRESS" : state;
};

// Whether the workstream has started: its state file records an event for
// any step, also one the workflow no longer has.
export const hasProgress = (w: WorkstreamSummary): boolean =>
  (w.events?.length ?? 0) > 0 || Object.values(w.summary?.steps ?? {}).some((step) => runState(step.status) !== "PENDING");

// Why fuse-flow cannot read the workstream, or undefined: its state file, a
// workflow that is not found, or the workflow file on disk when Komposer has
// no text of it or the text is not a valid workflow. fuse-flow reads that
// file for every command, so a file Komposer could not read fails there too.
// `diskText` is that file's text on disk, when it is listed; `unreadable` is
// why it cannot be read, when the server says so.
export function workstreamProblem(w: WorkstreamSummary, diskText?: string, unreadable?: string): string | undefined {
  if (w.error) return w.error;
  if (!w.workflowPath) return `Its workflow ${w.workflow ?? ""} is not found.`;
  if (diskText === undefined) return `Its workflow ${w.workflowPath} cannot be read${unreadable ? `: ${unreadable}` : "."}`;
  const parsed = parseWorkflowText(diskText);
  if (parsed.ok) return undefined;
  const issue = parsed.issues[0];
  const why = !issue ? "it is not a valid workflow" : issue.code === "yaml" ? `it is ${issue.message}` : `it is not a valid workflow: ${formatIssue(issue)}`;
  return `Its workflow ${w.workflowPath} cannot be read: ${why.trimEnd()}`;
}

// The steps the state file records that the shown steps do not include, in
// the state file's order, with their state and what to say about them. Only
// a workflow that was read shows that it no longer has a step, as after a
// step was renamed or removed; when the workflow cannot be read (`readable`
// false), fuse-flow refuses the workstream and its steps are unknown.
export function orphanSteps(w: WorkstreamSummary, stepIds: string[], readable = true): { id: string; status: RunState; note: string }[] {
  const note = readable ? "recorded, but the workflow no longer has this step" : "recorded; the workflow cannot be read, so its steps are unknown";
  return Object.entries(w.summary?.steps ?? {})
    .filter(([id]) => !stepIds.includes(id))
    .map(([id, step]) => ({ id, status: runState(step.status), note }));
}

// The current step when fuse-flow has not handed it out although the
// workstream has started, so the owner knows to look.
export function heldStep(w: WorkstreamSummary): string | undefined {
  const current = w.summary?.currentStep;
  return current && runState(w.summary?.status) === "PENDING" && hasProgress(w) ? current : undefined;
}

// What an event says beyond its change of state: a send-back says from
// which step to which, as fuse-flow writes it, with the owner's note.
export function eventDetail(event: { kind: string; backFrom?: string; backTo?: string; detail: string }): string {
  if (event.kind === "sent-back" && event.backFrom && event.backTo)
    return `sent the work back from ${event.backFrom} to ${event.backTo}${event.detail ? `: ${event.detail}` : ""}`;
  return event.detail;
}

// Under the state pill of a rail row: where it is and for how long, or how
// long it took.
export function rowTiming(w: WorkstreamSummary, now = Date.now()): string {
  const time = duration(runDuration(w, now));
  if (stateOf(w) === "COMPLETED") return `took ${time}`;
  if (stateOf(w) === "CLOSED") return `closed · ran ${time}`;
  return w.summary?.currentStep ? `at ${w.summary.currentStep} · ${time}` : time;
}

export interface WorkstreamLink {
  // The words before the link, such as "started after".
  label: string;
  slug: string;
}

// The workstreams one is linked to, all in its own project: its parent, the
// one it was started after, its children and the ones started after it.
export function workstreamLinks(w: WorkstreamSummary, all: WorkstreamSummary[]): WorkstreamLink[] {
  const same = all.filter((x) => x.project === w.project && x.slug !== w.slug);
  const out: WorkstreamLink[] = [];
  if (w.parent) out.push({ label: `child of step ${w.parent.step} of`, slug: w.parent.slug });
  if (w.after) out.push({ label: "started after", slug: w.after });
  const children = [
    ...(w.children ?? []).map((c) => c.slug),
    ...same.filter((x) => x.parent?.slug === w.slug).map((x) => x.slug),
  ];
  [...new Set(children)].forEach((slug) => out.push({ label: "child workstream", slug }));
  const followers = [...(w.startedAfter ?? []), ...same.filter((x) => x.after === w.slug).map((x) => x.slug)];
  [...new Set(followers)].forEach((slug) => out.push({ label: "followed by", slug }));
  return out;
}

// The workflow folder in which the workflow references of a workstream's
// workflow (its workflow gates and hand-offs) are looked up by name: that of
// the workstream's own project, as fuse-flow looks them up when it runs the
// workstream. `fallback` is used when Komposer does not list the project.
export function workstreamLinkDir(w: Pick<WorkstreamSummary, "project">, projects: Pick<ProjectSummary, "path" | "workflowsDir">[], fallback: string): string {
  return projects.find((p) => p.path === w.project)?.workflowsDir ?? fallback;
}

// The four figures at the top of a workstream's summary.
export function workstreamStats(w: WorkstreamSummary, now = Date.now()): { label: string; value: string }[] {
  const s = w.summary;
  const done = stateOf(w) === "COMPLETED";
  const closed = stateOf(w) === "CLOSED";
  const back = s?.routesBack ?? [];
  return [
    { label: "at step", value: done ? "done" : closed ? `closed${s?.currentStep ? ` at ${s.currentStep}` : ""}` : (s?.currentStep ?? "not started") },
    { label: done ? "took" : closed ? "ran for" : "running for", value: duration(runDuration(w, now)) },
    { label: "waited for owner", value: duration(s?.ownerWaitMs ?? 0) },
    { label: "sent back", value: back.length ? back.map((b) => `${b.from} → ${b.to}`).join(", ") : "never" },
  ];
}

// The figures of one step of a workstream: time working, time waiting for
// the owner, visits, and why it was skipped.
export function stepTiming(
  step: { activeMs: number; ownerWaitMs: number; visits: number; skipReason?: string } | undefined,
  working = "",
): string {
  if (!step) return "";
  return [
    step.activeMs ? `${duration(step.activeMs)}${working}` : "",
    step.ownerWaitMs ? `owner ${duration(step.ownerWaitMs)}` : "",
    step.visits > 1 ? `×${step.visits} visits` : "",
    step.skipReason ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The time of a step's last recorded event, or undefined when it has none.
// StepSummary carries no timestamp of its own, so "last updated" is derived
// from the event log: the latest event whose `.step` is this one.
export function lastStepEventTime(events: { step: string; time: string }[] | undefined, stepId: string): string | undefined {
  return (events ?? [])
    .filter((e) => e.step === stepId)
    .map((e) => e.time)
    .sort()
    .pop();
}

// How long a step may sit IN_PROGRESS with no new event of its own before
// the Summary flags it as possibly stuck. Placeholder: fuse-flow has no
// notion yet of a step actually being stuck, so this is a guess.
export const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

// Whether the Summary flags a step as possibly stuck: it is IN_PROGRESS and
// its own last event is older than STALE_AFTER_MS. A step with a workflow
// gate (`delegates`) is never flagged: it stays IN_PROGRESS while its child
// workstream does the work, and the child's events are the child's, so its
// own silence says nothing. The child's row flags the child if it stalls.
export function stepStale(step: { status?: string; lastUpdated?: string; delegates: boolean }, now = Date.now()): boolean {
  if (step.delegates || step.status !== "IN_PROGRESS" || !step.lastUpdated) return false;
  const t = Date.parse(step.lastUpdated);
  return !Number.isNaN(t) && now - t > STALE_AFTER_MS;
}

// The events split by the Summary row that lists them, in log order: each
// row id (a shown step or a step only the state records) gets the events of
// that step, and `other` gets the events that match no row, as when the
// workflow cannot be read. Every event lands exactly once, so no history is
// hidden by a renamed or removed step.
export function eventsByRow<E extends { step: string }>(events: E[] | undefined, rowIds: string[]): { rows: Record<string, E[]>; other: E[] } {
  const rows: Record<string, E[]> = Object.fromEntries(rowIds.map((id) => [id, []]));
  const other: E[] = [];
  for (const event of events ?? []) (Object.hasOwn(rows, event.step) ? rows[event.step] : other).push(event);
  return { rows, other };
}

// The steps a step was sent back to from, in the order it happened.
export function sentBackFrom(w: WorkstreamSummary, stepId: string): string[] {
  return [...new Set((w.summary?.routesBack ?? []).filter((b) => b.from === stepId).map((b) => b.to))];
}

// The step's current pass, as its state records it, or undefined; fuse-flow
// reads none as the first.
function recordedPass(w: WorkstreamSummary, stepId: string): number | undefined {
  const pass = (w.steps?.[stepId] as { pass?: unknown } | undefined)?.pass;
  return typeof pass === "number" ? pass : undefined;
}

// The child of the step's current pass, as fuse-flow names it: the one its
// state records, else the gate's slug template (`firstPass`, filled in)
// with -<pass> from the second pass on.
export function currentChildSlug(w: WorkstreamSummary, stepId: string, firstPass: string): string {
  const pass = recordedPass(w, stepId) ?? 1;
  const recorded = (w.children ?? []).find((c) => c.step === stepId && c.pass === pass);
  return recorded?.slug ?? (pass > 1 ? `${firstPass}-${pass}` : firstPass);
}

// A step's child workstreams as fuse-flow status lists them: while the step
// is handed out, the children of its current pass are what it waits for (all
// of them under a for_each gate) and the rest are earlier passes; otherwise
// every child is listed. `firstPass` is the gate's slug template filled in,
// or undefined when the step has no workflow gate. Null when nothing to list.
export function stepChildren(
  w: WorkstreamSummary,
  stepId: string,
  firstPass?: string,
): { waitsFor?: string[]; others: string[] } | null {
  const own = (w.children ?? []).filter((c) => c.step === stepId).sort((a, b) => a.pass - b.pass);
  const state = runState(w.summary?.steps?.[stepId]?.status);
  const handedOut = state === "IN_PROGRESS" || state === "AWAITING_OWNER" || state === "BLOCKED";
  let waitsFor: string[] | undefined;
  if (firstPass !== undefined && handedOut) {
    const pass = recordedPass(w, stepId) ?? 1;
    const current = own.filter((c) => c.pass === pass);
    waitsFor = current.some((c) => c.item !== undefined) ? current.map((c) => c.slug) : [currentChildSlug(w, stepId, firstPass)];
  }
  const others = [...new Set(own.map((c) => c.slug))].filter((slug) => !waitsFor?.includes(slug));
  return waitsFor || others.length ? { ...(waitsFor ? { waitsFor } : {}), others } : null;
}
