// SPDX-License-Identifier: Apache-2.0
// How workstreams relate. Each workstream stays one flat list of steps; two
// kinds of reference connect them. A hand-off: a workstream started with
// `--after <slug>` takes its inputs from that earlier workstream. A
// delegation: a step with a workflow gate creates a child workstream and
// waits for it, and later steps read the documents the child returns.

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { FlowError } from "./errors.ts";
import { has, own } from "./own.ts";
import { artifactPath, loadProject } from "./policy.ts";
import { findWorkflow } from "./project.ts";
import { DEFAULT_CHILD_SLUG } from "./schemas/gate.ts";
import { type Gate, loadWorkflow, type Step, type Workflow } from "./workflow.ts";
import { listWorkstreams, readWorkstream, startedOn, stateOf, type Workstream, workstreamExists } from "./workstream.ts";

const finished = (status: string) => status === "COMPLETED" || status === "SKIPPED";

// The current step: the first that is neither COMPLETED nor SKIPPED.
export function firstUnfinished(wf: Workflow, ws: Workstream): Step | undefined {
  return wf.steps.find((step) => !finished(stateOf(ws, step.id).status));
}

// The step's workflow gate; a step has at most one.
export const childGate = (step: Step): Gate | undefined => step.gates.find((g) => g.kind === "workflow");

// The child's slug for one pass of the step: the gate's template with the
// parent's slug and the step id filled in, and -<pass> from the second pass on.
export function childSlug(gate: Gate, parent: string, step: string, pass: number): string {
  const base = (gate.slug ?? DEFAULT_CHILD_SLUG).replaceAll("{slug}", parent).replaceAll("{step}", step);
  return pass > 1 ? `${base}-${pass}` : base;
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
      return `is at ${at}, which awaits the owner: ${step.gates.filter((g) => g.kind === "owner-action").map((g) => g.text).join(", and ")}`;
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
      if (declared) return artifactPath(loadProject(root), declared, slug, startedOn(ws));
      return records[0].path;
    }
    // A returned id stops the search here: the newest child decides, even
    // when it recorded nothing, so an older document of that id never stands in.
    if (returned !== undefined) {
      const child = state.children?.at(-1)?.slug;
      return child ? documentOf(root, child, returned, undefined, seen) : undefined;
    }
  }
  return own(ws.inputs, id);
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
// workflow's documents is only a warning.
export function crossCheck(root: string, file: string, wf: Workflow): { errors: string[]; warnings: string[] } {
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
  const ours = documentsOf(wf);
  for (const handOff of wf.hands_off_to) {
    const target = load(handOff.workflow);
    if (typeof target === "string") {
      errors.push(`hands_off_to ${handOff.workflow}: ${target}`);
      continue;
    }
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
