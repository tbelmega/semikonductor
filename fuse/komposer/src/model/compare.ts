// SPDX-License-Identifier: Apache-2.0
// The Compare page's model: which two workflows it shows, how their steps
// line up (a longest common subsequence over step ids), how a pair of steps
// with the same id differs, element by element, and the edits that apply a
// difference, a whole step, an addition, a removal or a move to the left
// workflow. No React: tested directly.

import type { Gate } from "../../../flow/src/schemas/gate.ts";
import { lcsDiff } from "../diff.ts";
import { readsCompletely, type ArtifactRole, type ArtifactView, type OpenWorkflow, type StepView } from "../workflowView.ts";
import type { Edit } from "./yamlEdit.ts";
import { isWorkflowPath, normalizePath, rebaseRef } from "./workflowLinks.ts";

// --------------------------------------------------------- the two workflows

const LOCATION_ORDER = ["project", "personal", "fuse-flow"] as const;

// The workflows Compare offers, in the lane's order: by location, then by
// path inside it, so a folder's files sort with the names next to it. Other
// projects' files are not offered.
export function compareOrder(workflows: OpenWorkflow[]): OpenWorkflow[] {
  const inLocation = (w: OpenWorkflow) => (w.dir ? `${w.dir}/${w.file}` : w.file);
  return LOCATION_ORDER.flatMap((loc) =>
    workflows.filter((w) => w.location === loc).sort((a, b) => inLocation(a).localeCompare(inLocation(b))),
  );
}

// The workflows the pickers start on: the left on the selected workflow, the
// right on the first other one in list order. With one workflow there is no
// right side: the right never shows the left's workflow.
export function defaultComparePair(keys: string[], openKey: string | null): [string | null, string | null] {
  if (keys.length === 0) return [null, null];
  const left = openKey && keys.includes(openKey) ? openKey : keys[0];
  return [left, keys.find((k) => k !== left) ?? null];
}

// The two workflows the Compare page shows. The left side is always the
// workflow selected for every page; only the right side is the page's own,
// kept while it is listed and differs from the left.
export function comparePair(keys: string[], selected: string | null, right: string | null): [string | null, string | null] {
  const [left, fallback] = defaultComparePair(keys, selected);
  return [left, right !== null && right !== left && keys.includes(right) ? right : fallback];
}

// What a pick on the Compare page changes: the workflow to select for every
// page, which becomes the left side, and the right side to keep. Picking the
// right side's workflow for the left, or for the right the left's, trades them.
export function comparePick(
  [left, right]: [string | null, string | null],
  side: "left" | "right" | "swap",
  key?: string,
): { select: string | null; right: string | null } {
  if (side === "swap" || (side === "left" && key === right) || (side === "right" && key === left)) return { select: right, right: left };
  return side === "left" ? { select: key ?? left, right } : { select: left, right: key ?? right };
}

// ------------------------------------------------------------ one step pair

// JSON with object keys sorted, so two equal values serialize equally
// whatever order their keys were written in.
function canonical(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}

// An instruction as fuse-flow reads it: trimmed, everything inside kept. The
// YAML parser has already folded a folded scalar; the line breaks and
// indentation of a literal one (code, Markdown structure) are part of what
// it says, so they count.
export const normalInstruction = (text: string | undefined) => (text ?? "").trim();

// An output is matched by its mode and artifact, a gate by its kind and text.
export const outputKey = (a: Pick<ArtifactView, "role" | "artifact">) => `${a.role}:${a.artifact}`;
export const gateKey = (g: Pick<Gate, "kind" | "text">) => `${g.kind}:${g.text}`;
// Everything else a gate says.
const gateSettings = (g: Gate) =>
  canonical({
    description: g.description,
    max_rounds: g.max_rounds,
    guide: g.guide,
    route_back_to: g.route_back_to,
    slug: g.slug,
    inputs: g.inputs,
    returns: g.returns,
  });
const conditionValue = (c: StepView["condition"]) => (c ? canonical({ kind: c.kind, text: c.text, description: c.description }) : "");

// ------------------------------------------------- relative references

// The workflow files of the two sides. A gate's review guide, and a workflow
// gate that names its child by a path, are relative to the workflow file
// that names them, as fuse-flow's loadWorkflow reads them; so equal text in
// two folders can name two files, and a copy into another folder has to be
// rewritten to name the same file.
export interface CompareFiles {
  left: string;
  right: string;
}

const folderOf = (file: string) => {
  const slash = file.lastIndexOf("/");
  return slash > 0 ? file.slice(0, slash) : slash === 0 ? "/" : ".";
};
const relativeRef = (ref: string) => !ref.startsWith("/");
// The file a reference written in workflow file `file` names, as one
// normalized absolute path, however it is spelled.
const resolveFrom = (ref: string, file: string) => normalizePath(relativeRef(ref) ? `${folderOf(file)}/${ref}` : ref);

// A gate with its file references changed by `map`: its guide, and the text
// of a workflow gate that names its child by a path.
function mapGateRefs(g: Gate, map: (ref: string) => string): Gate {
  const out = { ...g };
  if (g.guide) out.guide = map(g.guide);
  if (g.kind === "workflow" && isWorkflowPath(g.text)) out.text = map(g.text);
  return out;
}

// A gate as the file it is in reads it, for comparing: references resolved,
// relative and absolute ones alike, to the files they name.
const resolvedGate = (g: Gate, file?: string) => (file === undefined ? g : mapGateRefs(g, (ref) => resolveFrom(ref, file)));
// A gate of the right side as the left side has to write it.
const gateForLeft = (g: Gate, files?: CompareFiles) => (files ? mapGateRefs(g, (ref) => rebaseRef(ref, files.right, files.left)) : g);

// ----------------------------------------------------------- gate order

// The order fuse-flow runs a step's gates in (gatesInOrder in
// flow/src/commands.ts): the workflow gate, then checks and scripts, then
// agent reviews, then the owner; within one rank, in file order. A review's
// number, which an owner's acceptance is bound to, is its place in that
// order. So gates that move within a rank change what the step does, and a
// move between ranks does not.
export const gateRank = (g: Pick<Gate, "kind">): number =>
  g.kind === "workflow" ? 0 : g.kind === "check" || g.kind === "script" ? 1 : g.kind === "agent" ? 2 : 3;
const RANK_LABEL = ["workflow gates", "checks and scripts", "agent reviews", "owner gates"];

// The gates of two steps paired one to one. A step may have two gates of the
// same kind and text, so they are not matched as a set: first each left gate
// with an equal right gate (same key and settings), in any order; then the
// remaining gates with the same key, in file order. Indices are file indices.
export interface GatePairs {
  // Pairs with the same key whose settings differ.
  changed: { left: number; right: number }[];
  onlyLeft: number[];
  onlyRight: number[];
  // The ranks whose paired gates run in another order on the right, each
  // with its pairs in the right's file order.
  reordered: { rank: number; pairs: { left: number; right: number }[] }[];
}

export function pairGates(x: Gate[], y: Gate[]): GatePairs {
  const leftFree = x.map((_, i) => i);
  const rightFree = y.map((_, j) => j);
  const take = (match: (i: number, j: number) => boolean, pairs: { left: number; right: number }[]) => {
    for (const i of [...leftFree]) {
      const j = rightFree.find((j) => match(i, j));
      if (j === undefined) continue;
      leftFree.splice(leftFree.indexOf(i), 1);
      rightFree.splice(rightFree.indexOf(j), 1);
      pairs.push({ left: i, right: j });
    }
  };
  const sameKey = (i: number, j: number) => gateKey(x[i]) === gateKey(y[j]);
  const equal: { left: number; right: number }[] = [];
  take((i, j) => sameKey(i, j) && gateSettings(x[i]) === gateSettings(y[j]), equal);
  const changed: { left: number; right: number }[] = [];
  take(sameKey, changed);
  const reordered: GatePairs["reordered"] = [];
  for (const rank of [0, 1, 2, 3]) {
    const pairs = [...equal, ...changed].filter((p) => gateRank(x[p.left]) === rank).sort((a, b) => a.right - b.right);
    if (pairs.some((p, k) => k > 0 && p.left < pairs[k - 1].left)) reordered.push({ rank, pairs });
  }
  return { changed, onlyLeft: leftFree, onlyRight: rightFree, reordered };
}

// The outputs of two steps paired by artifact, whatever their mode: one
// artifact in two modes is one output whose mode changed, never one removed
// and one added, so applying it cannot leave the left declaring the artifact
// twice. Equal outputs pair first, then the rest by artifact in file order.
// Indices are into the steps' artifact lists.
export interface OutputPairs {
  // Pairs whose mode, path or description differ.
  changed: { left: number; right: number }[];
  onlyLeft: number[];
  onlyRight: number[];
}

export function pairOutputs(x: ArtifactView[], y: ArtifactView[]): OutputPairs {
  const leftFree = x.map((_, i) => i);
  const rightFree = y.map((_, j) => j);
  const take = (match: (i: number, j: number) => boolean, pairs: { left: number; right: number }[]) => {
    for (const i of [...leftFree]) {
      const j = rightFree.find((j) => match(i, j));
      if (j === undefined) continue;
      leftFree.splice(leftFree.indexOf(i), 1);
      rightFree.splice(rightFree.indexOf(j), 1);
      pairs.push({ left: i, right: j });
    }
  };
  const sameArtifact = (i: number, j: number) => x[i].artifact === y[j].artifact;
  const equal = (i: number, j: number) =>
    sameArtifact(i, j) && x[i].role === y[j].role && x[i].path === y[j].path && (x[i].description ?? "") === (y[j].description ?? "");
  take(equal, []);
  const changed: { left: number; right: number }[] = [];
  take(sameArtifact, changed);
  return { changed, onlyLeft: leftFree, onlyRight: rightFree };
}

// How step `x` (left) differs from step `y` (right) with the same id. Lists
// hold the keys of the elements on one side only (consumes by id, outputs by
// outputKey), or on both sides with other details: for outputs, the keys on
// both sides of each pair that pairOutputs finds changed. Gates are listed by
// file index, as pairGates pairs them. Gate references are compared as the
// files they name when the workflow files are given.
export interface StepDiff {
  title: boolean;
  phase: boolean;
  mode: boolean;
  description: boolean;
  condition: boolean;
  instruction: boolean;
  consumesLeft: string[];
  consumesRight: string[];
  outputsLeft: string[];
  outputsRight: string[];
  outputsChanged: string[];
  gatesLeft: number[];
  gatesRight: number[];
  gatesChanged: { left: number; right: number }[];
  // The gates that run in another order, by rank (see pairGates).
  gatesReordered: GatePairs["reordered"];
}

export function stepDiff(x: StepView, y: StepView, files?: CompareFiles): StepDiff {
  const notIn = <T>(a: T[], b: T[], key: (v: T) => string) => a.filter((v) => !b.some((w) => key(w) === key(v))).map(key);
  const id = (v: string) => v;
  const outputs = pairOutputs(x.artifacts, y.artifacts);
  const gates = pairGates(
    x.gates.map((g) => resolvedGate(g, files?.left)),
    y.gates.map((g) => resolvedGate(g, files?.right)),
  );
  return {
    title: (x.title ?? "") !== (y.title ?? ""),
    phase: (x.phase ?? "") !== (y.phase ?? ""),
    // A step without a mode runs attended. A mode is not trimmed:
    // whitespace makes it invalid.
    mode: (x.mode ?? "attended") !== (y.mode ?? "attended"),
    description: (x.description ?? "").trim() !== (y.description ?? "").trim(),
    condition: conditionValue(x.condition) !== conditionValue(y.condition),
    instruction: normalInstruction(x.instruction) !== normalInstruction(y.instruction),
    consumesLeft: notIn(x.consumes, y.consumes, id),
    consumesRight: notIn(y.consumes, x.consumes, id),
    outputsLeft: outputs.onlyLeft.map((i) => outputKey(x.artifacts[i])),
    outputsRight: outputs.onlyRight.map((j) => outputKey(y.artifacts[j])),
    outputsChanged: [
      ...new Set(outputs.changed.flatMap((pair) => [outputKey(x.artifacts[pair.left]), outputKey(y.artifacts[pair.right])])),
    ],
    gatesLeft: gates.onlyLeft,
    gatesRight: gates.onlyRight,
    gatesChanged: gates.changed,
    gatesReordered: gates.reordered,
  };
}

export function hasDifferences(d: StepDiff): boolean {
  return (
    d.title ||
    d.phase ||
    d.mode ||
    d.description ||
    d.condition ||
    d.instruction ||
    [d.consumesLeft, d.consumesRight, d.outputsLeft, d.outputsRight, d.outputsChanged, d.gatesLeft, d.gatesRight, d.gatesChanged, d.gatesReordered].some(
      (list) => list.length > 0,
    )
  );
}

// ------------------------------------------------------------- alignment

export type RowKind = "same" | "changed" | "left" | "right" | "moved";

// One row of the aligned steps: a pair with the same id (same or changed),
// a step on one side only, or a step outside the common subsequence that
// both sides have (moved), shown once on each side with the other empty.
export interface CompareRow {
  kind: RowKind;
  // The step's index in the left and right workflow; null where the row has none.
  left: number | null;
  right: number | null;
  // A moved step's index on the other side: where the left one went (to),
  // where the right one came from (from).
  to?: number;
  from?: number;
  // Where a step put into the left workflow at this row goes: right after the
  // last left step of the rows above.
  at: number;
  // A pair's differences.
  diff?: StepDiff;
}

export function alignSteps(left: StepView[], right: StepView[], files?: CompareFiles): CompareRow[] {
  const a = left.map((s) => s.id);
  const b = right.map((s) => s.id);
  const rows: CompareRow[] = [];
  let lastLeft = -1;
  for (const op of lcsDiff(a, b)) {
    const at = lastLeft + 1;
    if (op.kind === " ") {
      const diff = stepDiff(left[op.a!], right[op.b!], files);
      rows.push({ kind: hasDifferences(diff) ? "changed" : "same", left: op.a!, right: op.b!, at, diff });
    } else if (op.kind === "-") {
      const to = b.indexOf(a[op.a!]);
      rows.push(to >= 0 ? { kind: "moved", left: op.a!, right: null, to, at } : { kind: "left", left: op.a!, right: null, at });
    } else {
      const from = a.indexOf(b[op.b!]);
      rows.push(from >= 0 ? { kind: "moved", left: null, right: op.b!, from, at } : { kind: "right", left: null, right: op.b!, at });
    }
    if (op.kind !== "+") lastLeft = op.a!;
  }
  return rows;
}

// The summary bar's counts. A moved step is counted once.
export function rowCounts(rows: CompareRow[]): Record<RowKind, number> {
  const counts: Record<RowKind, number> = { same: 0, changed: 0, left: 0, right: 0, moved: 0 };
  for (const row of rows) if (row.kind !== "moved" || row.left !== null) counts[row.kind]++;
  return counts;
}

// The rows as shown: with only differences on, each run of same rows folds
// into one gap naming its steps.
export type CompareItem = { type: "row"; row: CompareRow } | { type: "gap"; ids: string[] };

export function compareItems(rows: CompareRow[], left: StepView[], onlyDifferences: boolean): CompareItem[] {
  const out: CompareItem[] = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (!onlyDifferences || row.kind !== "same") out.push({ type: "row", row });
    else if (last?.type === "gap") last.ids.push(left[row.left!].id);
    else out.push({ type: "gap", ids: [left[row.left!].id] });
  }
  return out;
}

// Whether the left step at this index is hidden in a folded run of
// identical steps, so revealing it means turning only differences off.
export function foldedStep(rows: CompareRow[], leftIndex: number, onlyDifferences: boolean): boolean {
  return onlyDifferences && rows.some((row) => row.left === leftIndex && row.kind === "same");
}

// ------------------------------------------------------------- applying

// Why steps cannot be copied from this workflow, or null when they can. A
// workflow that does not parse is shown from a loose reading of its YAML,
// which leaves out gates and conditions written as strings and artifact
// paths, so a copy from it would silently drop them.
export function copySourceProblem(workflow: OpenWorkflow): string | null {
  return workflow.parsed ? null : `Fix the problems in ${workflow.file} before copying from it.`;
}

// Why changes cannot be applied from the right workflow to the left one, or
// null when they can. The left may fail to parse, as an Apply all can leave
// it consuming what no earlier step produces yet, as long as its shown steps
// hold all of its YAML: the edits address steps, gates and outputs by
// position.
export function applyProblem(left: OpenWorkflow, right: OpenWorkflow): string | null {
  if (left.location === "run") return `${left.file} is another project's workflow and is read-only.`;
  if (!readsCompletely(left)) return `Fix the problems in ${left.file} before applying changes to it.`;
  return copySourceProblem(right);
}

// The structured edits cannot write a workflow gate's inputs or a returns
// mapping, so a gate that carries a slug, inputs or returns is never copied
// or changed from Compare, rather than copied without them.
const delegates = (g: Gate) => g.kind === "workflow" && (g.slug !== undefined || !!g.inputs || !!g.returns);
const delegation = (g: Gate) => canonical({ slug: g.slug, inputs: g.inputs, returns: g.returns });

export const GATE_LABEL: Record<Gate["kind"], string> = {
  "owner-action": "owner",
  agent: "agent",
  check: "check",
  script: "script",
  workflow: "workflow",
};
export const ROLE_LABEL: Record<ArtifactRole, string> = { produces: "produces", optional_produces: "may produce", updates: "updates" };

export type DiffMark = "add" | "del" | "chg";

// One line of a changed right card: what applying it does to the left step,
// and either the edits that do it or why it is refused.
export interface Difference {
  mark: DiffMark;
  label: string;
  edits: Edit[];
  refused?: string;
}

// The settings of a gate as setGate writes them.
const gateFields = (g: Gate) => ({
  description: g.description ?? null,
  max_rounds: g.max_rounds ?? null,
  guide: g.guide ?? null,
  route_back_to: g.route_back_to,
});

// The differences of left step x (at index `step` of the left workflow) from
// right step y, one per line, in the order the right card lists them. Each
// applies on its own: afterwards that difference is gone and no other
// appears. With the workflow files, a gate reference is written so that it
// names in the left file what it names in the right one.
export function differences(x: StepView, y: StepView, step: number, files?: CompareFiles): Difference[] {
  const d = stepDiff(x, y, files);
  const out: Difference[] = [];
  const presence = (a: unknown, b: unknown): DiffMark => (b ? (a ? "chg" : "add") : "del");
  for (const key of ["title", "phase", "mode", "description"] as const) {
    if (!d[key]) continue;
    const value = y[key];
    // Both steps have a mode, as an absent one means attended: applying
    // the right's absent mode removes the left's key.
    if (key === "mode") {
      out.push({
        mark: "chg",
        label: `mode → ${value ?? "attended"}`,
        edits: [{ op: "setStepField", step, key, value: value ?? null }],
      });
      continue;
    }
    out.push({
      mark: presence(x[key], value),
      label: value ? `${key} → ${value}` : `remove ${key}`,
      edits: [{ op: "setStepField", step, key, value: value ?? null }],
    });
  }
  if (d.condition)
    out.push({
      mark: presence(x.condition, y.condition),
      label: y.condition ? `condition → ${GATE_LABEL[y.condition.kind]}: ${y.condition.text}` : "remove condition",
      edits: [{ op: "setCondition", step, condition: y.condition ? { ...y.condition } : null }],
    });
  // Literal style keeps the text exactly; folded style would rewrap it.
  if (d.instruction) out.push({ mark: "chg", label: "instruction", edits: [{ op: "setInstruction", step, text: y.instruction ?? "", style: "|" }] });
  for (const c of d.consumesRight) out.push({ mark: "add", label: `consumes ${c}`, edits: [{ op: "setConsumes", step, ids: [...x.consumes, c] }] });
  for (const c of d.consumesLeft)
    out.push({ mark: "del", label: `consumes ${c}`, edits: [{ op: "setConsumes", step, ids: x.consumes.filter((v) => v !== c) }] });
  // The left output's index within its own mode's list, as the edits address it.
  const modeIndex = (i: number) => x.artifacts.slice(0, i).filter((b) => b.role === x.artifacts[i].role).length;
  const outputs = pairOutputs(x.artifacts, y.artifacts);
  for (const a of outputs.onlyRight.map((j) => y.artifacts[j]))
    out.push({
      mark: "add",
      label: `${ROLE_LABEL[a.role]} ${a.artifact}`,
      edits: [
        { op: "addOutput", step, mode: a.role, artifact: a.artifact, path: a.path, ...(a.description !== undefined ? { description: a.description } : {}) },
      ],
    });
  for (const i of outputs.onlyLeft) {
    const a = x.artifacts[i];
    out.push({ mark: "del", label: `${ROLE_LABEL[a.role]} ${a.artifact}`, edits: [{ op: "removeOutput", step, mode: a.role, index: modeIndex(i) }] });
  }
  for (const pair of outputs.changed) {
    const [own, a] = [x.artifacts[pair.left], y.artifacts[pair.right]];
    const moved = own.role !== a.role;
    const detail = own.path !== a.path || (own.description ?? "") !== (a.description ?? "");
    const label = [
      moved && `mode → ${ROLE_LABEL[a.role]}`,
      own.path !== a.path && `path → ${a.path}`,
      (own.description ?? "") !== (a.description ?? "") && `description → ${a.description ?? "none"}`,
    ].filter(Boolean);
    // A mode change moves the entry to the end of the other mode's list in
    // one edit; its path and description follow in the same list of edits.
    const edits: Edit[] = moved ? [{ op: "changeOutputMode", step, mode: own.role, index: modeIndex(pair.left), to: a.role }] : [];
    const at = moved ? x.artifacts.filter((b) => b.role === a.role).length : modeIndex(pair.left);
    if (detail) edits.push({ op: "setOutput", step, mode: a.role, index: at, fields: { path: a.path, description: a.description ?? null } });
    out.push({ mark: "chg", label: `${a.artifact} ${label.join(", ")}`, edits });
  }
  const refusal = (g: Gate) =>
    `The workflow gate ${g.text} sets the child's slug, inputs or returns, which Compare cannot write; change it on the Edit page instead.`;
  // Compare adds a gate at the end of the left list. Gates of one rank run in
  // file order, so a gate the right step runs before a gate both steps have
  // would run after it; such an addition is refused rather than misplaced.
  const paired = y.gates.map((_, k) => k).filter((k) => !d.gatesRight.includes(k));
  const runsBeforePaired = (j: number) => paired.some((k) => k > j && gateRank(y.gates[k]) === gateRank(y.gates[j]));
  const misplaced =
    "Compare adds a gate at the end of its list, but the other step runs this one before gates both steps have; use Make the left step match this one, or add it in the workflow file.";
  for (const j of d.gatesRight) {
    const g = gateForLeft(y.gates[j], files);
    const label = `gate ${GATE_LABEL[g.kind]}: ${g.text}`;
    if (delegates(g)) out.push({ mark: "add", label, edits: [], refused: refusal(g) });
    else if (runsBeforePaired(j)) out.push({ mark: "add", label, edits: [], refused: misplaced });
    else
      out.push({
        mark: "add",
        label,
        edits: [
          { op: "addGate", step, gate: { kind: g.kind, text: g.text } },
          { op: "setGate", step, index: x.gates.length, fields: gateFields(g) },
        ],
      });
  }
  for (const i of d.gatesLeft) {
    const g = x.gates[i];
    out.push({ mark: "del", label: `gate ${GATE_LABEL[g.kind]}: ${g.text}`, edits: [{ op: "removeGate", step, index: i }] });
  }
  for (const pair of d.gatesChanged) {
    const [own, g] = [x.gates[pair.left], gateForLeft(y.gates[pair.right], files)];
    const label = `gate ${GATE_LABEL[g.kind]}: ${g.text} (settings)`;
    // The other settings are written without touching these, so only a
    // difference in them is refused.
    if (delegation(g) !== delegation(own)) out.push({ mark: "chg", label, edits: [], refused: refusal(g) });
    else out.push({ mark: "chg", label, edits: [{ op: "setGate", step, index: pair.left, fields: gateFields(g) }] });
  }
  // A rank whose gates run in another order. The structured edits cannot
  // move a gate, and taking the gates out and adding them back would drop
  // their comments and layout, so this difference is refused.
  for (const { rank, pairs } of d.gatesReordered) {
    const label = `gate order (${RANK_LABEL[rank]}) → ${pairs.map((p) => y.gates[p.right].text).join(", ")}`;
    out.push({
      mark: "chg",
      label,
      edits: [],
      refused: "Compare cannot move gates without losing their comments; reorder them in the workflow file.",
    });
  }
  return out;
}

// Removes a step that only the left workflow has.
export const removeEdits = (row: CompareRow): Edit[] => [{ op: "deleteStep", index: row.left! }];

// Moves the left step of a moved row (shown on the right) to the row's
// position in the left workflow.
export function moveEdits(row: CompareRow): Edit[] {
  const from = row.from!;
  return [{ op: "moveStep", from, to: from < row.at ? row.at - 1 : row.at }];
}

// The edits that make the target workflow's step with this id equal to
// source[index], applied in order with applyEdit. Every other step of the
// target, and the file's comments, are left as they are. A step with the same
// id is replaced in place: the copy is inserted under a free id, the old step
// deleted, and the copy given the id, so a workflow's only step can be
// replaced too (a workflow cannot lose its last step). editedWorkflow keeps
// the replaced step's key. A step the target does not have goes at `at`, or
// without it right after the nearest earlier source step that the target also
// has, or first when there is none. With the workflow files (the source on
// the right, the target on the left), a gate reference is written so that it
// names in the target what it names in the source.
export function copyStepEdits(source: StepView[], index: number, target: StepView[], at?: number, files?: CompareFiles): Edit[] {
  const step = { ...source[index], gates: source[index].gates.map((g) => gateForLeft(g, files)) };
  if (step.gates.some(delegates))
    throw new Error(`Step ${step.id} has a workflow gate with a slug, inputs or returns; copy it in edit mode instead.`);
  const position = copyPosition(source, index, target, at);
  const edits: Edit[] = [];
  const to = position.at;
  if (position.replaces) {
    let tempId = `${step.id}-copy`;
    for (let n = 2; target.some((s) => s.id === tempId); n++) tempId = `${step.id}-copy-${n}`;
    edits.push({ op: "insertStep", at: to, step: { id: tempId, instruction: "" } });
    edits.push({ op: "deleteStep", index: to + 1 });
    edits.push({ op: "setStepField", step: to, key: "id", value: step.id });
  } else edits.push({ op: "insertStep", at: to, step: { id: step.id, instruction: "" } });
  // Literal style keeps the text exactly; folded style would rewrap it and
  // collapse repeated spaces.
  edits.push({ op: "setInstruction", step: to, text: step.instruction ?? "", style: "|" });
  for (const key of ["title", "phase", "mode", "description"] as const)
    if (step[key] !== undefined) edits.push({ op: "setStepField", step: to, key, value: step[key]! });
  if (step.condition) edits.push({ op: "setCondition", step: to, condition: step.condition });
  if (step.consumes.length) edits.push({ op: "setConsumes", step: to, ids: step.consumes });
  for (const a of step.artifacts)
    edits.push({
      op: "addOutput",
      step: to,
      mode: a.role,
      artifact: a.artifact,
      path: a.path,
      ...(a.description !== undefined ? { description: a.description } : {}),
    });
  step.gates.forEach((gate, g) => {
    edits.push({ op: "addGate", step: to, gate: { kind: gate.kind, text: gate.text } });
    const fields = {
      ...(gate.description !== undefined ? { description: gate.description } : {}),
      ...(gate.max_rounds !== undefined ? { max_rounds: gate.max_rounds } : {}),
      ...(gate.guide !== undefined ? { guide: gate.guide } : {}),
      ...(gate.route_back_to.length ? { route_back_to: gate.route_back_to } : {}),
    };
    if (Object.keys(fields).length) edits.push({ op: "setGate", step: to, index: g, fields });
  });
  return edits;
}

function copyPosition(source: StepView[], index: number, target: StepView[], at?: number): { at: number; replaces: boolean } {
  const same = target.findIndex((s) => s.id === source[index].id);
  if (same >= 0) return { at: same, replaces: true };
  if (at !== undefined) return { at: Math.min(at, target.length), replaces: false };
  for (let i = index - 1; i >= 0; i--) {
    const shared = target.findIndex((s) => s.id === source[i].id);
    if (shared >= 0) return { at: shared + 1, replaces: false };
  }
  return { at: 0, replaces: false };
}
