// SPDX-License-Identifier: Apache-2.0
// Compare mode: how each step of two workflows compares with the other side,
// matched by step id, and the counts shown above each diagram.

import { artifactCount, routeBackCount, type StepView } from "../workflowView.ts";
import type { Edit } from "./yamlEdit.ts";

export type CompareStatus = "same" | "changed" | "only-here";

export interface StepCompare {
  id: string;
  status: CompareStatus;
  // For a changed step, the fields that differ, in the order of COMPARED_FIELDS.
  fields: string[];
}

export type GateKind = "owner-action" | "agent" | "check" | "script" | "workflow";

export interface CompareCounts {
  steps: number;
  artifacts: number;
  routesBack: number;
  gates: Record<GateKind, number>;
}

export interface CompareResult {
  left: StepCompare[];
  right: StepCompare[];
  leftCounts: CompareCounts;
  rightCounts: CompareCounts;
}

const COMPARED_FIELDS = [
  "title",
  "phase",
  "description",
  "instruction",
  "condition",
  "consumes",
  "artifacts",
  "gates",
] as const satisfies readonly (keyof StepView)[];

// JSON with object keys sorted, so two equal values serialize equally
// whatever order their keys were written in.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

// Trailing whitespace of a text does not change what the step says, and the
// YAML block style alone decides whether there is a final newline.
const normal = (value: unknown) => (typeof value === "string" ? value.trimEnd() : value);

function differingFields(a: StepView, b: StepView): string[] {
  return COMPARED_FIELDS.filter((field) => canonical(normal(a[field])) !== canonical(normal(b[field])));
}

function side(own: StepView[], other: StepView[]): StepCompare[] {
  return own.map((step) => {
    const match = other.find((s) => s.id === step.id);
    if (!match) return { id: step.id, status: "only-here", fields: [] };
    const fields = differingFields(step, match);
    return { id: step.id, status: fields.length ? "changed" : "same", fields };
  });
}

export function compareCounts(steps: StepView[]): CompareCounts {
  const gates: Record<GateKind, number> = { "owner-action": 0, agent: 0, check: 0, script: 0, workflow: 0 };
  for (const step of steps) for (const gate of step.gates) gates[gate.kind]++;
  return { steps: steps.length, artifacts: artifactCount(steps), routesBack: routeBackCount(steps), gates };
}

export function compareWorkflows(left: StepView[], right: StepView[]): CompareResult {
  return {
    left: side(left, right),
    right: side(right, left),
    leftCounts: compareCounts(left),
    rightCounts: compareCounts(right),
  };
}

// The workflows the pickers start on: the left on the workflow open in edit
// mode, the right on the first other one in list order. With one workflow,
// both sides show it.
export function defaultComparePair(keys: string[], openKey: string | null): [string | null, string | null] {
  if (keys.length === 0) return [null, null];
  const left = openKey && keys.includes(openKey) ? openKey : keys[0];
  const right = keys.find((k) => k !== left) ?? left;
  return [left, right];
}

export function swapPair<T>(pair: [T, T]): [T, T] {
  return [pair[1], pair[0]];
}

// Where a step copied into `target` goes: in place of the target's step with
// the same id, or else right after the nearest earlier source step that the
// target also has, or first when there is none.
function copyPosition(source: StepView[], index: number, target: StepView[]): { at: number; replaces: boolean } {
  const same = target.findIndex((s) => s.id === source[index].id);
  if (same >= 0) return { at: same, replaces: true };
  for (let i = index - 1; i >= 0; i--) {
    const shared = target.findIndex((s) => s.id === source[i].id);
    if (shared >= 0) return { at: shared + 1, replaces: false };
  }
  return { at: 0, replaces: false };
}

// The edits that make the target workflow's step with this id equal to
// source[index], applied in order with applyEdit. Every other step of the
// target, and the file's comments, are left as they are.
export function copyStepEdits(source: StepView[], index: number, target: StepView[]): Edit[] {
  const step = source[index];
  // The structured edits cannot write a workflow gate's slug, inputs or
  // returns, so such a step is refused rather than copied without them.
  if (step.gates.some((g) => g.kind === "workflow" && (g.slug !== undefined || g.inputs || g.returns)))
    throw new Error(`Step ${step.id} has a workflow gate with a slug, inputs or returns; copy it in edit mode instead.`);
  const { at, replaces } = copyPosition(source, index, target);
  const instruction = step.instruction ?? "";
  // A folded instruction would rewrap line breaks inside the text; keep them literal.
  const style = instruction.trimEnd().includes("\n") ? "|" : ">";
  const edits: Edit[] = [];
  if (replaces) edits.push({ op: "deleteStep", index: at });
  edits.push({ op: "insertStep", at, step: { id: step.id, instruction: "" } });
  edits.push({ op: "setInstruction", step: at, text: instruction, style });
  for (const key of ["title", "phase", "description"] as const)
    if (step[key] !== undefined) edits.push({ op: "setStepField", step: at, key, value: step[key]! });
  if (step.condition) edits.push({ op: "setCondition", step: at, condition: step.condition });
  if (step.consumes.length) edits.push({ op: "setConsumes", step: at, ids: step.consumes });
  for (const a of step.artifacts)
    edits.push({
      op: "addOutput",
      step: at,
      mode: a.role,
      artifact: a.artifact,
      path: a.path,
      ...(a.description !== undefined ? { description: a.description } : {}),
    });
  step.gates.forEach((gate, g) => {
    edits.push({ op: "addGate", step: at, gate: { kind: gate.kind, text: gate.text } });
    const fields = {
      ...(gate.description !== undefined ? { description: gate.description } : {}),
      ...(gate.max_rounds !== undefined ? { max_rounds: gate.max_rounds } : {}),
      ...(gate.guide !== undefined ? { guide: gate.guide } : {}),
      ...(gate.route_back_to.length ? { route_back_to: gate.route_back_to } : {}),
    };
    if (Object.keys(fields).length) edits.push({ op: "setGate", step: at, index: g, fields });
  });
  return edits;
}
