// SPDX-License-Identifier: Apache-2.0
// How workstreams relate. Each workstream stays one flat list of steps; two
// kinds of reference connect them. A hand-off: a workstream started with
// `--after <slug>` takes its inputs from that earlier workstream. A
// delegation: a step with a workflow gate creates a child workstream and
// waits for it, and later steps read the documents the child returns.

import { type Dirent, existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";
import { FlowError } from "./errors.ts";
import { has, own } from "./own.ts";
import { artifactPath, loadProject, reviewGuideProblems } from "./policy.ts";
import { findWorkflow } from "./project.ts";
import { DEFAULT_CHILD_SLUG, DEFAULT_CHILD_SLUG_PER_ITEM } from "./schemas/gate.ts";
import { type Gate, loadWorkflow, type Step, type Workflow } from "./workflow.ts";
import { listWorkstreams, readWorkstream, startedOn, stateOf, type StepState, type Workstream, workstreamExists } from "./workstream.ts";

const finished = (status: string) => status === "COMPLETED" || status === "SKIPPED";

// The current step: the first that is neither COMPLETED nor SKIPPED.
export function firstUnfinished(wf: Workflow, ws: Workstream): Step | undefined {
  return wf.steps.find((step) => !finished(stateOf(ws, step.id).status));
}

// The step's workflow gate; a step has at most one.
export const childGate = (step: Step): Gate | undefined => step.gates.find((g) => g.kind === "workflow");

// The child's slug for one pass of the step: the gate's template with the
// parent's slug, the step id and, for a for_each gate, the item filled in,
// and -<pass> from the second pass on.
export function childSlug(gate: Gate, parent: string, step: string, pass: number, item?: string): string {
  const template = gate.slug ?? (gate.for_each !== undefined ? DEFAULT_CHILD_SLUG_PER_ITEM : DEFAULT_CHILD_SLUG);
  const base = template.replaceAll("{slug}", parent).replaceAll("{step}", step).replaceAll("{item}", item ?? "{item}");
  return pass > 1 ? `${base}-${pass}` : base;
}

// One item of a for_each gate: the file's name without its extension, and
// the file itself, relative to the repository root.
export type Item = { item: string; file: string };

const ITEM_ID = /^[a-z0-9][a-z0-9-]*$/;
const hidden = (name: string) => name.startsWith(".");
const stemOf = (name: string) => name.replace(/\.[^.]*$/, "");

// The items of a for_each gate: the folder's direct, non-hidden files, as
// the producing step recorded them, else listed. Only names are read, never
// content, and every refusal is a FlowError the step block can print.
export function itemsOf(root: string, parentSlug: string, step: Step, gate: Gate): Item[] {
  const id = gate.for_each!;
  const refuse = (why: string) => new FlowError(`step ${step.id} cannot create its child workstreams: ${why}`);
  let folder = documentOf(root, parentSlug, id, step.id);
  if (folder === undefined) throw refuse(`${id} was not recorded by an earlier step or given as an input`);
  const records = recordsOf(root, parentSlug, id, step.id);
  const fileRecords = records.length > 0 && records.every((r) => !r.endsWith("/"));
  // Files recorded one by one stand for their folder, also when there is one
  // of them, where documentOf names the file itself.
  if (fileRecords) folder = recordedFolder(records.map((path) => ({ path })), folder.endsWith("/") ? folder : "");
  const dir = folder.replace(/\/+$/, "");
  const direct = (p: string) => posix.dirname(p) === (dir === "" ? "." : dir);
  let files: string[];
  if (fileRecords) {
    files = records.filter((r) => direct(r) && !hidden(posix.basename(r)));
  } else {
    const full = resolve(root, dir);
    let entries: Dirent[];
    try {
      if (statSync(full).isFile()) throw refuse(`${folder} is a file, not a folder`);
      entries = readdirSync(full, { withFileTypes: true });
    } catch (e) {
      if (e instanceof FlowError) throw e;
      throw refuse(`${folder} cannot be read: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
    }
    files = entries
      .filter((d) => d.isFile() && !hidden(d.name))
      .map((d) => posix.join(dir, d.name))
      .sort();
  }
  if (!files.length) throw refuse(`${folder} holds no item: no file to make a child for`);
  const items = new Map<string, string>();
  for (const file of files) {
    const stem = stemOf(posix.basename(file));
    if (!ITEM_ID.test(stem)) {
      throw refuse(`${file}: its name without the extension, ${JSON.stringify(stem)}, is not an item id (lowercase letters, digits and hyphens); rename the file`);
    }
    const other = items.get(stem);
    if (other !== undefined) throw refuse(`${other} and ${file} give the same item ${stem}; one file per item`);
    items.set(stem, file);
  }
  return [...items.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([item, file]) => ({ item, file }));
}

// The paths recorded for the document `id`, by the same search as documentOf:
// the latest step before `before` that recorded it, following a returned id
// into the child that returned it; none for an input.
function recordsOf(root: string, slug: string, id: string, before?: string, seen = new Set<string>()): string[] {
  if (seen.has(slug) || !workstreamExists(root, slug)) return [];
  seen.add(slug);
  const ws = readWorkstream(root, slug);
  const wf = workflowOf(root, ws);
  const end = before === undefined ? wf.steps.length : wf.steps.findIndex((s) => s.id === before);
  for (const step of wf.steps.slice(0, end < 0 ? wf.steps.length : end).reverse()) {
    const state = stateOf(ws, step.id);
    const returned = own(childGate(step)?.returns, id);
    if (state.status !== "COMPLETED" && state.status !== "AWAITING_OWNER") {
      if (returned !== undefined) return [];
      continue;
    }
    const records = state.artifacts.filter((a) => a.artifact === id).map((a) => a.path);
    if (records.length) return records;
    if (returned !== undefined) {
      const child = childGate(step)!.for_each === undefined ? state.children?.at(-1)?.slug : undefined;
      return child ? recordsOf(root, child, returned, undefined, seen) : [];
    }
  }
  return [];
}

const workflowOf = (root: string, ws: Workstream) => loadWorkflow(findWorkflow(root, ws.workflow));

// The real path of the file a workflow reference resolves to, to compare two
// references.
export function workflowFile(root: string, ref: string): string {
  const path = resolve(root, findWorkflow(root, ref));
  return existsSync(path) ? realpathSync(path) : path;
}

export function isComplete(root: string, slug: string): boolean {
  if (!workstreamExists(root, slug)) return false;
  const ws = readWorkstream(root, slug);
  return firstUnfinished(workflowOf(root, ws), ws) === undefined;
}

// Where a workstream stands, in words, for the step that waits for it.
export function whereIs(root: string, slug: string): string {
  if (!workstreamExists(root, slug)) return "does not exist";
  const ws = readWorkstream(root, slug);
  const wf = workflowOf(root, ws);
  const step = firstUnfinished(wf, ws);
  if (!step) return "is complete";
  const state = stateOf(ws, step.id);
  const at = `step ${step.id} (${wf.steps.indexOf(step) + 1} of ${wf.steps.length})`;
  switch (state.status) {
    case "AWAITING_OWNER":
      return `is at ${at}, which awaits the owner: ${step.gates.filter((g) => g.kind === "owner-action").map((g) => g.text).join(", and ") || "approve the step's work"}`;
    case "BLOCKED": {
      const why = state.history.findLast((h) => h.includes("blocked"))?.replace(/^\S+ blocked by the agent: /, "") ?? "no reason recorded";
      return `is at ${at}, which is blocked: ${why}`;
    }
    case "PENDING":
      return state.history.length || Object.values(ws.steps).some((s) => s.history.length) ? `is at ${at}, not handed out yet` : "has not been started";
    default:
      return `is at ${at}, ${state.status}`;
  }
}

// Whether nothing has happened in the workstream since it was created.
export const untouched = (ws: Workstream) => Object.values(ws.steps).every((s) => s.history.length === 0);

// Why the parent step that delegated to workstream `slug` no longer waits for
// it, or undefined while it does: the owner skipped or completed the step, or
// sent the work back, so that the step's new pass waits for another child.
export function parentGone(root: string, slug: string, parent: { slug: string; step: string }): string | undefined {
  if (!workstreamExists(root, parent.slug)) return `workstream ${parent.slug} does not exist`;
  let ws: Workstream;
  let wf: Workflow;
  try {
    ws = readWorkstream(root, parent.slug);
    wf = workflowOf(root, ws);
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    return `workstream ${parent.slug} cannot be read: ${e.message.split("\n")[0]}`;
  }
  const step = wf.steps.find((s) => s.id === parent.step);
  const gate = step && childGate(step);
  if (!step || !gate) return `workflow ${wf.name} no longer has a step ${parent.step} that delegates to a workstream`;
  const state = stateOf(ws, step.id);
  if (state.status === "SKIPPED") return `step ${step.id} was skipped (${state.skip_reason ?? "no reason recorded"})`;
  if (state.status === "COMPLETED") return `step ${step.id} is complete`;
  const pass = state.pass ?? 1;
  const entries = (state.children ?? []).filter((ch) => ch.pass === pass);
  const recorded = entries.map((ch) => ch.slug);
  // Children recorded for a gate of the other shape are held, not replaced,
  // until the owner sends the work back; no child of the pass is "current".
  const perItem = entries.some((ch) => ch.item !== undefined);
  if (entries.length && perItem !== (gate.for_each !== undefined)) {
    return `the gate of step ${step.id} was edited to wait for ${perItem ? "one child" : "one child per item"}, so the children recorded for its pass cannot be used until the owner sends the work back to it`;
  }
  if (gate.for_each !== undefined) {
    // The set is recorded before any child is created, so a child that is not
    // in it belongs to an earlier pass.
    if (recorded.includes(slug)) return undefined;
    return recorded.length
      ? `the owner sent the work back, and the step's new pass waits for workstreams ${recorded.join(", ")}`
      : "the owner sent the work back, and the step's new pass waits for a new set of child workstreams, recorded when the step is handed out";
  }
  const current = recorded[0] ?? childSlug(gate, parent.slug, step.id, pass);
  return current === slug ? undefined : `the owner sent the work back, and the step's new pass waits for workstream ${current}`;
}

// The children of the newest pass of a step, the ones it waits for or waited for.
export function newestChildren(state: StepState): { slug: string; item?: string; file?: string }[] {
  const children = state.children ?? [];
  const newest = Math.max(0, ...children.map((ch) => ch.pass));
  return children.filter((ch) => ch.pass === newest);
}

// The folder that holds the files a step recorded for one artifact: the
// declared path while every record lies at or below it, else the folder
// the records have in common, as when an edit of the workflow moved the
// artifact after the step wrote it. Records are relative to the repository
// root, so with no deeper folder in common that folder is the root, ".".
export function recordedFolder(records: { path: string }[], declared: string): string {
  const dir = (p: string) => p.replace(/\/+$/, "");
  const inside = (p: string) => p === declared || dir(p) === dir(declared) || p.startsWith(`${dir(declared)}/`);
  if (records.every((r) => inside(r.path))) return declared;
  const folders = records.map((r) => (r.path.endsWith("/") ? dir(r.path) : posix.dirname(r.path)).split("/"));
  const common: string[] = [];
  for (let i = 0; folders.every((f) => f[i] !== undefined && f[i] !== "" && f[i] !== "." && f[i] === folders[0][i]); i++) common.push(folders[0][i]);
  return common.length ? `${common.join("/")}/` : ".";
}

// The path of the workstream's document `id`: the latest step, before `before`
// when it is given, that recorded it or returned it from its child, or else
// the input bound under that id. A step counts once its work is recorded.
export function documentOf(root: string, slug: string, id: string, before?: string, seen = new Set<string>()): string | undefined {
  if (seen.has(slug) || !workstreamExists(root, slug)) return undefined;
  seen.add(slug);
  const ws = readWorkstream(root, slug);
  const wf = workflowOf(root, ws);
  const end = before === undefined ? wf.steps.length : wf.steps.findIndex((s) => s.id === before);
  for (const step of wf.steps.slice(0, end < 0 ? wf.steps.length : end).reverse()) {
    const state = stateOf(ws, step.id);
    const returned = own(childGate(step)?.returns, id);
    if (state.status !== "COMPLETED" && state.status !== "AWAITING_OWNER") {
      // A delegating step that was skipped or has not finished has returned
      // nothing, and an older document of that id does not stand in, as the
      // step block says.
      if (returned !== undefined) return undefined;
      continue;
    }
    const records = state.artifacts.filter((a) => a.artifact === id);
    if (records.length === 1) return records[0].path;
    if (records.length > 1) {
      // A folder recorded file by file stands for the folder.
      const declared = [...step.produces, ...step.optional_produces, ...step.updates].find((a) => a.artifact === id);
      return recordedFolder(records, declared ? artifactPath(loadProject(root), declared, slug, startedOn(ws)) : records[0].path);
    }
    // A returned id stops the search here: the newest child decides, even
    // when it recorded nothing, so an older document of that id never stands in.
    // A for_each gate returns one document per item, which is not one path.
    if (returned !== undefined) {
      if (childGate(step)!.for_each !== undefined) return undefined;
      const child = state.children?.at(-1)?.slug;
      return child ? documentOf(root, child, returned, undefined, seen) : undefined;
    }
  }
  return own(ws.inputs, id);
}

// What each child of a for_each step's newest pass returned under the
// child's id `childId`: the path once the child is complete and recorded
// it; `complete` says whether it is.
export function returnedDocuments(root: string, state: StepState, childId: string): { slug: string; item?: string; complete: boolean; path?: string }[] {
  return newestChildren(state).map(({ slug, item }) => {
    const complete = isComplete(root, slug);
    const path = complete ? documentOf(root, slug, childId) : undefined;
    return { slug, ...(item !== undefined ? { item } : {}), complete, ...(path !== undefined ? { path } : {}) };
  });
}

// The workstreams in the chain of parents above `slug`, `slug` first.
function parentChain(root: string, slug: string): Workstream[] {
  const chain: Workstream[] = [];
  const seen = new Set<string>();
  for (let at: string | undefined = slug; at && !seen.has(at) && workstreamExists(root, at); ) {
    seen.add(at);
    const ws = readWorkstream(root, at);
    chain.push(ws);
    at = ws.parent?.slug;
  }
  return chain;
}

// Refuses a child that would follow a workflow its chain of parents already
// follows: the workflows would wait for each other without end.
export function refuseCycle(root: string, parent: string, ref: string): void {
  const target = workflowFile(root, ref);
  const chain = parentChain(root, parent);
  const looping = chain.find((ws) => workflowFile(root, ws.workflow) === target);
  if (looping) {
    const names = chain.map((ws) => ws.workflow).reverse();
    throw new FlowError(`a child following ${ref} would wait for itself: the chain of parents ${names.join(" -> ")} already follows it`);
  }
}

export interface Links {
  after?: string;
  startedAfter: string[];
  parent?: { slug: string; step: string };
}

// Who this workstream came from, and what was started after it.
export function links(root: string, slug: string, ws: Workstream): Links {
  const startedAfter = listWorkstreams(root)
    .filter((w) => w.workstream?.after === slug)
    .map((w) => w.slug);
  return { ...(ws.after ? { after: ws.after } : {}), startedAfter, ...(ws.parent ? { parent: ws.parent } : {}) };
}

// The ids a workflow can hand on: what its steps write or return, and its inputs.
export function documentsOf(wf: Workflow): Set<string> {
  const ids = new Set(wf.inputs.map((i) => i.artifact));
  for (const step of wf.steps) {
    for (const a of [...step.produces, ...step.optional_produces, ...step.updates]) ids.add(a.artifact);
    for (const id of Object.keys(childGate(step)?.returns ?? {})) ids.add(id);
  }
  return ids;
}

// The checks that need the other workflow files: that each hand-off and each
// workflow gate names a workflow that resolves, that a gate's inputs and
// returns match what its child declares, and that no chain of workflow gates
// leads back to this workflow. A hand-off whose target takes none of this
// workflow's documents is only a warning. A child's review guides are checked
// only for the steps `only` keeps, the steps a new workstream will reach.
export function crossCheck(root: string, file: string, wf: Workflow, only: (step: Step) => boolean = () => true): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const load = (ref: string): { wf: Workflow; path: string } | string => {
    try {
      const path = workflowFile(root, ref);
      return { wf: loadWorkflow(path), path };
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      return e.message.split("\n")[0];
    }
  };
  // The review guides of a workflow this one starts, as they apply in this
  // project: the new workstream could not start without them.
  const guides = (at: string, target: { wf: Workflow; path: string }) => {
    for (const problem of reviewGuideProblems(loadProject(root), target.wf, target.path)) errors.push(`${at}: ${problem}`);
  };
  const ours = documentsOf(wf);
  for (const handOff of wf.hands_off_to) {
    const target = load(handOff.workflow);
    if (typeof target === "string") {
      errors.push(`hands_off_to ${handOff.workflow}: ${target}`);
      continue;
    }
    guides(`hands_off_to ${handOff.workflow}`, target);
    if (!target.wf.inputs.some((i) => ours.has(i.artifact))) {
      warnings.push(`hands_off_to ${handOff.workflow}: it declares no input this workflow produces, so --after gives it nothing`);
    }
  }
  const self = existsSync(file) ? realpathSync(file) : file;
  for (const step of wf.steps) {
    const gate = childGate(step);
    if (!gate) continue;
    const target = load(gate.text);
    const at = `step ${step.id}, workflow ${gate.text}`;
    if (typeof target === "string") {
      errors.push(`${at}: ${target}`);
      continue;
    }
    if (only(step)) guides(at, target);
    const declared = new Map(target.wf.inputs.map((i) => [i.artifact, i]));
    for (const id of Object.keys(gate.inputs ?? {})) {
      if (!declared.has(id)) errors.push(`${at}: inputs names "${id}", which ${target.wf.name} does not declare as an input`);
    }
    for (const input of target.wf.inputs) {
      if (input.required && !has(gate.inputs, input.artifact)) {
        errors.push(`${at}: ${target.wf.name} requires the input "${input.artifact}", and the gate's inputs do not give it`);
      }
    }
    const theirs = documentsOf(target.wf);
    for (const [ours, childId] of Object.entries(gate.returns ?? {})) {
      if (!theirs.has(childId)) errors.push(`${at}: returns "${ours}" from "${childId}", which ${target.wf.name} neither writes, returns nor takes as an input`);
    }
    // Follow the workflow gates from the child; reaching this file again is a cycle.
    const walk = (path: string, names: string[], seen: Set<string>): string[] | undefined => {
      if (path === self) return names;
      if (seen.has(path)) return undefined;
      seen.add(path);
      const loaded = load(path);
      if (typeof loaded === "string") return undefined;
      for (const s of loaded.wf.steps) {
        const g = childGate(s);
        if (!g) continue;
        const next = load(g.text);
        if (typeof next === "string") continue;
        const found = walk(next.path, [...names, g.text], seen);
        if (found) return found;
      }
      return undefined;
    };
    const cycle = walk(target.path, [wf.name, gate.text], new Set());
    if (cycle) errors.push(`${at}: the workflow gates lead back to this workflow (${cycle.join(" -> ")}), so it would wait for itself`);
  }
  return { errors, warnings };
}
