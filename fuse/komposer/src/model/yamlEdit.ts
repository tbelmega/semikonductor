// SPDX-License-Identifier: Apache-2.0
// Structured edits to a fuse-flow workflow YAML file. No React, no DOM, no
// Node APIs: this module runs in the browser as well as in tests.
//
// API:
//
//   export function applyEdit(text: string, edit: Edit): string
//
// `Edit` is a discriminated union on `op`, one member per editable thing in a
// workflow: setWorkflowField, setStepField, setInstruction, setCondition,
// setConsumes, addOutput/removeOutput/setOutput/changeOutputMode,
// addGate/removeGate/setGate, insertStep/deleteStep/moveStep. Step and gate
// indices are positions in the FILE (not the run order the UI may show
// gates in). applyEdit throws a plain Error with a clear message when the
// edit cannot apply (bad index, duplicate id, etc).
//
// How an edit is written, in three parts:
//
// 1. The model. The file's data (`toJS`, aliases resolved) is copied, and the
//    edit is applied to that copy as plain JavaScript (editModel). This says
//    what the file must mean afterwards; it knows nothing about formatting.
//
// 2. The writer. The parsed Document is brought in line with the new data
//    (reconcile): a node whose data did not change is kept as it is, a scalar
//    that changed gets its new value, mappings and lists are matched item by
//    item so their other items keep their nodes, comments and anchors, and
//    new nodes are created only for new data. `yaml`'s Document.toString is
//    not byte-identical for these files (it rewraps folded scalars), so the
//    whole file is never written again. Instead, only the parts that changed
//    are rendered by `yaml` and spliced into the original text: a top-level
//    key (name, description, ...) as a whole, and in a block `steps` list each
//    step on its own, or, in a step written as a block mapping, each of its
//    keys that changed. Every other step and key keeps its bytes, and moving a
//    step moves its text. Inside a rendered part, every scalar and every
//    one-line flow collection that did not change is written as its source
//    text, so quoting, escapes and line breaks stay as they were, and `yaml`
//    writes only the structure around them and what is new.
//
// 3. The safety net (verify). The result is parsed again and its data is
//    compared with the model's. If it does not parse, or means anything else,
//    applyEdit throws and nothing is written. Whatever the writer gets wrong,
//    the file on disk cannot change meaning by accident.

import YAML, { Alias, Document, isAlias, isCollection, isMap, isNode, isPair, isScalar, isSeq, Pair, Scalar, visit, YAMLMap, YAMLSeq } from "yaml";
import type { CollectionTag, ScalarTag } from "yaml";

// ---------------------------------------------------------------------------
// Public types

export type OutputMode = "produces" | "optional_produces" | "updates";
export type GateKind = "owner-action" | "check" | "script" | "agent" | "workflow";
// Every gate kind, as the key a gate mapping is written with. A workflow gate
// is read too wherever a condition is, so a file that wrongly uses one as a
// condition can still be edited; the engine reports it.
const GATE_KINDS: readonly GateKind[] = ["owner-action", "check", "script", "agent", "workflow"];
// The keys only a workflow gate has. Komposer edits the child's slug and a
// returns list; it keeps the rest as written, and removes them all when the
// gate becomes another kind.
const WORKFLOW_GATE_KEYS = ["slug", "inputs", "returns"] as const;

export interface ConditionValue {
  kind: GateKind;
  text: string;
  description?: string;
}

export interface GateFields {
  kind?: GateKind;
  text?: string;
  description?: string | null;
  max_rounds?: number | null;
  guide?: string | null;
  route_back_to?: string[];
  // A workflow gate's child slug, and the ids its child returns, written as a
  // list (each id maps to itself). null or an empty list removes the key.
  slug?: string | null;
  returns?: string[] | null;
}

export interface OutputFields {
  artifact?: string;
  path?: string;
  description?: string | null;
}

export type Edit =
  | { op: "setWorkflowField"; key: "name" | "description"; value: string | null }
  | { op: "setStepField"; step: number; key: "id" | "title" | "phase" | "mode" | "description"; value: string | null }
  | { op: "setInstruction"; step: number; text: string; style: ">" | "|" }
  | { op: "setCondition"; step: number; condition: ConditionValue | null }
  | { op: "setConsumes"; step: number; ids: string[] }
  | { op: "addOutput"; step: number; mode: OutputMode; artifact: string; path: string; description?: string }
  | { op: "removeOutput"; step: number; mode: OutputMode; index: number }
  | { op: "setOutput"; step: number; mode: OutputMode; index: number; fields: OutputFields }
  | { op: "changeOutputMode"; step: number; mode: OutputMode; index: number; to: OutputMode }
  | { op: "addGate"; step: number; gate: { kind: GateKind; text: string } }
  | { op: "removeGate"; step: number; index: number }
  | { op: "setGate"; step: number; index: number; fields: GateFields }
  | { op: "insertStep"; at: number; step: { id: string; instruction: string } }
  | { op: "deleteStep"; index: number }
  | { op: "moveStep"; from: number; to: number };

// ---------------------------------------------------------------------------
// Shared helpers

// The order new keys are inserted in: before the first existing key that comes
// later in this order. Keys not listed keep their place and are skipped.
const ROOT_KEY_ORDER = ["version", "name", "description", "inputs", "hands_off_to", "steps"] as const;
const STEP_KEY_ORDER = ["id", "title", "phase", "mode", "description", "instruction", "condition", "consumes", "produces", "optional_produces", "updates", "gates"] as const;
const OUTPUT_KEY_ORDER = ["artifact", "path", "description"] as const;
const GATE_KEY_ORDER = [...GATE_KINDS, ...WORKFLOW_GATE_KEYS, "description", "guide", "max_rounds", "route_back_to"] as const;
const CONDITION_KEY_ORDER = [...GATE_KINDS, "description"] as const;

// Folded scalars that Komposer writes are wrapped at this many columns.
const FOLD_WIDTH = 100;

class EditError extends Error {}

function fail(message: string): never {
  throw new EditError(message);
}

type Obj = Record<string, unknown>;
type Range = [number, number, number];

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Data equality: lists by position, mappings by key regardless of key order.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && deepEqual(a[k], b[k]));
  }
  return Number.isNaN(a) && Number.isNaN(b);
}

// Where two data values first differ, as a dotted path, for error messages.
function firstDifference(a: unknown, b: unknown, path = ""): string | null {
  if (deepEqual(a, b)) return null;
  const at = (k: string | number) => (path ? `${path}.${k}` : String(k));
  if (Array.isArray(a) && Array.isArray(b) && a.length === b.length) {
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], b[i], at(i));
      if (d !== null) return d;
    }
  }
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDifference(a[k], b[k], at(k));
      if (d !== null) return d;
    }
  }
  return path || "(the whole file)";
}

// A deep copy of plain data in which nothing is shared: toJS gives the same
// object for every alias of an anchor, and editing one must not edit the rest.
function copyData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(copyData);
  if (isObj(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyData(v)]));
  return value;
}

function toData(doc: Document, node: unknown): unknown {
  return isNode(node) ? node.toJS(doc, { maxAliasCount: -1 }) : node;
}

// The source tokens are kept so a step's dash can be found (stepLines).
function parseDoc(text: string): Document.Parsed {
  const doc = YAML.parseDocument(text, { keepSourceTokens: true });
  if (doc.errors.length) fail(`not valid YAML: ${doc.errors[0].message}`);
  return doc;
}

function keyOf(pair: Pair): string | undefined {
  return isScalar(pair.key) ? String(pair.key.value) : undefined;
}

function findPair(map: YAMLMap, key: string): Pair | undefined {
  return map.items.find((p) => keyOf(p) === key);
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf("\n", offset - 1) + 1;
}

// The end of the line (including its newline) containing `offset`, i.e. the
// start of the next line, or text.length if there is none.
function lineEndOf(text: string, offset: number): number {
  const nl = text.indexOf("\n", offset);
  return nl === -1 ? text.length : nl + 1;
}

// ---------------------------------------------------------------------------
// The model: the edit applied to the file's data as plain JavaScript

// A scalar style the edit asks for, which data alone cannot say: the block
// style of an instruction.
interface StyleHint {
  path: (string | number)[];
  type: Scalar.Type;
  // The edit is about the style itself, so it fails where the style cannot be
  // written (in a flow collection) rather than leaving it to yaml.
  strict: boolean;
}

interface Model {
  data: Obj;
  styles: StyleHint[];
}

// `obj` with `key` set to `value`. An existing key keeps its place; a new key
// goes before the first existing key that comes later in `order`, or last.
function withKey(obj: Obj, key: string, value: unknown, order: readonly string[]): Obj {
  if (Object.hasOwn(obj, key)) return { ...obj, [key]: value };
  const rank = order.indexOf(key);
  if (rank === -1) fail(`internal error: unknown key "${key}"`);
  const entries = Object.entries(obj);
  const at = entries.findIndex(([k]) => order.indexOf(k) > rank);
  entries.splice(at === -1 ? entries.length : at, 0, [key, value]);
  return Object.fromEntries(entries);
}

function withoutKey(obj: Obj, key: string): Obj {
  return Object.fromEntries(Object.entries(obj).filter(([k]) => k !== key));
}

// `obj` with key `from` replaced, in its place, by `to` with `value`.
function renamedKey(obj: Obj, from: string, to: string, value: unknown): Obj {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => (k === from ? [to, value] : [k, v])));
}

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function stepAt(steps: unknown[], index: number): Obj {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) {
    fail(`step index ${index} is out of range (workflow has ${steps.length} steps)`);
  }
  const step = steps[index];
  if (!isObj(step)) fail(`step ${index} is not a mapping`);
  return step;
}

// The block text an instruction is written with: its own text, ending in one
// newline, as a block scalar with the default (clip) chomping reads.
function blockText(value: string): string {
  return `${value.replace(/\n+$/, "")}\n`;
}

// Is `text` short enough for a new step's instruction to be a plain scalar,
// as real workflow files write short instructions ("Polish it.")?
function shouldUsePlainScalar(value: string): boolean {
  return !value.includes("\n") && value.length <= 80;
}

// A condition or gate written as a string, e.g. `script("bun run check")` or
// `check: default`, the way the engine's schema reads it.
function readStringGate(raw: string): { kind: GateKind; text: string } | null {
  const match = /^([a-z-]+)\s*(?:\(\s*"?(.*?)"?\s*\)|:(.*))$/s.exec(raw.trim());
  if (!match) return null;
  return { kind: match[1] as GateKind, text: (match[2] ?? match[3] ?? "").trim() };
}

// The key of a gate or condition mapping that names its kind.
function kindKeyOf(obj: Obj): GateKind | undefined {
  return Object.keys(obj).find((k): k is GateKind => GATE_KINDS.includes(k as GateKind));
}

function readCondition(value: unknown): ConditionValue | null {
  if (isObj(value)) {
    const kind = kindKeyOf(value);
    if (!kind) return null;
    const description = value.description === undefined || value.description === null ? undefined : text(value.description);
    return { kind, text: text(value[kind]), ...(description === undefined ? {} : { description }) };
  }
  return typeof value === "string" ? readStringGate(value) : null;
}

// The step's outputs of one mode as a list: a single mapping is a list of one.
function outputList(step: Obj, mode: OutputMode): unknown[] | undefined {
  const value = step[mode];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return [...value];
  if (isObj(value)) return [value];
  fail(`${mode} is neither a mapping nor a list`);
}

// The step's gates as a list: a single gate, mapping or string, is a list of one.
function gateList(step: Obj): unknown[] | undefined {
  const value = step.gates;
  if (value === undefined || value === null) return undefined;
  return Array.isArray(value) ? [...value] : [value];
}

// A step with one mode's outputs or its gates set to `list`; an empty list
// removes the key.
function withList(step: Obj, key: string, list: unknown[]): Obj {
  return list.length ? withKey(step, key, list, STEP_KEY_ORDER) : withoutKey(step, key);
}

// A gate's logical fields, read from its mapping or string form the way the
// engine's gate schema reads them.
interface GateItem {
  kind: GateKind;
  text: string;
  description?: string;
  guide?: string;
  max_rounds?: number;
  route_back_to: string[];
  slug?: unknown;
  returns?: unknown;
}

function readGateItem(item: unknown): GateItem {
  if (isObj(item)) {
    const kind = kindKeyOf(item);
    if (!kind) fail("gate mapping has no kind key");
    const optional = (key: string) => (item[key] === undefined || item[key] === null ? undefined : text(item[key]));
    const rbt = item.route_back_to;
    const route_back_to = Array.isArray(rbt) ? rbt.map(text) : rbt === undefined || rbt === null ? [] : [text(rbt)];
    const gate: GateItem = { kind, text: text(item[kind]), route_back_to };
    if (optional("description") !== undefined) gate.description = optional("description");
    if (optional("guide") !== undefined) gate.guide = optional("guide");
    if (typeof item.max_rounds === "number") gate.max_rounds = item.max_rounds;
    if (item.slug !== undefined) gate.slug = item.slug;
    if (item.returns !== undefined) gate.returns = item.returns;
    return gate;
  }
  const read = typeof item === "string" ? readStringGate(item) : null;
  if (!read) fail(`cannot read gate "${text(item)}"`);
  return { ...read, route_back_to: [] };
}

// Whether a returns value already says the ids of `list`: as that list, or as
// the mapping of each id to itself.
function sameReturns(current: unknown, list: string[]): boolean {
  if (Array.isArray(current)) return deepEqual(current.map(text), list);
  if (isObj(current)) return deepEqual(current, Object.fromEntries(list.map((id) => [id, id])));
  return false;
}

function patchGate(current: GateItem, fields: GateFields): GateItem {
  const next: GateItem = { ...current, route_back_to: [...current.route_back_to] };
  const set = <K extends keyof GateItem>(key: K, value: GateItem[K] | undefined) => {
    if (value === undefined) delete next[key];
    else next[key] = value;
  };
  if (fields.kind !== undefined) next.kind = fields.kind;
  if (fields.text !== undefined) next.text = fields.text;
  if ("description" in fields) set("description", fields.description ?? undefined);
  if ("max_rounds" in fields) set("max_rounds", fields.max_rounds ?? undefined);
  if ("guide" in fields) set("guide", fields.guide ?? undefined);
  if (fields.route_back_to !== undefined) next.route_back_to = [...fields.route_back_to];
  if (next.kind !== "agent") {
    set("max_rounds", undefined);
    set("guide", undefined);
  }
  if (next.kind !== "workflow") {
    set("slug", undefined);
    set("returns", undefined);
  } else {
    if ("slug" in fields) set("slug", fields.slug || undefined);
    if ("returns" in fields) {
      const list = fields.returns ?? [];
      set("returns", list.length === 0 ? undefined : sameReturns(current.returns, list) ? current.returns : [...list]);
    }
  }
  return next;
}

// The gate as written after the edit. A mapping keeps its other keys where they
// are; a gate in string form becomes a mapping in the engine's key order.
function writeGate(item: unknown, current: GateItem, next: GateItem): Obj {
  const routeBack = (targets: string[]) => (targets.length === 1 ? targets[0] : targets);
  if (!isObj(item)) {
    const gate: Obj = { [next.kind]: next.text };
    if (next.slug !== undefined) gate.slug = next.slug;
    if (next.returns !== undefined) gate.returns = next.returns;
    if (next.description !== undefined) gate.description = next.description;
    if (next.guide !== undefined) gate.guide = next.guide;
    if (next.max_rounds !== undefined) gate.max_rounds = next.max_rounds;
    if (next.route_back_to.length) gate.route_back_to = routeBack(next.route_back_to);
    return gate;
  }
  let gate = item;
  if (next.kind !== current.kind || next.text !== current.text) gate = renamedKey(gate, current.kind, next.kind, next.text);
  if (next.kind !== "workflow") for (const key of WORKFLOW_GATE_KEYS) gate = withoutKey(gate, key);
  for (const key of ["slug", "returns", "description", "guide", "max_rounds"] as const) {
    if (deepEqual(next[key], current[key])) continue;
    gate = next[key] === undefined ? withoutKey(gate, key) : withKey(gate, key, next[key], GATE_KEY_ORDER);
  }
  if (!deepEqual(next.route_back_to, current.route_back_to)) {
    gate = next.route_back_to.length ? withKey(gate, "route_back_to", routeBack(next.route_back_to), GATE_KEY_ORDER) : withoutKey(gate, "route_back_to");
  }
  return gate;
}

// Rename every route_back_to target `from` in a step's gates to `to`.
function renameRoutes(step: unknown, from: string, to: string): unknown {
  if (!isObj(step)) return step;
  const rename = (gate: unknown): unknown => {
    if (!isObj(gate) || !Object.hasOwn(gate, "route_back_to")) return gate;
    const rbt = gate.route_back_to;
    if (Array.isArray(rbt)) return { ...gate, route_back_to: rbt.map((t) => (text(t) === from ? to : t)) };
    return text(rbt) === from ? { ...gate, route_back_to: to } : gate;
  };
  const gates = step.gates;
  if (Array.isArray(gates)) return { ...step, gates: gates.map(rename) };
  if (isObj(gates)) return { ...step, gates: rename(gates) };
  return step;
}

// The edit applied to a copy of `before`. `styleAt` tells the current scalar
// style at a path, so an instruction already written in the requested style
// is left alone; `inFlow` tells whether a path is inside a flow collection.
function editModel(
  before: unknown,
  edit: Edit,
  styleAt: (path: (string | number)[]) => Scalar.Type | undefined,
  inFlow: (path: (string | number)[]) => boolean,
): Model {
  if (!isObj(before)) fail("workflow file does not have a top-level mapping");
  let root = copyData(before) as Obj;
  const styles: StyleHint[] = [];
  if (!Array.isArray(root.steps)) fail("workflow has no steps list");
  const steps: unknown[] = root.steps;

  switch (edit.op) {
    case "setWorkflowField": {
      if (edit.value === null) {
        if (edit.key === "name") fail("name is required and cannot be cleared");
        root = withoutKey(root, edit.key);
      } else root = withKey(root, edit.key, edit.value, ROOT_KEY_ORDER);
      break;
    }
    case "setStepField": {
      const step = stepAt(steps, edit.step);
      if (edit.key !== "id") {
        steps[edit.step] = edit.value === null ? withoutKey(step, edit.key) : withKey(step, edit.key, edit.value, STEP_KEY_ORDER);
        break;
      }
      if (edit.value === null) fail("id is required and cannot be cleared");
      const oldId = text(step.id);
      if (oldId === edit.value) break;
      if (steps.some((other, i) => i !== edit.step && isObj(other) && text(other.id) === edit.value)) {
        fail(`step id "${edit.value}" is already used by another step`);
      }
      steps[edit.step] = { ...step, id: edit.value };
      for (let i = 0; i < steps.length; i++) steps[i] = renameRoutes(steps[i], oldId, edit.value);
      break;
    }
    case "setInstruction": {
      const step = stepAt(steps, edit.step);
      if (step.instruction === undefined || step.instruction === null) fail("step has no instruction to edit");
      const path = ["steps", edit.step, "instruction"];
      // A step written in braces, or in a list written in brackets, cannot
      // hold a block scalar: its instruction is written as a flow scalar,
      // quoted where it has to be, and the block style asked for does not
      // apply. The engine trims the text, so the same text is left alone.
      if (inFlow(path)) {
        if (text(step.instruction).trim() === edit.text.trim()) break;
        steps[edit.step] = { ...step, instruction: edit.text.replace(/\n+$/, "") };
        break;
      }
      const type = edit.style === ">" ? Scalar.BLOCK_FOLDED : Scalar.BLOCK_LITERAL;
      // The same text in the same style is left as written, chomping included.
      if (styleAt(path) === type && text(step.instruction).trim() === edit.text.trim()) break;
      steps[edit.step] = { ...step, instruction: blockText(edit.text) };
      styles.push({ path, type, strict: true });
      break;
    }
    case "setCondition": {
      const step = stepAt(steps, edit.step);
      const wanted = edit.condition;
      if (wanted === null) {
        if (Object.hasOwn(step, "condition")) steps[edit.step] = withoutKey(step, "condition");
        break;
      }
      const current = readCondition(step.condition);
      if (current && current.kind === wanted.kind && current.text === wanted.text && current.description === wanted.description) break;
      // A condition mapping keeps its other keys; only the kind, its text and
      // the description change.
      const existing = step.condition;
      const kind = isObj(existing) ? kindKeyOf(existing) : undefined;
      let next: Obj;
      if (isObj(existing) && kind) {
        next = renamedKey(existing, kind, wanted.kind, wanted.text);
        next = wanted.description === undefined ? withoutKey(next, "description") : withKey(next, "description", wanted.description, CONDITION_KEY_ORDER);
      } else {
        next = { [wanted.kind]: wanted.text, ...(wanted.description === undefined ? {} : { description: wanted.description }) };
      }
      steps[edit.step] = withKey(step, "condition", next, STEP_KEY_ORDER);
      break;
    }
    case "setConsumes": {
      const step = stepAt(steps, edit.step);
      if (edit.ids.length === 0) {
        if (Object.hasOwn(step, "consumes")) steps[edit.step] = withoutKey(step, "consumes");
        break;
      }
      const current = step.consumes;
      if (Array.isArray(current) && deepEqual(current.map(text), edit.ids)) break;
      steps[edit.step] = withKey(step, "consumes", [...edit.ids], STEP_KEY_ORDER);
      break;
    }
    case "addOutput": {
      const step = stepAt(steps, edit.step);
      const entry: Obj = { artifact: edit.artifact, path: edit.path };
      if (edit.description !== undefined) entry.description = edit.description;
      steps[edit.step] = withList(step, edit.mode, [...(outputList(step, edit.mode) ?? []), entry]);
      break;
    }
    case "removeOutput": {
      const step = stepAt(steps, edit.step);
      const list = outputList(step, edit.mode);
      if (!list) fail(`step has no ${edit.mode} list`);
      if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= list.length) fail(`${edit.mode} index ${edit.index} is out of range`);
      list.splice(edit.index, 1);
      steps[edit.step] = withList(step, edit.mode, list);
      break;
    }
    case "setOutput": {
      const step = stepAt(steps, edit.step);
      const value = step[edit.mode];
      const entry = Array.isArray(value) ? value[edit.index] : edit.index === 0 ? value : undefined;
      if (!isObj(entry)) fail(`${edit.mode} index ${edit.index} is out of range`);
      let next = entry;
      for (const key of OUTPUT_KEY_ORDER) {
        if (!(key in edit.fields)) continue;
        const field = edit.fields[key];
        // Only the description can be removed; an output always has the rest.
        if (field === null || field === undefined) {
          if (key === "description") next = withoutKey(next, key);
        } else if (text(next[key]) !== field || next[key] === undefined) next = withKey(next, key, field, OUTPUT_KEY_ORDER);
      }
      if (deepEqual(next, entry)) break;
      if (Object.keys(next).length === 0) {
        fail(`cannot remove "description": it is the only key of its list item, and removing it would leave an empty item`);
      }
      if (Array.isArray(value)) {
        const list = [...value];
        list[edit.index] = next;
        steps[edit.step] = { ...step, [edit.mode]: list };
      } else steps[edit.step] = { ...step, [edit.mode]: next };
      break;
    }
    case "changeOutputMode": {
      if (edit.mode === edit.to) break;
      const step = stepAt(steps, edit.step);
      const list = outputList(step, edit.mode);
      if (!list) fail(`step has no ${edit.mode} list`);
      const entry = list[edit.index];
      if (!isObj(entry)) fail(`${edit.mode} index ${edit.index} is out of range`);
      list.splice(edit.index, 1);
      const moved = withList(step, edit.mode, list);
      steps[edit.step] = withList(moved, edit.to, [...(outputList(moved, edit.to) ?? []), entry]);
      break;
    }
    case "addGate": {
      const step = stepAt(steps, edit.step);
      steps[edit.step] = withList(step, "gates", [...(gateList(step) ?? []), { [edit.gate.kind]: edit.gate.text }]);
      break;
    }
    case "removeGate": {
      const step = stepAt(steps, edit.step);
      const list = gateList(step);
      if (!list) fail("step has no gates list");
      if (!Number.isInteger(edit.index) || edit.index < 0 || edit.index >= list.length) fail(`gate index ${edit.index} is out of range`);
      list.splice(edit.index, 1);
      steps[edit.step] = withList(step, "gates", list);
      break;
    }
    case "setGate": {
      const step = stepAt(steps, edit.step);
      const list = gateList(step);
      const item = list?.[edit.index];
      if (!list || !Number.isInteger(edit.index) || edit.index < 0 || (!isObj(item) && typeof item !== "string")) fail(`gate index ${edit.index} is out of range`);
      const current = readGateItem(item);
      const next = patchGate(current, edit.fields);
      if (deepEqual(current, next)) break;
      const gate = writeGate(item, current, next);
      // A single gate stays a single gate; one in a list is replaced there.
      if (Array.isArray(step.gates)) {
        list[edit.index] = gate;
        steps[edit.step] = { ...step, gates: list };
      } else steps[edit.step] = { ...step, gates: gate };
      break;
    }
    case "insertStep": {
      if (!Number.isInteger(edit.at) || edit.at < 0 || edit.at > steps.length) fail(`insert index ${edit.at} is out of range (workflow has ${steps.length} steps)`);
      if (steps.some((other) => isObj(other) && text(other.id) === edit.step.id)) fail(`step id "${edit.step.id}" is already used`);
      const plain = shouldUsePlainScalar(edit.step.instruction);
      steps.splice(edit.at, 0, { id: edit.step.id, instruction: plain ? edit.step.instruction : blockText(edit.step.instruction) });
      if (!plain) styles.push({ path: ["steps", edit.at, "instruction"], type: Scalar.BLOCK_FOLDED, strict: false });
      break;
    }
    case "deleteStep": {
      stepAt(steps, edit.index);
      if (steps.length === 1) fail("a workflow needs at least one step");
      steps.splice(edit.index, 1);
      break;
    }
    case "moveStep": {
      stepAt(steps, edit.from);
      if (!Number.isInteger(edit.to) || edit.to < 0 || edit.to >= steps.length) fail(`step index ${edit.to} is out of range (workflow has ${steps.length} steps)`);
      const [moved] = steps.splice(edit.from, 1);
      steps.splice(edit.to, 0, moved);
      break;
    }
    default: {
      const _exhaustive: never = edit;
      fail(`unknown edit op: ${JSON.stringify(_exhaustive)}`);
    }
  }
  root.steps = steps;
  return { data: root, styles };
}

// ---------------------------------------------------------------------------
// Matching list items (and mapping keys) between the old data and the new

// For each new item, the old item it continues: `same` when its data is
// unchanged, otherwise the old item it replaces at the same place, which is
// then edited rather than written anew. Unchanged items are matched in order
// first (longest common subsequence); unmatched items between two matches
// pair up by position; an unchanged item that moved is found last. null: a
// new item.
type Match = { from: number; same: boolean } | null;

function matchItems(a: unknown[], b: unknown[], equal: (x: unknown, y: unknown) => boolean = deepEqual): Match[] {
  const n = a.length;
  const m = b.length;
  const eq = a.map((x) => b.map((y) => equal(x, y)));
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) lcs[i][j] = eq[i][j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  }
  const plan: Match[] = new Array<Match>(m).fill(null);
  const anchors: [number, number][] = [[-1, -1]];
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (eq[i][j]) {
      plan[j] = { from: i, same: true };
      anchors.push([i, j]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) i++;
    else j++;
  }
  anchors.push([n, m]);
  const used = new Set(plan.flatMap((p) => (p ? [p.from] : [])));
  // An unchanged item that moved.
  for (let j = 0; j < m; j++) {
    if (plan[j]) continue;
    const i = a.findIndex((_x, k) => !used.has(k) && eq[k][j]);
    if (i !== -1) {
      plan[j] = { from: i, same: true };
      used.add(i);
    }
  }
  // Changed items between two matches, paired by position.
  for (let k = 0; k + 1 < anchors.length; k++) {
    const olds = [];
    const news = [];
    for (let i = anchors[k][0] + 1; i < anchors[k + 1][0]; i++) if (!used.has(i)) olds.push(i);
    for (let j = anchors[k][1] + 1; j < anchors[k + 1][1]; j++) if (!plan[j]) news.push(j);
    for (let t = 0; t < olds.length && t < news.length; t++) {
      plan[news[t]] = { from: olds[t], same: false };
      used.add(olds[t]);
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The writer: bring the parsed Document in line with the new data

// What the original file says about each of its nodes, before any change.
interface Source {
  text: string;
  doc: Document.Parsed;
  data: WeakMap<object, unknown>;
  scalars: WeakMap<Scalar, { value: unknown; type: Scalar.Type | undefined }>;
  collections: WeakSet<object>;
  // The comment lines after each block collection's last item.
  trailing: WeakMap<object, string | null | undefined>;
  // Each alias, with the data it stood for and a copy of the node it named.
  aliases: Map<Alias, { data: unknown; node: unknown }>;
}

// A copy of `node` in which every alias is a copy of the node it names, so
// the copy still means the same once it stands where those anchors are gone.
// Read before any change, while every anchor is still in the document.
function resolvedCopy<T extends Scalar | YAMLMap | YAMLSeq>(doc: Document.Parsed, node: T): T {
  const copy = node.clone() as T;
  visit(copy as never, {
    Alias(_k, alias) {
      const target = alias.resolve(doc);
      return isNode(target) ? (target.clone() as never) : undefined;
    },
  });
  return copy;
}

function readSource(text: string): Source {
  const doc = parseDoc(text);
  const src: Source = { text, doc, data: new WeakMap(), scalars: new WeakMap(), collections: new WeakSet(), trailing: new WeakMap(), aliases: new Map() };
  visit(doc, {
    Node(_key, node) {
      if (isAlias(node)) {
        const target = node.resolve(doc);
        src.aliases.set(node, { data: toData(doc, target), node: target ? resolvedCopy(doc, target) : undefined });
        return;
      }
      src.data.set(node, toData(doc, node));
      if (isScalar(node)) src.scalars.set(node, { value: node.value, type: node.type });
      else {
        src.collections.add(node);
        src.trailing.set(node, node.comment);
      }
    },
  });
  return src;
}

class Writer {
  // Collections whose items changed.
  readonly touched = new WeakSet<object>();
  // Items created for new data, and old items that were removed: a removed
  // item whose data comes back elsewhere (an output moved to another mode)
  // takes the new item's place, with its comments.
  readonly created: { list: YAMLSeq; index: number; data: unknown }[] = [];
  readonly removed: unknown[] = [];

  constructor(readonly src: Source) {}

  dataOf(node: unknown): unknown {
    if (isAlias(node)) return this.src.aliases.get(node)?.data;
    return isNode(node) ? this.src.data.get(node) : node;
  }

  // The node for `value` where `old` was: `old` itself when its data did not
  // change, `old` edited when it can be, otherwise a new node.
  reconcile(old: unknown, value: unknown, inFlow: boolean): unknown {
    if ((isAlias(old) || (isNode(old) && this.src.data.has(old))) && deepEqual(this.dataOf(old), value)) return old;
    if (isScalar(old) && !isObj(value) && !Array.isArray(value)) {
      // A changed scalar is written in the style yaml picks for its new
      // value, unless the edit asks for one.
      old.value = value;
      old.type = undefined;
      return old;
    }
    if (isMap(old) && isObj(value)) {
      this.reconcileMap(old, value, inFlow || !!old.flow);
      return old;
    }
    if (isSeq(old) && Array.isArray(value)) {
      this.reconcileSeq(old, value, inFlow);
      return old;
    }
    // A single entry that becomes a list (a second gate or output) keeps its
    // node as the list's item.
    if (Array.isArray(value) && isNode(old) && value.some((item) => deepEqual(this.dataOf(old), item))) {
      const list = new YAMLSeq();
      list.flow = inFlow;
      let kept = false;
      list.items = value.map((item, index) => {
        if (!kept && deepEqual(this.dataOf(old), item)) {
          kept = true;
          return old;
        }
        return this.createItem(list, index, item, inFlow);
      });
      return list;
    }
    this.remove(old);
    return this.create(value, inFlow);
  }

  reconcileMap(map: YAMLMap, value: Obj, inFlow: boolean): void {
    const pairs = map.items as Pair[];
    const keys = Object.keys(value);
    // A key matched to an old key of another name is a renamed key (a gate
    // whose kind changed): its pair, with its comments, stays.
    const plan = matchItems(pairs.map(keyOf), keys, (a, b) => a === b);
    const used = new Set(plan.flatMap((p) => (p ? [p.from] : [])));
    // The comment lines above a removed key stay, above the next key that
    // stays, or after the mapping's last key.
    pairs.forEach((pair, i) => {
      if (used.has(i)) return;
      this.remove(pair.value);
      const comment = isNode(pair.key) ? pair.key.commentBefore : undefined;
      if (!comment) return;
      const next = pairs.slice(i + 1).find((_p, k) => used.has(i + 1 + k));
      if (next && isNode(next.key)) next.key.commentBefore = next.key.commentBefore ? `${comment}\n${next.key.commentBefore}` : comment;
      else map.comment = map.comment ? `${comment}\n${map.comment}` : comment;
    });
    map.items = keys.map((key, i) => {
      const match = plan[i];
      if (!match) return new Pair(new Scalar(key), this.create(value[key], inFlow));
      const pair = pairs[match.from];
      if (!match.same && isScalar(pair.key)) {
        pair.key.value = key;
        pair.key.type = undefined;
      }
      pair.value = this.reconcile(pair.value, value[key], inFlow);
      return pair;
    });
    this.touched.add(map);
  }

  reconcileSeq(seq: YAMLSeq, value: unknown[], inFlow: boolean): void {
    // `[]` is how an empty list is written, not a choice of style: a list
    // that gets mappings or lists is written as a block.
    if (seq.flow && !inFlow && seq.items.length === 0 && value.some((v) => isObj(v) || Array.isArray(v))) seq.flow = false;
    const flow = inFlow || !!seq.flow;
    const items = seq.items;
    const plan = matchItems(items.map((item) => this.dataOf(item)), value);
    const used = new Set(plan.flatMap((p) => (p ? [p.from] : [])));
    items.forEach((item, i) => {
      if (!used.has(i)) this.remove(item);
    });
    seq.items = value.map((v, i) => {
      const match = plan[i];
      if (!match) return this.createItem(seq, i, v, flow);
      return match.same ? items[match.from] : this.reconcile(items[match.from], v, flow);
    });
    this.touched.add(seq);
  }

  // A new node. A new list of scalars is a flow list, `[a, b]`; a new list
  // of mappings, and a new mapping, are blocks, unless inside a flow
  // collection.
  create(value: unknown, inFlow: boolean): unknown {
    if (Array.isArray(value)) {
      const seq = new YAMLSeq();
      seq.flow = inFlow || value.every((v) => !isObj(v) && !Array.isArray(v));
      seq.items = value.map((v, i) => this.createItem(seq, i, v, seq.flow!));
      return seq;
    }
    if (isObj(value)) {
      const map = new YAMLMap();
      map.flow = inFlow;
      map.items = Object.entries(value).map(([k, v]) => new Pair(new Scalar(k), this.create(v, inFlow)));
      return map;
    }
    return new Scalar(value);
  }

  createItem(list: YAMLSeq, index: number, value: unknown, inFlow: boolean): unknown {
    this.created.push({ list, index, data: value });
    return this.create(value, inFlow);
  }

  remove(node: unknown): void {
    this.removed.push(node);
    if (isSeq(node)) this.removed.push(...node.items);
  }

  // A removed item whose data was created again elsewhere takes the place of
  // the new item.
  reuseRemoved(): void {
    const free = this.removed.filter((node) => isNode(node) && !isAlias(node) && this.src.data.has(node));
    for (const { list, index, data } of this.created) {
      const at = free.findIndex((node) => deepEqual(this.dataOf(node), data));
      if (at === -1) continue;
      list.items[index] = free[at];
      free.splice(at, 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering a changed part with yaml

// The source text of an unchanged scalar or one-line flow collection, written
// as it stood. `ownsComment`: the text includes the node's own comment.
class RawText {
  constructor(
    readonly first: string,
    readonly rest: string[],
    readonly ownsComment: boolean,
  ) {}
}

const BUILTIN = new Document().schema.tags;
const builtinTag = (tag: string) => BUILTIN.find((t) => t.tag === tag)!;
const STR_TAG = builtinTag("tag:yaml.org,2002:str") as ScalarTag;

// The tags a changed part is rendered with, ahead of yaml's own:
// - RawText is written as its source; continuation lines keep their indentation
//   relative to the first of them, at the depth yaml gives the node now.
// - A folded block scalar is wrapped at FOLD_WIDTH columns of the file (the
//   part is rendered at column 0 and shifted by `shift`); every other string
//   stays on its line.
// - Flow lists are written `[a, b]`, flow mappings `{ a: b }`, as the
//   workflow files write them.
function renderTags(shift: number): (CollectionTag | ScalarTag)[] {
  const raw: ScalarTag = {
    tag: "tag:komposer.local,2026:raw",
    default: true,
    identify: (value) => value instanceof RawText,
    resolve: (value) => value,
    stringify(node, ctx, onComment) {
      const raw = (node as Scalar).value as RawText;
      if (raw.ownsComment) onComment?.();
      return [raw.first, ...raw.rest.map((line) => (line ? ctx.indent + line : line))].join("\n");
    },
  };
  const str: ScalarTag = {
    ...STR_TAG,
    stringify(node, ctx, onComment, onChompKeep) {
      const lineWidth = (node as Scalar).type === Scalar.BLOCK_FOLDED ? Math.max(40, FOLD_WIDTH - shift) : 0;
      return STR_TAG.stringify!(node, { ...ctx, options: { ...ctx.options, lineWidth } }, onComment, onChompKeep);
    },
  };
  const padded = (tag: string, padding: string) => {
    const base = builtinTag(tag) as CollectionTag;
    return {
      ...base,
      stringify(node: YAMLMap | YAMLSeq, ctx: { flowCollectionPadding: string }, onComment?: () => void, onChompKeep?: () => void) {
        return node.toString({ ...ctx, flowCollectionPadding: padding } as never, onComment, onChompKeep);
      },
    } as unknown as CollectionTag;
  };
  return [raw, str, padded("tag:yaml.org,2002:seq", ""), padded("tag:yaml.org,2002:map", " ")];
}

// Continuation lines of a node's source, with the indentation they share
// removed, or null if they cannot be moved (tabs).
function continuation(lines: string[]): string[] | null {
  const indents = lines.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length);
  if (lines.some((l) => /^\s*\t/.test(l))) return null;
  const base = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => (l.trim() ? l.slice(base) : ""));
}

// The comment after a scalar on its line, with the space before it, as
// written ("   # why"), or null if the scalar has none there.
function sameLineComment(text: string, node: Scalar): string | null {
  if (!node.comment || node.comment.includes("\n") || !node.range) return null;
  const end = node.range[1];
  const rest = text.slice(end, lineEndOf(text, end)).replace(/\r?\n$/, "");
  const match = /^([ \t]+#(.*))$/.exec(rest);
  return match && match[2].trimEnd() === node.comment.trimEnd() ? match[1].trimEnd() : null;
}

// A changed scalar with a comment on its line, written by yaml with the
// comment after it as it was spaced, or null when that does not fit on one line.
function commentedScalar(src: Source, node: Scalar, inFlow: boolean): RawText | null {
  if (inFlow || node.tag || node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) return null;
  const comment = sameLineComment(src.text, node);
  if (comment === null) return null;
  const alone = new Document(null);
  const scalar = new Scalar(node.value);
  scalar.type = node.type;
  alone.contents = scalar as never;
  const value = alone.toString({ lineWidth: 0, singleQuote: true }).replace(/\n$/, "");
  return value.includes("\n") ? null : new RawText(`${value}${comment}`, [], true);
}

// The source of an unchanged scalar, or null when it must be rendered (it
// changed, has a tag, or its source cannot be moved as text).
function rawScalar(src: Source, node: Scalar, inFlow: boolean): RawText | null {
  const info = src.scalars.get(node);
  if (!info || info.value !== node.value || info.type !== node.type || node.tag || !node.range) return null;
  const { text } = src;
  const [start, end] = node.range;
  let source = text.slice(start, end);
  let ownsComment = false;
  // Inside a flow collection a block scalar cannot stand, and a plain one
  // cannot hold the characters that delimit the collection: such a value,
  // moved from block lines into braces or brackets, is rendered afresh.
  if (inFlow && (node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL)) return null;
  if (inFlow && node.type === Scalar.PLAIN && /[,[\]{}]/.test(source)) return null;
  if (node.type === Scalar.BLOCK_FOLDED || node.type === Scalar.BLOCK_LITERAL) {
    const header = source.slice(0, source.indexOf("\n") === -1 ? source.length : source.indexOf("\n"));
    // Keep chomping holds trailing blank lines yaml would have to place, and an
    // explicit indentation indicator counts from the parent's column.
    if (/^[|>][^#]*[+0-9]/.test(header)) return null;
    if (node.comment) {
      if (!header.includes("#")) return null;
      ownsComment = true;
    }
    source = source.replace(/(\n[ \t]*)+$/, "");
  } else if (!inFlow) {
    const comment = sameLineComment(text, node);
    if (comment !== null) {
      source += comment;
      ownsComment = true;
    }
  }
  const [first, ...more] = source.split("\n");
  const rest = continuation(more);
  return rest ? new RawText(first, rest, ownsComment) : null;
}

// The node, ready to render: unchanged scalars and one-line flow collections
// become their source text. Returns the node to use in its place.
function asRendered(src: Source, w: Writer, node: unknown, inFlow: boolean): unknown {
  if (isPair(node)) {
    node.key = asRendered(src, w, node.key, inFlow);
    node.value = asRendered(src, w, node.value, inFlow);
    return node;
  }
  if (isScalar(node)) {
    if (node.value instanceof RawText) return node;
    const raw = rawScalar(src, node, inFlow) ?? commentedScalar(src, node, inFlow);
    if (raw) node.value = raw;
    return node;
  }
  if (isCollection(node)) {
    const range = node.range;
    if (node.flow && src.collections.has(node) && !w.touched.has(node) && range && !node.tag) {
      const source = src.text.slice(range[0], range[1]);
      if (!source.includes("\n")) {
        const scalar = new Scalar(new RawText(source, [], false));
        scalar.anchor = node.anchor;
        scalar.comment = node.comment;
        scalar.commentBefore = node.commentBefore;
        scalar.spaceBefore = node.spaceBefore;
        return scalar;
      }
    }
    const flow = inFlow || !!node.flow;
    node.items = node.items.map((item) => asRendered(src, w, item, flow)) as typeof node.items;
    return node;
  }
  return node;
}

// The comment lines the file has after the last item of a block collection,
// and of its last item's value and so on, are text after the part being
// replaced: they stay in the file where they are, so they are not rendered
// again. Comments moved there by the edit are.
function dropTrailingComments(src: Source, node: unknown): void {
  while (isCollection(node) && !node.flow) {
    const original = src.trailing.get(node);
    if (original && node.comment?.endsWith(original)) node.comment = node.comment.slice(0, -original.length).replace(/\n$/, "") || undefined;
    const last = node.items[node.items.length - 1];
    node = isPair(last) ? last.value : last;
  }
}

// One part of the file rendered by yaml at column `shift`: a top-level pair
// (`key: value`) or a step (`- id: ...`), without a trailing newline.
// `before`: comments of the part's own text to write above it, such as those
// between a step's dash and its content.
function render(src: Source, w: Writer, unit: Pair | unknown, shift: number, indentSeq: boolean, before?: string): string {
  const node = asRendered(src, w, unit, false);
  const wrapper = isPair(node) ? new YAMLMap() : new YAMLSeq();
  (wrapper.items as unknown[]) = [node];
  // The comment lines above the part stay in the file where they are.
  const lead = isPair(node) ? node.key : node;
  if (isNode(lead)) {
    lead.commentBefore = before;
    lead.spaceBefore = false;
  }
  dropTrailingComments(src, isPair(node) ? node.value : node);
  const doc = new Document(null, { customTags: (tags) => [...renderTags(shift), ...tags] });
  doc.contents = wrapper as never;
  const out = doc
    .toString({ indent: 2, indentSeq, lineWidth: 0, singleQuote: true, verifyAliasOrder: false })
    .replace(/\n$/, "");
  return out
    .split("\n")
    .map((line) => (line ? " ".repeat(shift) + line : line))
    .join("\n");
}

// ---------------------------------------------------------------------------
// Splicing the rendered parts into the original text

interface Splice {
  start: number;
  end: number;
  insert: string;
}

function applySplices(text: string, splices: Splice[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end);
  let out = "";
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) fail("internal error: overlapping edits");
    out += text.slice(pos, s.start) + s.insert;
    pos = s.end;
  }
  return out + text.slice(pos);
}

function columnOf(text: string, offset: number): number {
  return offset - lineStartOf(text, offset);
}

// The start of the comment lines directly above `lineStart` written at
// `column`, which belong to the key or list item on that line and go with it.
function headStart(text: string, lineStart: number, column: number): number {
  let start = lineStart;
  while (start > 0) {
    const prevStart = lineStartOf(text, start - 1);
    const prev = text.slice(prevStart, start - 1);
    if (!/^\s*#/.test(prev) || prev.length - prev.trimStart().length !== column) break;
    start = prevStart;
  }
  return start;
}

// The end (after its newline) of the line holding the last character of a
// node's own content, before any comment lines after it.
function contentEnd(text: string, node: unknown): number {
  const range = (node as { range?: Range }).range;
  if (!range) fail("internal error: a node of the file has no source range");
  return lineEndOf(text, Math.max(range[0], range[1] - 1));
}

// A top-level pair's lines: from its key's line to the end of its value.
// A top-level pair's lines, measured on the value it had in the file (`value`):
// a changed value, such as an alias's copy of what it named, carries the
// range of another place or none.
function pairLines(text: string, pair: Pair, value: unknown = pair.value): { head: number; start: number; end: number } {
  const key = pair.key as Scalar;
  const start = lineStartOf(text, key.range![0]);
  if (start !== key.range![0]) fail("the workflow's top-level keys must each start a line");
  const valueNode = isNode(value) && value.range ? value : key;
  return { head: headStart(text, start, 0), start, end: contentEnd(text, valueNode) };
}

// A step's lines: `head`, its comment lines; `start`, its "- " line; `end`, the
// end of its content; `next`, where the next step's comments begin (its own
// comment lines after its content and blank lines go with it).
interface StepLines {
  head: number;
  start: number;
  end: number;
  next: number;
  // The column of the "- ".
  dash: number;
  // The comments between the dash and the step's content, without "#".
  between: string | undefined;
}

// The source tokens of a block list's items, one per item: comment lines
// after the last item make a token of their own, which has no dash.
function itemTokens(seq: YAMLSeq): { start: { type: string; offset: number; source: string }[] }[] | undefined {
  const token = seq.srcToken;
  if (token?.type !== "block-seq") return undefined;
  return token.items.filter((item) => item.start.some((t) => t.type === "seq-item-ind"));
}

// `seq` is the steps' list as the file has it, `items` its items before the
// edit.
function stepLines(text: string, seq: YAMLSeq, items: unknown[], regionEnd: number): StepLines[] {
  const tokens = itemTokens(seq);
  const lines = items.map((item, i) => {
    const range = (item as { range?: Range }).range;
    if (!range) fail(`internal error: step ${i} has no source range`);
    // The item's dash, from the source tokens: anchors, tags and comments
    // may stand between it and the item's content, on its line or on lines
    // after it.
    const itemStart = tokens?.[i]?.start ?? [];
    const dashAt = itemStart.find((t) => t.type === "seq-item-ind")?.offset;
    const comments = itemStart.filter((t) => t.type === "comment" && dashAt !== undefined && t.offset > dashAt).map((t) => t.source.slice(1));
    const start = dashAt === undefined ? -1 : lineStartOf(text, dashAt);
    const prefix = dashAt === undefined ? null : /^[ \t]*$/.exec(text.slice(start, dashAt));
    if (dashAt === undefined || !prefix) fail(`step ${i} does not start a line with "- "; write it on its own line to edit it`);
    return { head: headStart(text, start, prefix[0].length), start, end: contentEnd(text, item), next: 0, dash: prefix[0].length, between: comments.length ? comments.join("\n") : undefined };
  });
  lines.forEach((l, i) => (l.next = i + 1 < lines.length ? lines[i + 1].head : regionEnd));
  return lines;
}

// The end of a block list's text, after its last non-blank line.
function blockEnd(text: string, seq: YAMLSeq): number {
  let end = seq.range![2];
  while (end > 0) {
    const start = lineStartOf(text, end - 1);
    if (text.slice(start, end).trim()) break;
    end = start;
  }
  return end === 0 ? 0 : lineEndOf(text, end - 1);
}

// The pairs and nodes from `root` down to the node at `path`.
function nodesAlong(root: YAMLMap, path: (string | number)[]): unknown[] {
  const nodes: unknown[] = [];
  let at: unknown = root;
  for (const key of path) {
    const item = isMap(at) ? at.items.find((p) => keyOf(p as Pair) === key) : isSeq(at) ? at.items[key as number] : undefined;
    if (item === undefined) break;
    nodes.push(item);
    at = isPair(item) ? item.value : item;
    if (isPair(item)) nodes.push(at);
  }
  return nodes;
}

// A key of a block step as the file has it, before the edit.
interface KeyBefore {
  pair: Pair;
  key: string | undefined;
  value: unknown;
  // A list's items, before the edit changes them in place.
  items?: unknown[];
}

// A changed block list of a block step's key (gates, produces and so on)
// that stays that list: only its new and changed items are rendered again,
// at the column of its dashes, a changed one between its comment lines; the
// others keep their bytes, with the comment lines above them, and a removed
// one's lines go, with those comment lines but for the first item's. null when the list is not laid out so (each dash starting
// a line, all at one column), or when the edit replaced the list; the whole
// key is then rendered.
function listSplice(src: Source, w: Writer, pair: Pair, b: KeyBefore, value: unknown, indentSeq: boolean): Splice | null {
  const { text } = src;
  const seq = pair.value;
  const before = b.items;
  if (!isSeq(seq) || seq !== b.value || seq.flow || !before?.length || !Array.isArray(value) || seq.items.length === 0) return null;
  const tokens = itemTokens(seq);
  if (!tokens || tokens.length !== before.length) return null;
  const old: { head: number; start: number; end: number; next: number }[] = [];
  let col = -1;
  for (let i = 0; i < before.length; i++) {
    const dashAt = tokens[i].start.find((t) => t.type === "seq-item-ind")?.offset;
    if (dashAt === undefined || !(before[i] as { range?: Range }).range) return null;
    const start = lineStartOf(text, dashAt);
    if (text.slice(start, dashAt).trim() || (col >= 0 && dashAt - start !== col)) return null;
    col = dashAt - start;
    // The comment lines above the first item are the list's, as yaml reads
    // them: they stay where they are.
    old.push({ head: i === 0 ? start : headStart(text, start, col), start, end: contentEnd(text, before[i]), next: 0 });
  }
  old.forEach((o, i) => (o.next = i + 1 < old.length ? old[i + 1].head : o.end));
  const withNewline = (t: string) => (t.endsWith("\n") ? t : `${t}\n`);
  const insert = seq.items
    .map((item, j) => {
      const i = before.indexOf(item);
      // A new item, or one the edit moved here from another list, with its
      // comments.
      if (i < 0) return `${render(src, w, item, col, indentSeq, isNode(item) ? (item.commentBefore ?? undefined) : undefined)}\n`;
      const o = old[i];
      if (deepEqual(w.dataOf(item), value[j])) return withNewline(text.slice(o.head, o.next));
      return withNewline(`${text.slice(o.head, o.start)}${render(src, w, item, col, indentSeq)}\n${text.slice(o.end, o.next)}`);
    })
    .join("");
  return { start: old[0].head, end: old[old.length - 1].end, insert };
}

// A changed step's text, from its comment lines to the next step's, with
// only the keys that changed rendered again, at the column of its keys:
// a changed key from its key to the end of its value, a removed key's lines
// taken out (comment lines above it stay), a new key before the next key
// that stays, with that key's comment lines, or after the step's last line.
// Every other key keeps its bytes, layout included. null when the step's
// keys are not laid out so (all at one column, each starting a line but the
// first, which may follow the dash), or when the edit would need the dash
// line itself rewritten or kept keys reordered; the whole step is then
// rendered.
function stepKeySplices(src: Source, w: Writer, node: unknown, before: KeyBefore[], value: unknown, l: StepLines, dirty: WeakSet<object>, indentSeq: boolean): string | null {
  const { text } = src;
  if (!isMap(node) || node.flow || !isObj(value) || before.length === 0) return null;
  const info: (KeyBefore & { key: string; at: number; lineStart: number; col: number; starts: boolean; end: number })[] = [];
  for (const b of before) {
    const key = b.pair.key;
    if (!isScalar(key) || !key.range || b.key === undefined) return null;
    const at = key.range[0];
    const lineStart = lineStartOf(text, at);
    const valueNode = isNode(b.value) && b.value.range ? b.value : key;
    info.push({ ...b, key: b.key, at, lineStart, col: at - lineStart, starts: !text.slice(lineStart, at).trim(), end: contentEnd(text, valueNode) });
  }
  const col = info[0].col;
  if (info.some((k, i) => k.col !== col || (i > 0 && !k.starts))) return null;
  const onDash = !info[0].starts;
  const index = new Map(before.map((b, i) => [b.pair as object, i]));
  const pairs = node.items as Pair[];
  const splices: Splice[] = [];
  const kept = new Set<number>();
  let last = -1;
  for (const pair of pairs) {
    const i = index.get(pair);
    if (i === undefined) continue;
    if (i < last) return null;
    last = i;
    kept.add(i);
    const k = info[i];
    const key = keyOf(pair);
    if (key !== undefined && key === k.key && !dirty.has(pair) && deepEqual(w.dataOf(k.value), value[key])) continue;
    const list = key !== undefined && key === k.key && !dirty.has(pair) ? listSplice(src, w, pair, k, value[key], indentSeq) : null;
    splices.push(list ?? { start: k.at, end: k.end, insert: `${render(src, w, pair, col, indentSeq).slice(col)}\n` });
  }
  for (let i = 0; i < info.length; i++) {
    if (kept.has(i)) continue;
    if (i === 0 && onDash) return null;
    splices.push({ start: info[i].lineStart, end: info[i].end, insert: "" });
  }
  for (let j = 0; j < pairs.length; j++) {
    if (index.has(pairs[j])) continue;
    const next = pairs.slice(j + 1).find((p) => index.has(p));
    const n = next ? index.get(next)! : undefined;
    if (n === 0 && onDash) return null;
    const at = n !== undefined ? headStart(text, info[n].lineStart, col) : l.end;
    splices.push({ start: at, end: at, insert: `${render(src, w, pairs[j], col, indentSeq)}\n` });
  }
  return applySplices(
    text.slice(l.head, l.next),
    splices.map((s) => ({ ...s, start: s.start - l.head, end: s.end - l.head })),
  );
}

// The writer, end to end: the new text for `after`, the model's data.
// `byKey`: a changed step written as a block mapping has only its changed
// keys rendered again (stepKeySplices); off, the whole step is.
function writeData(src: Source, after: Obj, styles: StyleHint[], byKey: boolean): string {
  const { text, doc } = src;
  const root = doc.contents;
  if (!isMap(root) || root.flow) fail("the workflow must be a block mapping at the top level to be edited");
  const w = new Writer(src);
  const pairs = root.items as Pair[];
  const keys = Object.keys(after);
  const stepsPair = findPair(root, "steps");
  const stepsSeq = stepsPair && isSeq(stepsPair.value) && !stepsPair.value.flow && stepsPair.value.items.length > 0 ? stepsPair.value : undefined;
  const byStep = stepsSeq !== undefined && Array.isArray(after.steps) && after.steps.length > 0;
  // Lists are indented under their key as the steps are, `steps:\n  - id: a`.
  const indentSeq = stepsSeq ? columnOf(text, (stepsSeq.items[0] as { range: Range }).range[0]) > 0 : true;

  // The top-level keys: kept, changed, removed or new. With steps written as
  // a block list, each step is a part of its own.
  const changed = new Set<object>();
  const kept = new Map<string, Pair>();
  for (const pair of pairs) {
    const key = keyOf(pair);
    if (key !== undefined && Object.hasOwn(after, key)) kept.set(key, pair);
  }
  const removedPairs = pairs.filter((p) => !kept.has(keyOf(p) ?? "\0"));
  // Each pair's value as the file has it, for its lines once it has changed.
  const valueBefore = new Map(pairs.map((p) => [p, p.value]));
  const linesOf = (pair: Pair) => pairLines(text, pair, valueBefore.get(pair));
  let stepPlan: Match[] = [];
  let oldSteps: unknown[] = [];
  for (const [key, pair] of kept) {
    if (byStep && pair === stepsPair) continue;
    if (deepEqual(w.dataOf(pair.value), after[key])) continue;
    pair.value = w.reconcile(pair.value, after[key], false);
    changed.add(pair);
  }
  // Each block step's keys as the file has them, before the edit, and the
  // keys whose text an alias copy or a style change makes stale.
  const stepPairsBefore = new Map<object, KeyBefore[]>();
  const dirtyPairs = new WeakSet<object>();
  // Steps that must be rendered whole: a style change moved comments from
  // inside a key's lines to above it.
  const wholeSteps = new WeakSet<object>();
  if (byStep && stepsSeq) {
    for (const item of stepsSeq.items) {
      if (isMap(item) && !item.flow) stepPairsBefore.set(item, (item.items as Pair[]).map((pair) => ({ pair, key: keyOf(pair), value: pair.value, items: isSeq(pair.value) ? [...pair.value.items] : undefined })));
    }
    oldSteps = stepsSeq.items;
    const newSteps = after.steps as unknown[];
    stepPlan = matchItems(oldSteps.map((s) => w.dataOf(s)), newSteps);
    stepsSeq.items = newSteps.map((value, i) => {
      const match = stepPlan[i];
      if (!match) {
        const node = w.create(value, false);
        changed.add(node as object);
        return node;
      }
      if (match.same) return oldSteps[match.from];
      const node = w.reconcile(oldSteps[match.from], value, false);
      changed.add(node as object);
      return node;
    }) as typeof stepsSeq.items;
  }
  const newPairs = keys.filter((k) => !kept.has(k)).map((k) => new Pair(new Scalar(k), w.create(after[k], false)));
  (root.items as Pair[]) = keys.map((k) => kept.get(k) ?? newPairs.find((p) => keyOf(p) === k)!);
  w.reuseRemoved();

  // The part of the file a node is in: a top-level pair, or a step.
  const partOf = (path: readonly unknown[]): object | undefined => {
    const pair = path[2];
    if (!isPair(pair)) return undefined;
    if (byStep && pair === stepsPair) return path[4] as object | undefined;
    return pair;
  };
  const touchPath = (path: readonly unknown[]) => {
    for (const node of path) if (isCollection(node)) w.touched.add(node);
  };

  // An alias whose anchor changed, moved after it or went away stands for
  // what it stood for before: it becomes a copy of the node it named.
  visit(doc, {
    Alias(_key, node, path) {
      const before = src.aliases.get(node);
      if (!before || deepEqual(toData(doc, node.resolve(doc)), before.data)) return undefined;
      const copy = isNode(before.node) ? before.node.clone() : new Scalar(before.data);
      // The copy names no anchor; aliases inside it were already copied out
      // when the file was read (see readSource).
      visit(copy as never, {
        Node(_k, n) {
          if (!isAlias(n)) n.anchor = undefined;
        },
      });
      touchPath(path);
      if (byStep && path[2] === stepsPair && isPair(path[5])) dirtyPairs.add(path[5]);
      const part = partOf(path);
      if (part) changed.add(part);
      return copy as never;
    },
  });

  // The styles the edit asks for. A block scalar cannot be written inside a
  // flow collection. Comments between a key and its value cannot stay between
  // the key and a block's header: the one on the key's line joins the
  // header's comment, the others go above the key.
  for (const { path, type, strict } of styles) {
    const nodes = nodesAlong(root, path);
    const node = nodes[nodes.length - 1];
    const pair = nodes[nodes.length - 2];
    if (!isScalar(node) || node.type === type) continue;
    if (nodes.some((n) => isCollection(n) && n.flow)) {
      if (!strict) continue;
      fail(`step ${path[1]} is written as a flow mapping ({ ... }), or inside one, where its ${path[path.length - 1]} cannot be a block; write the step as a block mapping to make this edit`);
    }
    node.type = type;
    if (isPair(pair) && isScalar(pair.key)) {
      const key = pair.key;
      const before = node.commentBefore?.split("\n") ?? [];
      const keyEnd = key.range?.[1];
      const firstOnKeyLine = keyEnd !== undefined && /^[ \t]*:[ \t]*#/.test(text.slice(keyEnd, lineEndOf(text, keyEnd)));
      const onKeyLine = [key.comment, firstOnKeyLine ? before.shift() : undefined];
      const header = [...onKeyLine, node.comment].filter((c): c is string => !!c?.trim()).map((c) => c.trim());
      node.comment = header.length ? ` ${header.join(" # ")}` : undefined;
      key.comment = undefined;
      node.commentBefore = undefined;
      if (before.length) {
        key.commentBefore = [key.commentBefore, ...before].filter((c) => c !== undefined).join("\n");
        if (byStep && nodes[0] === stepsPair && isMap(nodes[2])) wholeSteps.add(nodes[2]);
      }
    }
    touchPath(nodes);
    if (byStep && nodes[0] === stepsPair && isPair(nodes[3])) dirtyPairs.add(nodes[3]);
    const part = partOf([doc, root, ...nodes]);
    if (part) changed.add(part);
  }

  const splices: Splice[] = [];

  for (const pair of removedPairs) {
    const lines = linesOf(pair);
    splices.push({ start: lines.head, end: lines.end, insert: "" });
  }
  for (const pair of kept.values()) {
    if (!changed.has(pair)) continue;
    const lines = linesOf(pair);
    splices.push({ start: lines.start, end: lines.end, insert: `${render(src, w, pair, 0, indentSeq)}\n` });
  }
  for (const pair of newPairs) {
    // Before the next key that was already there, with its comments; or last.
    const nextKey = keys.slice(keys.indexOf(keyOf(pair)!) + 1).find((k) => kept.has(k));
    const rendered = `${render(src, w, pair, 0, indentSeq)}\n`;
    if (nextKey) {
      const at = linesOf(kept.get(nextKey)!).head;
      splices.push({ start: at, end: at, insert: rendered });
    } else {
      const end = text.length;
      splices.push({ start: end, end, insert: text.endsWith("\n") || end === 0 ? rendered : `\n${rendered}` });
    }
  }

  if (byStep && stepsSeq) {
    // The steps' lines are found only when a step changed, so a step layout
    // that cannot be edited does not stop edits elsewhere in the file.
    const anyChange = stepsSeq.items.some((node, i) => changed.has(node as object) || !stepPlan[i] || stepPlan[i]!.from !== i) || stepPlan.length !== oldSteps.length;
    if (anyChange) {
      const regionEnd = blockEnd(text, stepsSeq);
      const lines = stepLines(text, stepsSeq, oldSteps, regionEnd);
      const shift = lines[0].dash;
      const withNewline = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
      let region = "";
      stepsSeq.items.forEach((node, i) => {
        const match = stepPlan[i];
        if (!match) {
          region += `${render(src, w, node, shift, indentSeq)}\n`;
          return;
        }
        const l = lines[match.from];
        if (!changed.has(node as object)) region += withNewline(text.slice(l.head, l.next));
        else {
          const before = node === oldSteps[match.from] ? stepPairsBefore.get(node as object) : undefined;
          const keys = byKey && before && !wholeSteps.has(node as object) ? stepKeySplices(src, w, node, before, (after.steps as unknown[])[i], l, dirtyPairs, indentSeq) : null;
          region += withNewline(keys ?? text.slice(l.head, l.start) + render(src, w, node, shift, indentSeq, l.between) + "\n" + text.slice(l.end, l.next));
        }
      });
      if (!text.slice(lines[0].head, regionEnd).endsWith("\n")) region = region.replace(/\n$/, "");
      splices.push({ start: lines[0].head, end: regionEnd, insert: region });
    }
  }
  return applySplices(text, splices);
}

// ---------------------------------------------------------------------------
// The safety net

// The written text must parse and mean exactly the model's data; otherwise
// nothing is written. applyEdit runs it on every edit; it is exported for its
// own tests.
export function verifyEdit(out: string, expected: unknown): void {
  const doc = YAML.parseDocument(out);
  if (doc.errors.length) fail(`internal error: this edit would make the file invalid YAML (${doc.errors[0].message}), so it was not applied`);
  const got = doc.toJS({ maxAliasCount: -1 });
  const at = firstDifference(got, expected);
  if (at !== null) fail(`internal error: this edit would also change ${at}, so it was not applied`);
}

// ---------------------------------------------------------------------------
// Dispatch

// Whether the node at `path` is inside a flow collection, where a block
// scalar cannot be written.
function inFlowAt(doc: Document, path: (string | number)[]): boolean {
  const root = doc.contents;
  if (!isMap(root)) return false;
  return !!root.flow || nodesAlong(root, path).some((n) => isCollection(n) && !!n.flow);
}

// Whether a step's instruction can be written as a block scalar (> or |):
// not when the step is written in braces or its list in brackets.
export function instructionTakesBlock(text: string, step: number): boolean {
  const doc = YAML.parseDocument(text);
  return !doc.errors.length && !inFlowAt(doc, ["steps", step, "instruction"]);
}

export function applyEdit(text: string, edit: Edit): string {
  const src = readSource(text);
  const before = src.doc.toJS({ maxAliasCount: -1 });
  const styleAt = (path: (string | number)[]) => {
    const node = src.doc.getIn(path, true);
    return isScalar(node) ? node.type : undefined;
  };
  const { data, styles } = editModel(before, edit, styleAt, (path) => inFlowAt(src.doc, path));
  if (deepEqual(before, data) && styles.every((s) => styleAt(s.path) === s.type)) return text;
  // A changed step has only its changed keys written again. Should that text
  // not mean the model's data, or the step not be laid out for it, the step
  // is written whole, from the file read afresh, as the writer did before.
  try {
    const out = writeData(src, data, styles, true);
    verifyEdit(out, data);
    return out;
  } catch (e) {
    if (!(e instanceof EditError)) throw e;
    const out = writeData(readSource(text), data, styles, false);
    verifyEdit(out, data);
    return out;
  }
}
