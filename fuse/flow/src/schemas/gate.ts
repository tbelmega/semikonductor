// SPDX-License-Identifier: Apache-2.0
// The schema of a gate, what must hold before a step counts as done, and of a
// condition, which says when an optional step runs. Both are written the same
// way. `bun run schema` writes the gate schema to gate.schema.json.

import { z } from "zod";
import { idRecord } from "./id-record.ts";

export const GATE_KINDS = ["owner-action", "check", "script", "agent", "workflow"] as const;
export type GateKind = (typeof GATE_KINDS)[number];

// `text` is what the gate says: the owner's action, the kind of check, the
// command, what the agent reviews, or the workflow a child workstream
// follows. max_rounds and guide are set on agent gates only; max_rounds is
// undefined when the workflow does not set it, so policy can fill it in.
// slug, inputs, returns and for_each are set on workflow gates only: the
// child's slug template, its inputs (child input id -> parent artifact id),
// the documents it returns (parent id -> child id), and the folder artifact
// whose files the step waits for one child each. accept says whether a child
// that ended as failed passes the gate; rerun, rerun_override and retries say
// which items of a for_each gate get a new child after a send-back, whether
// the owner may choose them, and how many passes the engine opens on its own
// for failed items. route_back_to lists the steps to suggest sending the work
// back to.
export type Gate = {
  kind: GateKind;
  text: string;
  description?: string;
  max_rounds?: number;
  guide?: string;
  slug?: string;
  inputs?: Record<string, string>;
  returns?: Record<string, string>;
  for_each?: string;
  accept?: "finished" | "succeeded";
  rerun?: "all" | "failed";
  rerun_override?: boolean;
  retries?: number;
  route_back_to: string[];
};

// The slug a workflow gate gives its child unless it says otherwise, and the
// one it gives each child of a `for_each` gate.
export const DEFAULT_CHILD_SLUG = "{slug}-{step}";
export const DEFAULT_CHILD_SLUG_PER_ITEM = "{slug}-{step}-{item}";

// A condition is a gate without the fields that only make sense on a gate.
// `description` is for the reader only; the engine never reads it.
export type Condition = { kind: GateKind; text: string; description?: string };

export const STEP_ID = z.string().regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and hyphens");
const isStepId = (v: unknown): v is string => STEP_ID.safeParse(v).success;

// A kind of check names what to run, not how: a single lower-case word that
// the project's policy binds to a command, so that one workflow runs in
// projects that build and test in different ways.
export const CHECK_KIND = /^[a-z][a-z0-9]*$/;

// How many review rounds that end with a required fix an agent gate allows,
// unless the workflow or policy sets its own max_rounds. Konductor's default.
export const DEFAULT_MAX_ROUNDS = 2;

const isKind = (k: string): k is GateKind => (GATE_KINDS as readonly string[]).includes(k);

const HINT =
  'must be one of owner-action, check, script, agent or workflow, as a one-key mapping such as ' +
  '`owner-action: approve` or a string such as `script("bun run check")`';

const ID = /^[a-z0-9][a-z0-9-]*$/;

// An id map written as a list of ids (each maps to itself) or as a mapping of
// ids, or why it is refused.
function idMap(field: string, v: unknown, listAllowed: boolean): Record<string, string> | string {
  const pairs: [unknown, unknown][] = Array.isArray(v) && listAllowed ? v.map((id) => [id, id]) : v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : [];
  if (pairs.length === 0) {
    return `${field} is ${listAllowed ? "a list of artifact ids or a mapping" : "a mapping"} of artifact ids; got ${JSON.stringify(v)}`;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of pairs) {
    if (typeof key !== "string" || !ID.test(key) || typeof value !== "string" || !ID.test(value)) {
      return `${field} names artifact ids, lowercase letters, digits and hyphens; got ${JSON.stringify(v)}`;
    }
    out[key] = value;
  }
  return out;
}

// Why one written gate or condition is refused, or the gate it stands for.
// `asCondition` refuses the fields only a gate may carry.
function parseGate(v: unknown, asCondition: boolean): Gate | string {
  let kind: string;
  let text: unknown;
  let extra: Record<string, unknown> = {};
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const { max_rounds, guide, description, route_back_to, slug, inputs, returns, for_each, accept, rerun, rerun_override, retries, ...rest } = v as Record<string, unknown>;
    extra = { max_rounds, guide, description, route_back_to, slug, inputs, returns, for_each, accept, rerun, rerun_override, retries };
    const entries = Object.entries(rest);
    if (entries.length !== 1) return `${HINT}; got ${JSON.stringify(v)}`;
    [kind, text] = entries[0];
  } else if (typeof v === "string") {
    const s = v.trim();
    if (s === "owner") return 'the legacy gate `owner` is no longer accepted; write `owner-action: approve`';
    if (s === "none") return "the legacy gate `none` is no longer accepted; leave the gate out";
    const m = /^([a-z-]+)\s*(?:\(\s*"?(.*?)"?\s*\)|:(.*))$/s.exec(s);
    if (!m) return `${HINT}; got ${JSON.stringify(v)}`;
    kind = m[1];
    text = m[2] ?? m[3];
  } else {
    return `${HINT}; got ${JSON.stringify(v)}`;
  }

  if (!isKind(kind)) return `${HINT}; got ${JSON.stringify(v)}`;
  if (typeof text !== "string" || !text.trim()) return `${kind} needs a text; got ${JSON.stringify(v)}`;
  const trimmed = text.trim();
  if (kind === "check" && !CHECK_KIND.test(trimmed)) {
    return `check names a kind of check, a single lower-case word such as default; for a command use \`script: ${trimmed}\``;
  }
  const { max_rounds: maxRounds, guide, description, route_back_to: routeBackTo, slug, inputs, returns, for_each: forEach, accept, rerun, rerun_override: rerunOverride, retries } = extra;
  if (description !== undefined && typeof description !== "string") return "description must be text";
  if (asCondition) {
    if (kind === "workflow") return "a condition cannot be a workflow; a workflow gate goes under gates";
    for (const field of ["max_rounds", "guide", "route_back_to", "slug", "inputs", "returns", "for_each", "accept", "rerun", "rerun_override", "retries"] as const) {
      if (extra[field] !== undefined) return `a condition has no ${field}`;
    }
    return { kind, text: trimmed, ...(description !== undefined ? { description: description as string } : {}), route_back_to: [] };
  }
  const routes = routeBackTo === undefined ? [] : Array.isArray(routeBackTo) ? routeBackTo : [routeBackTo];
  if (!routes.every(isStepId)) return `route_back_to names step ids; got ${JSON.stringify(routeBackTo)}`;
  if (maxRounds !== undefined && kind !== "agent") return "max_rounds goes on an agent gate only";
  if (maxRounds !== undefined && (!Number.isInteger(maxRounds) || (maxRounds as number) < 1)) {
    return `max_rounds must be a whole number, 1 or more; got ${JSON.stringify(maxRounds)}`;
  }
  if (guide !== undefined && kind !== "agent") return "guide goes on an agent gate only";
  if (guide !== undefined && (typeof guide !== "string" || !guide.trim())) return "guide must be a path";
  for (const field of ["slug", "inputs", "returns", "for_each", "accept", "rerun", "rerun_override", "retries"] as const) {
    if (extra[field] !== undefined && kind !== "workflow") return `${field} goes on a workflow gate only`;
  }
  const gate: Gate = { kind, text: trimmed, route_back_to: routes };
  if (description !== undefined) gate.description = description as string;
  if (maxRounds !== undefined) gate.max_rounds = maxRounds as number;
  if (guide !== undefined) gate.guide = (guide as string).trim();
  if (forEach !== undefined) {
    if (typeof forEach !== "string" || !ID.test(forEach)) return `for_each names an artifact id, lowercase letters, digits and hyphens; got ${JSON.stringify(forEach)}`;
    gate.for_each = forEach;
  }
  if (accept !== undefined) {
    if (accept !== "finished" && accept !== "succeeded") return `accept is finished or succeeded; got ${JSON.stringify(accept)}`;
    gate.accept = accept;
  }
  // rerun, rerun_override and retries decide which items get a new child, so
  // they mean nothing without items.
  for (const [field, value] of [["rerun", rerun], ["rerun_override", rerunOverride], ["retries", retries]] as const) {
    if (value !== undefined && forEach === undefined) return `${field} needs for_each on the gate`;
  }
  if (rerun !== undefined) {
    if (rerun !== "all" && rerun !== "failed") return `rerun is all or failed; got ${JSON.stringify(rerun)}`;
    gate.rerun = rerun;
  }
  if (rerunOverride !== undefined) {
    if (typeof rerunOverride !== "boolean") return `rerun_override is true or false; got ${JSON.stringify(rerunOverride)}`;
    gate.rerun_override = rerunOverride;
  }
  if (retries !== undefined) {
    if (!Number.isInteger(retries) || (retries as number) < 0) return `retries is a whole number, 0 or more; got ${JSON.stringify(retries)}`;
    if ((retries as number) > 0 && rerun !== "failed") return "retries needs rerun: failed; under rerun: all there is nothing to retry";
    gate.retries = retries as number;
  }
  if (slug !== undefined) {
    // {slug} keeps two parent workstreams from sharing one child; {item}
    // keeps the children of one for_each gate apart.
    const sample = typeof slug === "string" ? slug.replaceAll("{slug}", "a").replaceAll("{step}", "b").replaceAll("{item}", "c") : "";
    if (typeof slug !== "string" || !slug.includes("{slug}") || !ID.test(sample)) {
      return `slug is a template that contains {slug}, with lowercase letters, digits, hyphens, {step} and, with for_each, {item}; got ${JSON.stringify(slug)}`;
    }
    if (slug === "{slug}") return "slug must add to {slug}, such as {slug}-review, or the child would take the parent's own slug";
    if (forEach !== undefined && !slug.includes("{item}")) return "slug must contain {item} when the gate has for_each, so each child gets a slug of its own";
    if (forEach === undefined && slug.includes("{item}")) return "{item} in slug needs for_each on the gate";
    gate.slug = slug;
  }
  if (inputs !== undefined) {
    const map = idMap("inputs", inputs, false);
    if (typeof map === "string") return map;
    gate.inputs = map;
  }
  if (returns !== undefined) {
    const map = idMap("returns", returns, true);
    if (typeof map === "string") return map;
    gate.returns = map;
  }
  return gate;
}

const KIND_DOCS: Record<GateKind, string> = {
  "owner-action":
    "The owner does what this text says, for example approve the design. Engine effect: the step waits for the " +
    "owner (AWAITING_OWNER) when it is continued, until `fuse-flow continue <slug> --owner-approved`.",
  check:
    "A kind of check, a single lower-case word such as `default`, which the project's policy binds to a command " +
    "(checks: { default: bun run check }). Engine effect: the bound command runs from the repository root when " +
    "the step is continued, and `continue` is refused unless it exits 0. An unbound kind refuses the step and " +
    "tells the agent to find the command and record it; a kind bound to `none` passes.",
  script:
    "A shell command, run from the repository root when the step is continued. Engine effect: `continue` is " +
    "refused unless the command exits 0.",
  agent:
    "What an independent agent reviews. The agent that did the work classifies each finding as a required fix " +
    "(P0 or P1, unless the review guide says otherwise), optional (P2 or P3, fixed when cheap or deferred) or a " +
    "false positive, fixes what is required, and they repeat until a round ends with no required fix, or as the " +
    "review guide says; fixing optional findings after that round starts no further round. Engine effect: the text, the review guide and the round cap are printed with the " +
    "step, and the agent that did the work counts the rounds; `continue` is refused until the reviewer has written a findings file " +
    "in the step's current pass, unless the review was accepted or `--waived` records that the owner waived it.",
  workflow:
    "The workflow a child workstream follows, by name or by a path relative to this workflow file: the step " +
    "waits for that procedure. Engine effect: when the step is handed out, fuse-flow creates the child " +
    "workstream with its inputs bound from this workstream's documents, and `continue` is refused until the " +
    "child is complete. After a send-back, the next pass gets a fresh child. With `for_each: <folder artifact>`, " +
    "the step waits for one child per file of that folder, each given its own file, and `continue` is refused " +
    "until every child is complete.",
};

const DESCRIPTION = z.string().optional().meta({
  description: "What the gate is for, in free text, for the reader. Engine effect: none.",
});

const ROUTE_BACK_TO = z
  .union([STEP_ID, z.array(STEP_ID)])
  .optional()
  .meta({
    description:
      "The steps the work should go back to when this gate cannot be passed: one step id or a list, each " +
      "this step or one before it. Usually the step that produces the artifact the gate finds fault with. " +
      "Engine effect: when the step awaits the owner or is blocked, fuse-flow suggests these steps for " +
      "`--back-to`, and the viewer draws them as routes back.",
    examples: ["design", ["design", "spec"]],
  });

const MAX_ROUNDS = z.number().int().min(1).optional().meta({
  description:
    `How many review rounds that end with a required fix the step allows; ${DEFAULT_MAX_ROUNDS} unless the ` +
    "workflow or policy says otherwise. When the cap is reached, the agent that did the work does not start " +
    'another round; it runs `fuse-flow continue <slug> --blocked "<why>"`. Engine effect: none; fuse-flow prints ' +
    "the cap, raised by any rounds the owner granted, and does not count the rounds.",
});

const GUIDE = z.string().optional().meta({
  description:
    "A review guide for this gate, relative to the workflow file or absolute. It replaces the review guides of " +
    "the step's artifacts and decides what counts as a required fix and when a round passes. A project's policy " +
    "or its own library can replace it. Engine effect: printed with the step.",
});

// The shapes a gate may be written in. They only decide what editors offer;
// parseGate then reads the value, so a value that matches a shape but breaks a
// rule is refused there, with the reason.
const SHAPES = [
  ...(["owner-action", "check", "script"] as const).map((kind) =>
    z
      .object({ [kind]: z.string().meta({ description: KIND_DOCS[kind] }), description: DESCRIPTION, route_back_to: ROUTE_BACK_TO })
      .strict()
      .meta({ description: `The ${kind} gate as a mapping: \`${kind}: …\`, optionally with \`description\` and \`route_back_to\`.` }),
  ),
  z
    .object({
      agent: z.string().meta({ description: KIND_DOCS.agent }),
      description: DESCRIPTION,
      route_back_to: ROUTE_BACK_TO,
      max_rounds: MAX_ROUNDS,
      guide: GUIDE,
    })
    .strict()
    .meta({ description: "The agent gate as a mapping: `agent: …`, optionally with `max_rounds`, `guide`, `description` and `route_back_to`." }),
  z
    .object({
      workflow: z.string().meta({ description: KIND_DOCS.workflow }),
      slug: z.string().optional().meta({
        description:
          "The child workstream's slug, a template that contains {slug}, the parent's slug, and something more, " +
          `and may contain {step}, this step's id; ${DEFAULT_CHILD_SLUG} unless set. With for_each it must also contain ` +
          `{item}, the item's id; ${DEFAULT_CHILD_SLUG_PER_ITEM} unless set. Engine effect: the child is created under ` +
          "this slug; a later pass of the step after a send-back adds -<pass>, such as -2.",
        examples: ["{slug}-adversarial", "{slug}-unit-{item}"],
      }),
      for_each: z.string().optional().meta({
        description:
          "A folder artifact of this workflow, available before this step, whose direct files are the items: the " +
          "step waits for one child workstream per file, the item's id being the file name without its extension. " +
          "Engine effect: when the step is handed out, fuse-flow records the set of items and creates one child per " +
          "item, binding every input that names this artifact to the item's own file; `continue` is refused until " +
          "every child is complete, and later steps read what each child returned, one document per item.",
        examples: ["approved-units"],
      }),
      inputs: idRecord(z.string(), z.string()).optional().meta({
        description:
          "The documents the child is given: child input id -> artifact id in this workflow, available before " +
          "this step. Engine effect: each binds the child's declared input to this workstream's document; with " +
          "for_each, an input that names the for_each artifact is bound to the item's file.",
        examples: [{ "review-diff": "review-diff" }],
      }),
      returns: z
        .union([z.array(z.string()), idRecord(z.string(), z.string())])
        .optional()
        .meta({
          description:
            "The child's documents later steps of this workflow may consume: a list of ids, or a mapping of " +
            "id in this workflow -> id in the child, to rename one. Engine effect: a later step's `consumes` " +
            "resolves each to the newest child's recorded document, or with for_each to one document per child. " +
            "On a for_each gate, an `inputs` value that names one of these ids binds the item's previous attempt's document to the new child.",
          examples: [["adversarial-review-report"], { "system-design": "design" }],
        }),
      accept: z.enum(["finished", "succeeded"]).optional().meta({
        description:
          "What a child must reach for the step to complete: `finished` (the default), any child that ended, " +
          "whatever its outcome; or `succeeded`, every child ended as succeeded. Engine effect: under `succeeded`, " +
          "`continue` is refused while a child ended as failed, naming each with its reason, and the owner sends the " +
          "work back or skips the step. The DELEGATE line never mentions this setting.",
      }),
      rerun: z.enum(["all", "failed"]).optional().meta({
        description:
          "With for_each: which items get a new child when the step is sent back to: `all` (the default), every " +
          "item, as today; or `failed`, only the items whose child ended as failed, is missing or cannot be read. " +
          "Engine effect: an item not selected keeps its previous child, recorded again in the new pass under the " +
          "same slug, so its result stays in what later steps read, as long as that child still fits the gate: it " +
          "follows the gate's workflow, was given the documents the gate gives its item now, and was not closed " +
          "unfinished. A send-back to an earlier step gives every item a new child.",
      }),
      rerun_override: z.boolean().optional().meta({
        description:
          "With for_each: whether the owner may choose the items to re-run with `continue --back-to <this step> " +
          "--rerun <items>`; true unless set. Engine effect: when false, `--rerun` on this step is refused.",
      }),
      retries: z.number().int().min(0).optional().meta({
        description:
          "With for_each and rerun: failed: how many passes the engine opens on its own for the items whose child " +
          "ended as failed, once every child of the pass has ended; 0 unless set, which keeps today's behavior. " +
          "Engine effect: within the budget, the parent's `continue` opens the next pass itself, carries the " +
          "succeeded children over and prints the new children to run; once it is spent, the owner decides. An " +
          "owner send-back resets the count.",
      }),
      description: DESCRIPTION,
      route_back_to: ROUTE_BACK_TO,
    })
    .strict()
    .meta({
      description:
        "The workflow gate as a mapping: `workflow: <name>`, optionally with `slug`, `for_each`, `inputs`, `returns`, " +
        "`accept`, `rerun`, `rerun_override`, `retries`, `description` and `route_back_to`.",
    }),
  z.string().meta({
    description: 'As a string: `owner-action("…")`, `check: default`, `script("…")`, `agent: …` or `workflow: <name>`.',
    // For editors only: parseGate decides at run time.
    pattern: String.raw`^\s*(owner-action|check|script|agent|workflow)\s*[(:][\s\S]*$`,
  }),
] as const;

export const GateSchema = z
  .union(SHAPES)
  .meta({ id: "Gate", title: "fuse-flow gate", description: "What must hold before a step counts as done." });

// What each kind means as a condition, which decides whether an optional
// step runs; a gate's meaning (KIND_DOCS) does not apply.
const CONDITION_DOCS: Record<"owner-action" | "check" | "script" | "agent", string> = {
  "owner-action":
    "What to ask the owner before the step starts, for example whether a prototype is wanted. Engine effect: the " +
    "step block tells the agent to ask; when the owner says no, the agent skips the step with `--skip`.",
  check:
    "A kind of check that the project's policy binds to a command. Engine effect: the command runs when the engine " +
    "reaches the step; exit 0 runs the step, and any other result skips it. A kind bound to `none` runs the step; " +
    "an unbound kind holds the step until the kind is bound.",
  script:
    "A shell command. Engine effect: it runs from the repository root when the engine reaches the step; exit 0 " +
    "runs the step, and any other result skips it.",
  agent:
    "When the step applies, as the agent judges it. Engine effect: the step block tells the agent to do the step " +
    "only if this holds, and otherwise to skip it with `--skip`.",
};

// The shapes a condition may be written in, for editors: one gate kind, with
// no gate-only fields. ConditionSchema below does the reading.
export const ConditionShapeSchema = z
  .union([
    ...(["owner-action", "check", "script", "agent"] as const).map((kind) =>
      z
        .object({ [kind]: z.string().meta({ description: CONDITION_DOCS[kind] }), description: DESCRIPTION })
        .strict()
        .meta({ description: `The ${kind} condition as a mapping: \`${kind}: …\`.` }),
    ),
    z.string().meta({
      description: 'As a string: `script("…")`, `check: <kind>`, `agent: …` or `owner-action: …`.',
      pattern: String.raw`^\s*(owner-action|check|script|agent)\s*[(:][\s\S]*$`,
    }),
  ])
  .meta({ id: "Condition", title: "fuse-flow condition", description: "When an optional step runs." });

// One gate or a list, read back as a list.
export const GateListSchema = z
  .unknown()
  .optional()
  .transform((v, ctx) => {
    const items = v === undefined ? [] : Array.isArray(v) ? v : [v];
    const gates: Gate[] = [];
    items.forEach((item, i) => {
      const gate = parseGate(item, false);
      if (typeof gate === "string") ctx.addIssue({ code: "custom", path: Array.isArray(v) ? [i] : [], message: gate });
      else gates.push(gate);
    });
    return gates;
  })
  .meta({ description: "One gate or a list.", anyOf: [{ $ref: "./gate.schema.json" }, { type: "array", items: { $ref: "./gate.schema.json" } }] });

// A step's condition: when it runs. One gate kind, with no gate-only fields.
export const ConditionSchema = z
  .unknown()
  .optional()
  .transform((v, ctx): Condition | undefined => {
    if (v === undefined) return undefined;
    const parsed = parseGate(v, true);
    if (typeof parsed === "string") {
      ctx.addIssue({ code: "custom", message: parsed });
      return undefined;
    }
    return { kind: parsed.kind, text: parsed.text, ...(parsed.description !== undefined ? { description: parsed.description } : {}) };
  })
  .meta({
    description:
      "When the step runs, written like one gate: `script: <command>` or `check: <kind>` (run when the step is " +
      "reached; exit 0 runs the step, anything else skips it), `agent: <when to do the step>` (the agent judges), " +
      "or `owner-action: <the question>` (the agent asks the owner). Engine effect: a step without a condition is " +
      "mandatory; one with a condition may be skipped with `continue <slug> --skip \"<reason>\"`.",
    $ref: "./condition.schema.json",
  });
