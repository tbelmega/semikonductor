// SPDX-License-Identifier: Apache-2.0
// Field tooltip text, read from the schemas' `.meta({ description })` at
// build time rather than copied into Komposer. Each
// description ends with an "Engine effect:" sentence; we split on it.

import type { ZodType } from "zod";
import { ArtifactSchema, StepSchema } from "../../flow/src/schemas/step.ts";
import { WorkflowSchema } from "../../flow/src/schemas/workflow.ts";
import { GateSchema } from "../../flow/src/schemas/gate.ts";

export interface FieldDoc {
  yamlKey: string;
  required: boolean;
  description: string;
  engineEffect?: string;
  // A tooltip that leaves out the YAML key line, for a field whose label
  // already names it.
  hideKey?: boolean;
  // Terms explained one per line below the description, each term in bold.
  terms?: { term: string; text: string }[];
}

function split(description: string): { description: string; engineEffect?: string } {
  const marker = "Engine effect:";
  const idx = description.indexOf(marker);
  if (idx < 0) return { description };
  return { description: description.slice(0, idx).trim(), engineEffect: description.slice(idx + marker.length).trim() };
}

function doc(yamlKey: string, required: boolean, schema: ZodType): FieldDoc {
  const { description = "" } = (schema.meta?.() ?? {}) as { description?: string };
  return { yamlKey, required, ...split(description) };
}

// WorkflowSchema is a refined (superRefine) schema; the base object schema's
// shape lives on its inner type.
const wfShape =
  (WorkflowSchema.def as unknown as { innerType?: { shape: Record<string, ZodType> } }).innerType?.shape ??
  (WorkflowSchema as unknown as { shape: Record<string, ZodType> }).shape;
const stepShape = StepSchema.shape;
const artifactShape = ArtifactSchema.shape;

export const DOCS: Record<string, FieldDoc> = {
  wfName: doc("name", true, wfShape.name),
  wfDescription: doc("description", false, wfShape.description),
  wfInputs: doc("inputs", false, wfShape.inputs),
  wfHandsOffTo: doc("hands_off_to", false, wfShape.hands_off_to),
  version: doc("version: 1", true, wfShape.version),
  id: doc("id", true, stepShape.id),
  title: doc("title", false, stepShape.title),
  description: doc("description", false, stepShape.description),
  phase: doc("phase", false, stepShape.phase),
  // The Autonomy Mode field says what the owner can expect, in Komposer's
  // own words: the schema's description, with its engine effect, is written
  // for the engine and is too long for this tooltip.
  mode: {
    yamlKey: "mode",
    required: false,
    hideKey: true,
    description: "What the agent expects of the owner's availability for questions and decisions.",
    terms: [
      { term: "Attended", text: "The agent may stop often to ask the owner for input." },
      {
        term: "Unattended",
        text:
          "The agent tries to finish the step without asking. It makes judgement calls, records them, " +
          "and presents them for the owner's review and approval later.",
      },
    ],
  },
  instruction: doc("instruction", true, stepShape.instruction),
  condition: doc("condition", false, stepShape.condition),
  consumes: doc("consumes", false, stepShape.consumes),
  // The schema's text explains both reference forms for authors; the
  // inspector shows the list read-only.
  guides: {
    yamlKey: "guides",
    required: false,
    description: "Files the instruction tells the agent to use. Komposer shows them; change them in the workflow file.",
  },
  produces: doc("produces", false, stepShape.produces),
  optional_produces: doc("optional_produces", false, stepShape.optional_produces),
  updates: doc("updates", false, stepShape.updates),
  gates: doc("gates", false, stepShape.gates),
  artifact: doc("artifact", true, artifactShape.artifact),
  path: doc("path", true, artifactShape.path),
  artDescription: doc("description", false, artifactShape.description),
};

// Gate-kind docs: GateSchema is a union of per-kind mapping shapes (plus a
// string form); we pull each kind's text-field description from the first
// mapping option that has it.
type ShapeHolder = { def?: { shape?: Record<string, ZodType> } };

function gateUnionOptions(): ShapeHolder[] {
  return (GateSchema.def as unknown as { options: ShapeHolder[] }).options;
}

function fieldFromGateUnion(key: string, required: boolean): FieldDoc {
  for (const option of gateUnionOptions()) {
    const field = option.def?.shape?.[key];
    if (field) return doc(key, required, field);
  }
  return { yamlKey: key, required, description: "" };
}

export const GATE_KIND_DOCS: Record<"owner-action" | "check" | "script" | "agent" | "workflow", FieldDoc> = {
  "owner-action": fieldFromGateUnion("owner-action", true),
  check: fieldFromGateUnion("check", true),
  script: fieldFromGateUnion("script", true),
  agent: fieldFromGateUnion("agent", true),
  workflow: fieldFromGateUnion("workflow", true),
};

export const GATE_FIELD_DOCS = {
  maxRounds: fieldFromGateUnion("max_rounds", false),
  guide: fieldFromGateUnion("guide", false),
  routeBack: fieldFromGateUnion("route_back_to", false),
  gateDescription: fieldFromGateUnion("description", false),
  slug: fieldFromGateUnion("slug", false),
  inputs: fieldFromGateUnion("inputs", false),
  returns: fieldFromGateUnion("returns", false),
  // A workflow gate's per-item and outcome settings, in Komposer's own words:
  // the schema's descriptions are written for the engine (rule 5).
  forEach: komposerDoc("for_each", "One child workstream per file in the chosen folder, each given its own file."),
  accept: komposerDoc("accept", "What lets the step complete: all children completed, failed or not, or all children successful."),
  rerun: komposerDoc("rerun", "Which items get a new child when the owner sends the work back; the others are carried over."),
  rerunOverride: komposerDoc("rerun_override", "Whether the owner can name the items that get a new child on a send-back."),
  retries: komposerDoc("retries", "How many times failed items get a new child by themselves, with the previous attempt's documents."),
  // A loop gate's settings, in Komposer's own words (rule 5).
  repeatFrom: komposerDoc(
    "repeat_from",
    "Makes this a **loop gate**: while it does not pass, the steps from the chosen one to this one run again, without asking the owner.",
  ),
  interval: komposerDoc("interval", "About how long the agent waits before each new cycle, such as 15m or 2h."),
  maxCycles: komposerDoc("max_cycles", "How many cycles the loop may run before the owner decides; no limit when empty."),
};

function komposerDoc(yamlKey: string, description: string): FieldDoc {
  return { yamlKey, required: false, description };
}
