// SPDX-License-Identifier: Apache-2.0
// Shared types for the app: a workflow as the API returns it, parsed into the
// engine's shape (or kept as raw YAML plus issues when it does not parse),
// and the per-step derived view the diagram and inspector read from.

import YAML from "yaml";
import { ConditionSchema, GateListSchema, type Gate } from "../../flow/src/schemas/gate.ts";
import type { HandOff, Workflow, WorkflowInput } from "../../flow/src/schemas/workflow.ts";
import { parseWorkflowText, type WorkflowIssue } from "../../flow/src/parse.ts";
import { resolveWorkflowRef, type UnavailableWorkflow } from "./model/workflowLinks.ts";

export type LocationId = "project" | "personal" | "fuse-flow";

// Where a listed workflow file is: one of the three locations, or "run" for
// a workflow file of another project (one in its own workflow folder, or one
// a run of it follows), which is shown read-only.
export type WorkflowLocation = LocationId | "run";

export interface SessionLocation {
  id: LocationId;
  label: string;
  path: string;
}

export interface Session {
  root: string;
  locations: SessionLocation[];
}

// One workflow file as the server lists it.
export interface WorkflowFile {
  location: WorkflowLocation;
  // For a "run" file: the project it belongs to.
  project?: string;
  dir: string;
  file: string;
  path: string;
  onDisk: boolean;
  text: string;
  hash: string;
  workingCopy?: string;
  // From the listing, for a working copy on disk: the hash of its text, and
  // the hash of the original it was made from when that is recorded.
  workingCopyHash?: string;
  workingCopyBase?: string;
  // For a file of the three locations that is a link leading outside them:
  // where it leads. It is shown read-only, since a save is refused.
  leadsTo?: string;
  // The file's real path when it differs from path (a link on the way), so
  // a reference that names the real path leads to it (workflowLinks).
  realPath?: string;
}

export const workflowKey = (workflow: Pick<WorkflowFile, "path">): string => workflow.path;

// A workflow file with its text parsed, kept alongside the raw file info so
// the list and header can show it even when parsing failed.
export interface OpenWorkflow extends WorkflowFile {
  // Stable UI-only identity. These values are never serialized.
  stepKeys: string[];
  savedSteps: { key: string; id: string }[];
  // The text actually open: the working copy's when present, else the file's.
  openText: string;
  parsed: Workflow | null;
  issues: WorkflowIssue[];
  // Best-effort structure for display when `parsed` is null: parsed as plain
  // YAML, so the list and header can still show something.
  rawWorkflow: RawWorkflowGuess;
}

// What we can show when the file fails schema validation: raw YAML read
// loosely, so steps still render as cards (missing fields default empty).
export interface RawWorkflowGuess {
  name: string;
  description?: string;
  inputs: WorkflowInput[];
  hands_off_to: HandOff[];
  steps: RawStepGuess[];
}

export interface RawStepGuess {
  id: string;
  title?: string;
  phase?: string;
  // Any value as written, so an invalid one can be shown and corrected.
  mode?: unknown;
  description?: string;
  instruction?: string;
  condition?: unknown;
  consumes: string[];
  produces: RawArtifactGuess[];
  optional_produces: RawArtifactGuess[];
  updates: RawArtifactGuess[];
  gates: unknown[];
}

export interface RawArtifactGuess {
  artifact: string;
  path?: string;
  description?: string;
}

function asArtifactArray(v: unknown): RawArtifactGuess[] {
  const items = v === undefined ? [] : Array.isArray(v) ? v : [v];
  return items
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      artifact: typeof x.artifact === "string" ? x.artifact : "",
      path: typeof x.path === "string" ? x.path : undefined,
      description: typeof x.description === "string" ? x.description : undefined,
    }));
}

export function guessRawWorkflow(text: string): RawWorkflowGuess {
  let doc: unknown;
  try {
    doc = YAML.parse(text);
  } catch {
    doc = null;
  }
  const w = doc && typeof doc === "object" ? (doc as Record<string, unknown>) : {};
  const steps = Array.isArray(w.steps) ? w.steps : [];
  const handOffs = w.hands_off_to === undefined ? [] : Array.isArray(w.hands_off_to) ? w.hands_off_to : [w.hands_off_to];
  return {
    name: typeof w.name === "string" ? w.name : "",
    description: typeof w.description === "string" ? w.description : undefined,
    inputs: (Array.isArray(w.inputs) ? w.inputs : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && typeof x.artifact === "string")
      .map((x) => ({
        artifact: x.artifact as string,
        ...(typeof x.description === "string" ? { description: x.description } : {}),
        ...(typeof x.required === "boolean" ? { required: x.required } : {}),
      })),
    hands_off_to: handOffs.flatMap((h): HandOff[] => {
      if (typeof h === "string" && h) return [{ workflow: h }];
      if (!h || typeof h !== "object" || typeof (h as Record<string, unknown>).workflow !== "string") return [];
      const { workflow, when } = h as Record<string, unknown>;
      return [{ workflow: workflow as string, ...(typeof when === "string" ? { when } : {}) }];
    }),
    steps: steps
      .filter((s): s is Record<string, unknown> => !!s && typeof s === "object")
      .map((s) => ({
        id: typeof s.id === "string" ? s.id : "",
        title: typeof s.title === "string" ? s.title : undefined,
        phase: typeof s.phase === "string" ? s.phase : undefined,
        ...("mode" in s ? { mode: s.mode } : {}),
        description: typeof s.description === "string" ? s.description : undefined,
        instruction: typeof s.instruction === "string" ? s.instruction : undefined,
        condition: s.condition,
        consumes: Array.isArray(s.consumes) ? s.consumes.filter((x): x is string => typeof x === "string") : [],
        produces: asArtifactArray(s.produces),
        optional_produces: asArtifactArray(s.optional_produces),
        updates: asArtifactArray(s.updates),
        gates: s.gates === undefined ? [] : Array.isArray(s.gates) ? s.gates : [s.gates],
      })),
  };
}

let nextStepKey = 1;
export const newStepKey = () => `step-${nextStepKey++}`;

function lcsStepMatches(saved: string[], current: string[]): Map<number, number> {
  const lengths = Array.from({ length: saved.length + 1 }, () => new Uint16Array(current.length + 1));
  for (let i = saved.length - 1; i >= 0; i--) {
    for (let j = current.length - 1; j >= 0; j--) {
      lengths[i][j] =
        saved[i] === current[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }
  const matches = new Map<number, number>();
  for (let i = 0, j = 0; i < saved.length && j < current.length; ) {
    if (saved[i] === current[j]) {
      matches.set(j++, i++);
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return matches;
}

export function openWorkflow(file: WorkflowFile | OpenWorkflow, resetIdentity = false): OpenWorkflow {
  const openText = file.workingCopy ?? file.text;
  const parsed = parseWorkflowText(openText);
  const savedIds = guessRawWorkflow(file.text).steps.map((step) => step.id);
  const currentIds = guessRawWorkflow(openText).steps.map((step) => step.id);
  const previous = !resetIdentity && "stepKeys" in file ? (file as OpenWorkflow) : undefined;
  const savedSteps = previous?.savedSteps ?? savedIds.map((id) => ({ key: newStepKey(), id }));
  const matches = lcsStepMatches(
    savedSteps.map((step) => step.id),
    currentIds,
  );
  const stepKeys =
    previous?.stepKeys ??
    currentIds.map((_id, index) => {
      const savedIndex = matches.get(index);
      return savedIndex === undefined ? newStepKey() : savedSteps[savedIndex].key;
    });
  return {
    ...file,
    stepKeys,
    savedSteps,
    openText,
    parsed: parsed.ok ? parsed.workflow : null,
    issues: parsed.ok ? [] : parsed.issues,
    rawWorkflow: guessRawWorkflow(openText),
  };
}

// The workflow as saved on disk, without its unsaved edits: what fuse-flow
// reads for the workstreams that follow it. `disk` is the file on disk when
// it changed under the edits; the edits' own base, `text`, is then older.
export function savedVersion(workflow: OpenWorkflow, disk?: { text: string; hash: string }): OpenWorkflow {
  if (disk) return openWorkflow({ ...workflow, text: disk.text, hash: disk.hash, workingCopy: undefined }, true);
  return workflow.openText === workflow.text ? workflow : openWorkflow({ ...workflow, workingCopy: undefined }, true);
}

// What saving the open text changes that a workstream in progress depends
// on: steps added, deleted, renamed or moved (fuse-flow stores progress by
// step id), and steps whose gates changed (fuse-flow takes back an owner's
// accepted review whose text or guides changed, and runs an added or
// changed gate on work already recorded before it approves it).
export function structureChanges(workflow: OpenWorkflow): string[] {
  const savedRaw = guessRawWorkflow(workflow.text).steps;
  const currentRaw = guessRawWorkflow(workflow.openText).steps;
  const current = workflow.stepKeys.map((key, index) => ({ key, id: currentRaw[index]?.id ?? "", index }));
  const out: string[] = [];
  workflow.savedSteps.forEach((saved, savedIndex) => {
    const now = current.find((step) => step.key === saved.key);
    if (!now) {
      out.push(`deleted ${saved.id}`);
      return;
    }
    if (now.id !== saved.id) out.push(`renamed ${saved.id} → ${now.id}`);
    if (JSON.stringify(savedRaw[savedIndex]?.gates ?? []) !== JSON.stringify(currentRaw[now.index]?.gates ?? []))
      out.push(`changed gates of ${now.id}`);
  });
  current
    .filter((step) => !workflow.savedSteps.some((saved) => saved.key === step.key))
    .forEach((step) => out.push(`added ${step.id}`));

  const savedCommon = workflow.savedSteps.filter((saved) => current.some((step) => step.key === saved.key));
  const currentCommon = current.filter((step) => workflow.savedSteps.some((saved) => saved.key === step.key));
  savedCommon.forEach((saved, savedRank) => {
    const currentRank = currentCommon.findIndex((step) => step.key === saved.key);
    if (currentRank === savedRank) return;
    const now = currentCommon[currentRank];
    const savedIndex = workflow.savedSteps.findIndex((step) => step.key === saved.key);
    out.push(`moved ${now.id} ${savedIndex + 1} → ${now.index + 1}`);
  });
  return out;
}

// --------------------------------------------------------------- step view

export type ArtifactRole = "produces" | "optional_produces" | "updates";

export interface ArtifactView {
  role: ArtifactRole;
  artifact: string;
  path: string;
  description?: string;
}

// A step normalized for the diagram and inspector, whether it came from a
// fully parsed workflow or a raw guess.
export interface StepView {
  id: string;
  title?: string;
  phase?: string;
  // The mode as written: absent means attended. A value that is not a string
  // is shown as YAML would print it.
  mode?: string;
  description?: string;
  instruction?: string;
  condition?: { kind: Gate["kind"]; text: string; description?: string };
  consumes: string[];
  artifacts: ArtifactView[];
  gates: Gate[];
}

export function stepViewsFromWorkflow(w: Workflow): StepView[] {
  return w.steps.map((s) => ({
    id: s.id,
    title: s.title,
    phase: s.phase,
    ...(s.mode ? { mode: s.mode } : {}),
    description: s.description,
    instruction: s.instruction,
    condition: s.condition
      ? { kind: s.condition.kind, text: s.condition.text, description: s.condition.description }
      : undefined,
    consumes: s.consumes,
    artifacts: [
      ...s.produces.map((a) => ({ role: "produces" as const, ...a })),
      ...s.optional_produces.map((a) => ({ role: "optional_produces" as const, ...a })),
      ...s.updates.map((a) => ({ role: "updates" as const, ...a })),
    ],
    gates: s.gates,
  }));
}

// An id map as a workflow gate writes it: a mapping of ids, or for returns a
// list of ids, each mapping to itself. Anything else reads as absent.
function guessIdMap(v: unknown, listAllowed: boolean): Record<string, string> | undefined {
  if (Array.isArray(v) && listAllowed) {
    const ids = v.filter((x): x is string => typeof x === "string");
    return Object.fromEntries(ids.map((id) => [id, id]));
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
}

// One gate as the engine reads it, in any form it accepts (a mapping, or a
// string such as `agent: Review.` or `script("bun test")`), or else as a
// mapping read loosely, so a gate the engine refuses for a detail (a check
// with a command, say) still shows at its position. Anything else is null.
function guessGate(raw: unknown): Gate | null {
  const engine = GateListSchema.safeParse([raw]);
  if (engine.success && engine.data.length === 1) return engine.data[0];
  return looseGate(raw);
}

// A condition as the engine reads it, or else loosely like a gate (a
// workflow gate written as a condition still shows, and the engine reports it).
function guessCondition(raw: unknown): StepView["condition"] | null {
  const engine = ConditionSchema.safeParse(raw);
  const read = engine.success && engine.data ? engine.data : looseGate(raw);
  return read ? { kind: read.kind, text: read.text, ...(read.description !== undefined ? { description: read.description } : {}) } : null;
}

function looseGate(raw: unknown): Gate | null {
  if (!raw || typeof raw !== "object") return null;
  const { max_rounds, guide, route_back_to, description, slug, inputs, returns, ...rest } = raw as Record<string, unknown>;
  const entries = Object.entries(rest).filter(([k]) => k !== "description");
  if (entries.length !== 1) return null;
  const [kind, text] = entries[0];
  if (!["owner-action", "check", "script", "agent", "workflow"].includes(kind)) return null;
  const routes =
    route_back_to === undefined
      ? []
      : Array.isArray(route_back_to)
        ? (route_back_to as string[])
        : [route_back_to as string];
  const inputMap = kind === "workflow" ? guessIdMap(inputs, false) : undefined;
  const returnMap = kind === "workflow" ? guessIdMap(returns, true) : undefined;
  return {
    kind: kind as Gate["kind"],
    text: typeof text === "string" ? text : "",
    route_back_to: routes,
    ...(typeof description === "string" ? { description } : {}),
    ...(typeof max_rounds === "number" ? { max_rounds } : {}),
    ...(typeof guide === "string" ? { guide } : {}),
    ...(kind === "workflow" && typeof slug === "string" ? { slug } : {}),
    ...(inputMap ? { inputs: inputMap } : {}),
    ...(returnMap ? { returns: returnMap } : {}),
  };
}

// An invalid mode as it is shown: a string as written, any other value as
// JSON, and a value that refers to itself through a YAML alias, which JSON
// cannot write, as YAML.
function shownMode(mode: unknown): string {
  if (typeof mode === "string") return mode;
  try {
    return JSON.stringify(mode) ?? "";
  } catch {
    return YAML.stringify(mode, { collectionStyle: "flow" }).trim();
  }
}

export function stepViewsFromRaw(w: RawWorkflowGuess): StepView[] {
  return w.steps.map((s) => {
    const cond = s.condition === undefined ? null : guessCondition(s.condition);
    return {
      id: s.id,
      title: s.title,
      phase: s.phase,
      ...("mode" in s ? { mode: shownMode(s.mode) } : {}),
      description: s.description,
      instruction: s.instruction,
      condition: cond ?? undefined,
      consumes: s.consumes,
      artifacts: [
        ...s.produces.map((a) => ({ role: "produces" as const, ...a, path: a.path ?? "" })),
        ...s.optional_produces.map((a) => ({ role: "optional_produces" as const, ...a, path: a.path ?? "" })),
        ...s.updates.map((a) => ({ role: "updates" as const, ...a, path: a.path ?? "" })),
      ],
      gates: s.gates.map(guessGate).filter((g): g is Gate => g !== null),
    };
  });
}

export function stepViews(w: OpenWorkflow): StepView[] {
  return w.parsed ? stepViewsFromWorkflow(w.parsed) : stepViewsFromRaw(w.rawWorkflow);
}

// Whether the step views of a workflow hold every step, condition, gate and
// output of its YAML, each at its position in the file, so edits addressed
// by position reach the item shown. Always so for a workflow that parses;
// for one that does not, the loose reading must have left nothing out (a
// gate or condition in no form the engine reads, an output without a path,
// a step that is not a mapping), as with a workflow whose only problem is,
// say, a consume no earlier step produces, or one artifact in two modes.
export function readsCompletely(w: OpenWorkflow): boolean {
  if (w.parsed) return true;
  let doc: unknown;
  try {
    doc = YAML.parse(w.openText);
  } catch {
    return false;
  }
  const steps = doc && typeof doc === "object" ? (doc as Record<string, unknown>).steps : undefined;
  if (!Array.isArray(steps)) return false;
  const list = (v: unknown) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const isOutput = (a: unknown) =>
    !!a && typeof a === "object" && typeof (a as Record<string, unknown>).artifact === "string" && typeof (a as Record<string, unknown>).path === "string";
  return steps.every((s) => {
    if (!s || typeof s !== "object") return false;
    const step = s as Record<string, unknown>;
    return (
      typeof step.id === "string" &&
      (step.consumes === undefined || (Array.isArray(step.consumes) && step.consumes.every((c) => typeof c === "string"))) &&
      (step.condition === undefined || guessCondition(step.condition) !== null) &&
      list(step.gates).every((g) => guessGate(g) !== null) &&
      ["produces", "optional_produces", "updates"].every((key) => list(step[key]).every(isOutput))
    );
  });
}

// The documents the workflow expects from outside, and the workflows that may
// come after it, from the parsed file or, when it does not parse, the guess.
export const workflowInputs = (w: OpenWorkflow): WorkflowInput[] => w.parsed?.inputs ?? w.rawWorkflow.inputs;
export const workflowHandOffs = (w: OpenWorkflow): HandOff[] => w.parsed?.hands_off_to ?? w.rawWorkflow.hands_off_to;

// The step's workflow gate, which delegates the step to a child workstream; a
// step has at most one.
export const delegationOf = (step: StepView): Gate | undefined => step.gates.find((g) => g.kind === "workflow");

// Where a hand-off or a workflow gate leads: the listed workflow it resolves
// to, or why it does not resolve. `projectDir` is the workflow folder of the
// project whose run the reference is read for. `unavailable` is set when it
// leads to a file or folder that cannot be read.
export type WorkflowLink = { ok: true; key: string; name: string; path: string } | { ok: false; reason: string; unavailable?: true };

export function linkTo(
  ref: string,
  from: OpenWorkflow,
  all: OpenWorkflow[],
  projectDir: string,
  unavailable: UnavailableWorkflow[] = [],
): WorkflowLink {
  const found = resolveWorkflowRef(ref, from.path, all, projectDir, unavailable);
  if (!found.ok) return { ok: false, reason: found.reason, ...(found.unavailable ? { unavailable: true as const } : {}) };
  const target = found.target;
  return { ok: true, key: workflowKey(target), name: target.parsed?.name || target.rawWorkflow.name || stem(target.file), path: target.path };
}

// Gates run the workflow gate first (its child must be complete), then checks
// and scripts, then agent, then owner. Conditions run the same order.
const GATE_ORDER: Record<Gate["kind"], number> = { workflow: -1, check: 0, script: 0, agent: 1, "owner-action": 2 };

// The Mode select's value. No mode and an explicit "attended" both select
// the attended default; any other value, the empty string included, selects
// one option of its own, so it never looks like the default. That option is
// never written: the select ignores choosing it.
export const INVALID_MODE = "invalid";
export function modeSelectValue(mode: string | undefined): string {
  if (mode === undefined || mode === "attended") return "";
  return mode === "unattended" ? mode : INVALID_MODE;
}

// The mode badge on a step card: who works in the step, drawn as the owner
// and agent glyphs of the gates, with its explanation as the tooltip. An
// attended step has the owner and the agent, an unattended one the agent
// alone; the owner alone is kept for a step that is fully manual work. No
// mode reads as attended, and an invalid mode has no glyphs and is shown as
// written.
export type ModeGlyph = "owner" | "agent";
export const ATTENDED_TIP = "Runs attended. The agent may stop often to ask you for input.";
export const UNATTENDED_TIP =
  "Runs unattended. The agent makes decisions as judgement calls during the step and presents them for your approval at the next owner gate.";
export function modeBadge(mode: string | undefined): { glyphs: ModeGlyph[]; label: string; title: string } {
  if (mode === undefined) return { glyphs: ["owner", "agent"], label: "attended", title: `${ATTENDED_TIP} This is the default.` };
  if (mode === "attended") return { glyphs: ["owner", "agent"], label: mode, title: ATTENDED_TIP };
  if (mode === "unattended") return { glyphs: ["agent"], label: mode, title: UNATTENDED_TIP };
  return { glyphs: [], label: mode, title: `Invalid mode ${mode}: a mode is attended or unattended.` };
}

export function gatesInRunOrder(gates: Gate[]): { gate: Gate; fileIndex: number }[] {
  return gates
    .map((gate, fileIndex) => ({ gate, fileIndex }))
    .sort((a, b) => GATE_ORDER[a.gate.kind] - GATE_ORDER[b.gate.kind] || a.fileIndex - b.fileIndex);
}

export const stem = (file: string) => file.replace(/\.ya?ml$/, "");

// What the workflow says it is for: its description, read from the raw YAML
// when the file fails validation. Undefined when it has none.
export const workflowDescription = (w: Pick<OpenWorkflow, "parsed" | "rawWorkflow">): string | undefined =>
  (w.parsed ? w.parsed.description : w.rawWorkflow.description)?.trim() || undefined;
export const gateCount = (steps: StepView[]) => steps.reduce((n, s) => n + s.gates.length, 0);
export const routeBackCount = (steps: StepView[]) =>
  steps.reduce((n, s) => n + s.gates.reduce((m, g) => m + g.route_back_to.length, 0), 0);
export const artifactCount = (steps: StepView[]) =>
  new Set(steps.flatMap((s) => s.artifacts.map((a) => a.artifact))).size;
