// SPDX-License-Identifier: Apache-2.0
// A workflow gate's delegation, as Komposer shows and edits it: whether it
// hands out one child or one per item of a folder, what its pickers may
// offer, and the settings each inspector control writes. No React here, so
// every decision the inspector and the diagrams make is testable.

import { DEFAULT_CHILD_SLUG, DEFAULT_CHILD_SLUG_PER_ITEM, type Gate } from "../../../flow/src/schemas/gate.ts";
import type { GateFields } from "./yamlEdit.ts";
import { workflowKey, type OpenWorkflow, type StepView, type WorkflowLink } from "../workflowView.ts";

export const isPerItem = (gate: Gate): boolean => gate.kind === "workflow" && !!gate.for_each;

export const forEachChip = (gate: Gate): string | null => (isPerItem(gate) ? `for-each ${gate.for_each}` : null);

export function iteratedArtifact(step: StepView): string | null {
  const gate = step.gates.find((g) => g.kind === "workflow");
  return gate && isPerItem(gate) ? gate.for_each! : null;
}

export const defaultChildSlug = (gate: Gate): string => (isPerItem(gate) ? DEFAULT_CHILD_SLUG_PER_ITEM : DEFAULT_CHILD_SLUG);

export const childSlugFor = (gate: Gate, stepId: string, parent?: string): string => {
  const withStep = (gate.slug ?? defaultChildSlug(gate)).replaceAll("{step}", stepId);
  return parent ? withStep.replaceAll("{slug}", parent) : withStep;
};

// Routes and the child slug side by side: a gate can have both.
export function compareGateExtra(gate: Gate, stepId: string): string {
  const parts: string[] = [];
  if (gate.kind === "workflow") {
    const chip = forEachChip(gate);
    if (chip) parts.push(chip);
    parts.push(`↳ ${childSlugFor(gate, stepId)}`);
    // The settings the gate writes, so two gates that differ only in them read differently.
    if (gate.accept !== undefined) parts.push(`accept ${gate.accept}`);
    if (gate.rerun !== undefined) parts.push(`rerun ${gate.rerun}`);
    if (gate.rerun_override !== undefined) parts.push(`rerun_override ${gate.rerun_override}`);
    if (gate.retries !== undefined) parts.push(`retries ${gate.retries}`);
  }
  if (gate.route_back_to.length) parts.push(`↩ ${gate.route_back_to.join(", ")}`);
  return parts.join(" · ");
}

// Replays writers in the engine's order, as the nearest writer decides whether an id is per-item,
// which the engine refuses in both pickers; a for_each gate's own returns are retry bindings, so
// inputs only, and a plain gate has none.
export function gateArtifacts(workflowInputs: string[], steps: StepView[], index: number): { forEach: string[]; inputs: string[] } {
  const known = new Set<string>(workflowInputs);
  const perItem = new Set<string>();
  for (const s of steps.slice(0, index)) {
    for (const a of s.artifacts) {
      known.add(a.artifact);
      perItem.delete(a.artifact);
    }
    for (const g of s.gates.filter((g) => g.kind === "workflow")) {
      for (const id of Object.keys(g.returns ?? {})) {
        known.add(id);
        if (isPerItem(g)) perItem.add(id);
        else perItem.delete(id);
      }
    }
  }
  const forEach = [...known].filter((id) => !perItem.has(id));
  const gate = steps[index]?.gates.find((g) => g.kind === "workflow");
  const own = gate && isPerItem(gate) ? Object.keys(gate.returns ?? {}).filter((id) => !known.has(id)) : [];
  return { forEach, inputs: [...forEach, ...own] };
}

export function childInputsOf(link: WorkflowLink, workflows: OpenWorkflow[]): string[] | null {
  if (!link.ok) return null;
  const child = workflows.find((w) => workflowKey(w) === link.key);
  return child?.parsed ? child.parsed.inputs.map((i) => i.artifact) : null;
}

// --- Switching between one child and one per item ---------------------------

// The folder is bound only when one child input is unbound: with more, which one is the owner's call.
export function perItemFields(gate: Gate, folder: string, childInputs: string[] | null): { fields: GateFields; needsBinding: boolean } {
  const fields: GateFields = { for_each: folder };
  if (gate.slug !== undefined && !gate.slug.includes("{item}")) fields.slug = `${gate.slug}-{item}`;
  const entries = Object.entries(gate.inputs ?? {});
  if (entries.some(([, artifact]) => artifact === folder)) return { fields, needsBinding: false };
  const unbound = (childInputs ?? []).filter((name) => !entries.some(([bound]) => bound === name));
  if (childInputs && unbound.length === 1) return { fields: { ...fields, inputs: [...entries, [unbound[0], folder]] }, needsBinding: false };
  return { fields, needsBinding: true };
}

// A slug with {item} is removed, not edited: the default is valid whatever the template's shape.
export function oneChildFields(gate: Gate): GateFields {
  // All four are cleared even when absent from the gate: a malformed one is hidden from it but still in the file.
  const fields: GateFields = { for_each: null, rerun: null, rerun_override: null, retries: null };
  if (gate.slug?.includes("{item}")) fields.slug = null;
  return fields;
}

// Re-running every item also clears retries, whose control it disables.
export function rerunFields(value: "all" | "failed", gate: Gate): GateFields {
  return value === "all" && gate.retries !== undefined ? { rerun: value, retries: null } : { rerun: value };
}

// --- The inputs rows --------------------------------------------------------

// Rows the YAML cannot hold yet (no name, no artifact, a refused rename) live here until they can.
// A row read from the file keeps its saved pair, which is written in its place until it is valid.
export interface InputRow {
  name: string;
  artifact: string;
  error?: string;
  saved?: [string, string];
}
export interface InputsDraft {
  owner: string;
  source: string;
  gate: string;
  rows: InputRow[];
  pendingPerItem: boolean;
}
export interface DraftChange {
  draft: InputsDraft;
  fields: GateFields | null;
}

const DUPLICATE = "already bound in another row";
const written = (row: InputRow) => !!row.name && !!row.artifact && !row.error;
const inFile = (row: InputRow): [string, string] | undefined => (written(row) ? [row.name, row.artifact] : row.saved);

// Unwritten rows survive only while the file's inputs are unchanged and the draft is this gate's,
// so neither an edit made elsewhere nor another step's gate is overlaid with stale rows.
export const draftOwner = (stepIndex: number, stepId: string, gateIndex: number): string => `${stepIndex}/${stepId}/${gateIndex}`;
export function draftFor(gate: Gate, previous: InputsDraft | undefined, owner = ""): InputsDraft {
  const source = JSON.stringify(gate.inputs ?? {});
  const key = JSON.stringify(gate);
  if (previous && previous.owner === owner && previous.source === source) {
    return previous.gate === key ? previous : { ...previous, gate: key, pendingPerItem: false };
  }
  const rows = Object.entries(gate.inputs ?? {}).map(([name, artifact]): InputRow => ({ name, artifact, saved: [name, artifact] }));
  return { owner, source, gate: key, rows, pendingPerItem: false };
}

function change(draft: InputsDraft, rows: InputRow[], writes: boolean): DraftChange {
  const next = { ...draft, rows };
  if (!writes) return { draft: next, fields: null };
  const pairs = rows.map(inFile).filter((pair): pair is [string, string] => !!pair);
  return { draft: next, fields: { inputs: pairs.length ? pairs : null } };
}

export function addRow(draft: InputsDraft): DraftChange {
  return change(draft, [...draft.rows, { name: "", artifact: "" }], false);
}

// A name is taken while another row uses it, or still holds it in the file.
export function renameRow(draft: InputsDraft, index: number, name: string): DraftChange {
  const taken = name !== "" && draft.rows.some((r, i) => i !== index && (r.name === name || r.saved?.[0] === name));
  const current = draft.rows[index];
  const row: InputRow = { name, artifact: current.artifact, ...(current.saved ? { saved: current.saved } : {}), ...(taken ? { error: DUPLICATE } : {}) };
  const rows = draft.rows.map((r, i) => (i === index ? row : r));
  return change(draft, rows, written(row));
}

export function rebindRow(draft: InputsDraft, index: number, artifact: string): DraftChange {
  const row = { ...draft.rows[index], artifact };
  const rows = draft.rows.map((r, i) => (i === index ? row : r));
  return change(draft, rows, written(row));
}

export function removeRow(draft: InputsDraft, index: number): DraftChange {
  const wasInFile = !!inFile(draft.rows[index]);
  return change(draft, draft.rows.filter((_, i) => i !== index), wasInFile);
}

// --- What the inspector shows -----------------------------------------------

export interface PickerOption {
  id: string;
  available: boolean;
}
export interface DelegationView {
  perItem: boolean;
  perItemDisabled: boolean;
  needsBinding: boolean;
  retriesEnabled: boolean;
  rows: (InputRow & { itemFile: boolean; options: PickerOption[] })[];
  suggestions: string[];
  forEachOptions: PickerOption[];
}

// The options of a picker: the ids it may offer, then any value the file
// already has that it may not, kept so the engine's error on it shows.
function picker(offered: string[], present: (string | undefined)[]): PickerOption[] {
  const out = offered.map((id) => ({ id, available: true }));
  for (const id of present) if (id && !offered.includes(id) && !out.some((o) => o.id === id)) out.push({ id, available: false });
  return out;
}

export function delegationView(
  gate: Gate,
  draft: InputsDraft,
  childInputs: string[] | null,
  options: { forEach: string[]; inputs: string[] },
): DelegationView {
  const each = isPerItem(gate);
  return {
    perItem: each || draft.pendingPerItem,
    perItemDisabled: !each && options.forEach.length === 0,
    needsBinding: each && !Object.values(gate.inputs ?? {}).includes(gate.for_each!),
    retriesEnabled: gate.rerun === "failed",
    // Each row offers its own unavailable value only, so a sibling cannot pick it up.
    rows: draft.rows.map((r) => ({ ...r, itemFile: each && r.artifact === gate.for_each, options: picker(options.inputs, [r.artifact]) })),
    suggestions: childInputs ?? [],
    forEachOptions: picker(options.forEach, [gate.for_each]),
  };
}
