// SPDX-License-Identifier: Apache-2.0
// Komposer never restates workflow rules. The engine parses and validates the
// current text; this module only translates its issue paths/codes into UI field
// locations and Komposer's reader-facing wording.

import YAML from "yaml";
import { parseWorkflowText, type WorkflowIssue } from "../../flow/src/parse.ts";
import { ArtifactSchema } from "../../flow/src/schemas/step.ts";

export type ProblemField = "name" | "steps" | "id" | "mode" | "instr" | "cond" | "consumes" | "art" | "gate";
export interface Problem {
  stepIndex: number;
  field: ProblemField;
  itemIndex?: number;
  subfield?: "text" | "route" | "maxRounds" | "guide";
  message: string;
}

function raw(text: string): Record<string, unknown> {
  try {
    const value = YAML.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
function rawSteps(doc: Record<string, unknown>): Record<string, unknown>[] {
  return Array.isArray(doc.steps)
    ? doc.steps.filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    : [];
}
function entryAt(value: unknown, index: number | undefined): unknown {
  if (index === undefined) return value;
  return Array.isArray(value) ? value[index] : index === 0 ? value : undefined;
}
function outputIndex(step: Record<string, unknown>, key: string, local: number | undefined): number | undefined {
  if (local === undefined) return undefined;
  const keys = ["produces", "optional_produces", "updates"];
  let n = local;
  for (const k of keys) {
    if (k === key) return n;
    const v = step[k];
    n += Array.isArray(v) ? v.length : v === undefined ? 0 : 1;
  }
  return n;
}

// Why an output entry is refused. The schema reads one entry or a list of
// them, so a wrong entry is reported as the field matching neither form,
// without saying what is wrong; the entry is then parsed again on its own by
// the engine's artifact schema, whose first issue is the reason.
function artifactProblem(issue: WorkflowIssue, path: (string | number)[], value: unknown): { local: number; message: string } {
  const local = typeof path[3] === "number" ? path[3] : undefined;
  let found = local ?? 0;
  const say = (message: string) => ({ local: found, message });
  const items = Array.isArray(value) ? value : [value];
  let item: unknown = local !== undefined ? items[local] : items.length === 1 ? items[0] : undefined;
  let at = path.slice(local !== undefined ? 4 : 3);
  let reason = issue;
  if (issue.code === "invalid_union") {
    const failing = (local !== undefined || items.length === 1 ? [item] : items)
      .map((entry, index) => ({ entry, index: local ?? index, parsed: ArtifactSchema.safeParse(entry) }))
      .find(({ parsed }) => !parsed.success);
    const first = failing && !failing.parsed.success ? failing.parsed.error.issues[0] : undefined;
    if (!first) return say("Each entry is an artifact id and a path, as `{ artifact: <id>, path: <path> }`.");
    item = failing!.entry;
    found = failing!.index;
    at = first.path.filter((k): k is string | number => typeof k !== "symbol");
    reason = { path: at, code: first.code, message: first.message };
  }
  const entry = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
  const id = typeof entry?.artifact === "string" ? entry.artifact : "artifact";
  if (at[0] === "artifact")
    return say(reason.code === "invalid_format" ? "Artifact id: lower-case letters, digits and hyphens." : "An artifact entry needs an artifact id.");
  if (at[0] === "path") return say(`\`${id}\` has no path.`);
  if (reason.code === "unrecognized_keys") return say(`\`${id}\`: ${reason.message}; an artifact has artifact, path and description.`);
  if (!entry) return say("Each entry is an artifact id and a path, as `{ artifact: <id>, path: <path> }`.");
  return say(reason.message);
}

function translate(issue: WorkflowIssue, doc: Record<string, unknown>): Problem {
  const p = issue.path;
  if (!p.length) return { stepIndex: -1, field: "steps", message: issue.message };
  if (p[0] === "name") return { stepIndex: -1, field: "name", message: "Name is required." };
  if (p[0] === "steps" && p.length === 1)
    return { stepIndex: -1, field: "steps", message: "A workflow needs at least one step." };
  if (p[0] !== "steps" || typeof p[1] !== "number") return { stepIndex: -1, field: "steps", message: issue.message };
  const stepIndex = p[1];
  const step = rawSteps(doc)[stepIndex] ?? {};
  const key = p[2];
  if (key === "id") {
    if (/duplicate step id/.test(issue.message)) {
      const id = String(step.id ?? "");
      const first = rawSteps(doc).findIndex((s) => s.id === id);
      return { stepIndex, field: "id", message: `Id already used by step ${first + 1}.` };
    }
    return { stepIndex, field: "id", message: "Id: lower-case letters, digits and hyphens." };
  }
  if (key === "mode") return { stepIndex, field: "mode", message: "Mode is attended or unattended." };
  if (key === "instruction") return { stepIndex, field: "instr", message: "Instruction is empty." };
  if (key === "condition") {
    return {
      stepIndex,
      field: "cond",
      message: /check names a kind/.test(issue.message)
        ? "A check is one lower-case word."
        : /needs a text/.test(issue.message)
          ? "Condition has no text."
          : issue.message,
    };
  }
  if (key === "consumes") {
    const itemIndex = typeof p[3] === "number" ? p[3] : undefined;
    const id = String(entryAt(step.consumes, itemIndex) ?? "");
    const later = rawSteps(doc).findIndex(
      (s, i) =>
        i > stepIndex &&
        ["produces", "optional_produces", "updates"].some((k) => {
          const values = s[k] === undefined ? [] : Array.isArray(s[k]) ? (s[k] as unknown[]) : [s[k]];
          return values.some((a) => !!a && typeof a === "object" && (a as Record<string, unknown>).artifact === id);
        }),
    );
    // The schema's own reason when the entry is not an id at all; only the
    // missing producer is restated with the step that has it.
    if (issue.code !== "custom")
      return {
        stepIndex,
        field: "consumes",
        itemIndex,
        message: issue.code === "invalid_format" ? `\`${id}\`: lower-case letters, digits and hyphens.` : issue.message,
      };
    return {
      stepIndex,
      field: "consumes",
      itemIndex,
      message:
        later >= 0
          ? `\`${id}\` is produced by a later step (${later + 1}).`
          : `\`${id}\` is not produced or updated by an earlier step.`,
    };
  }
  if (key === "produces" || key === "optional_produces" || key === "updates") {
    const { local, message } = artifactProblem(issue, p, step[key]);
    return { stepIndex, field: "art", itemIndex: outputIndex(step, key, local), message };
  }
  if (key === "gates") {
    const itemIndex = typeof p[3] === "number" ? p[3] : 0;
    const gate = entryAt(step.gates, itemIndex) as Record<string, unknown> | undefined;
    if (p[4] === "route_back_to" || /routes back/.test(issue.message)) {
      const routes = gate?.route_back_to;
      const fromMessage = issue.message.match(/routes back to "([^"]+)"/)?.[1];
      const target = fromMessage ?? (Array.isArray(routes) ? routes[0] : routes);
      const found = rawSteps(doc).findIndex((s) => s.id === target);
      return {
        stepIndex,
        field: "gate",
        itemIndex,
        subfield: "route",
        message:
          found < 0
            ? `Route back to ${String(target ?? "")}: no such step.`
            : `Route back to ${String(target ?? "")}: a later step.`,
      };
    }
    if (p[4] === "max_rounds" || /max_rounds/.test(issue.message))
      return {
        stepIndex,
        field: "gate",
        itemIndex,
        subfield: "maxRounds",
        // Two rules name max_rounds: its value, and the gate kinds it goes on.
        message: /whole number/.test(issue.message) ? "max_rounds is a whole number, at least 1." : `${issue.message}.`,
      };
    if (/check names a kind/.test(issue.message))
      return { stepIndex, field: "gate", itemIndex, subfield: "text", message: "A check is one lower-case word." };
    if (/needs a text/.test(issue.message)) {
      const kind = gate
        ? Object.keys(gate).find((k) => ["check", "script", "agent", "owner-action"].includes(k))
        : undefined;
      return { stepIndex, field: "gate", itemIndex, subfield: "text", message: `${kind ?? "Gate"} gate has no text.` };
    }
    return { stepIndex, field: "gate", itemIndex, message: issue.message };
  }
  return { stepIndex, field: "id", message: issue.message };
}

// What the server's POST /api/validate answers: the lines of `fuse-flow
// validate` that need other files (review guides, workflow gates and
// hand-offs), for the open text as saved at a given path. problems: each
// line again with the places in the file it is about (a step's gate, its
// own guide or the workflow it starts; a hand-off; the name; none for the
// workflow as a whole) and the line without the place it starts with. An
// older server sends no problems.
export interface EnginePlace {
  step?: number;
  gate?: number;
  handOff?: number;
  field?: "guide" | "workflow" | "name";
}
export interface EngineProblem {
  severity: "error" | "warning";
  line: string;
  detail: string;
  at: EnginePlace[];
}
export interface EngineValidation {
  errors: string[];
  warnings: string[];
  problems?: EngineProblem[];
}

// A placed engine line as Komposer's problems: one on each gate it is
// about, in the words without the place; one about a hand-off, the name or
// nothing is the workflow's, in the engine's whole line.
function placedProblems(problem: EngineProblem, stepCount: number): Problem[] {
  const onSteps = problem.at.filter((place) => place.step !== undefined && place.step < stepCount);
  if (!onSteps.length) return [{ stepIndex: -1, field: problem.at.some((p) => p.field === "name") ? "name" : "steps", message: problem.line }];
  return onSteps.map((place): Problem => {
    if (place.gate === undefined) return { stepIndex: place.step!, field: "id", message: problem.detail };
    return {
      stepIndex: place.step!,
      field: "gate",
      itemIndex: place.gate,
      ...(place.field === "guide" ? { subfield: "guide" as const } : {}),
      message: problem.detail,
    };
  });
}

// The engine's lines as problems, each on the step and gate it names (the
// server's places when it gives them, below). The
// engine's wording is kept; only the location it starts with is taken off,
// as the problem is shown on that step. A line that names no step is the
// workflow's. A line about a workflow this one starts ("step X, workflow
// Y: ...") is the delegating step's, whatever the child's line names after
// it.
export function engineProblems(text: string, result: EngineValidation): Problem[] {
  const parsed = parseWorkflowText(text);
  if (!parsed.ok) return [];
  const steps = parsed.workflow.steps;
  if (result.problems)
    return result.problems.filter((p) => p.severity === "error").flatMap((p) => placedProblems(p, steps.length));
  // An older server: the places are read from the lines.
  return result.errors.map((line): Problem => {
    const delegation = /^step ([a-z0-9-]+), workflow [^:]*: ([\s\S]*)$/.exec(line);
    const delegating = delegation ? steps.findIndex((s) => s.id === delegation[1]) : -1;
    if (delegation && delegating >= 0) {
      const itemIndex = steps[delegating].gates.findIndex((g) => g.kind === "workflow");
      return { stepIndex: delegating, field: "gate", ...(itemIndex >= 0 ? { itemIndex } : {}), message: delegation[2] };
    }
    if (delegation || line.startsWith("hands_off_to ")) return { stepIndex: -1, field: "steps", message: line };
    const guide = /^[\s\S]*?: steps\.(\d+) \(([a-z0-9-]+)\): (the review guide of ([a-z-]+)\(([\s\S]*)\) (?:does not exist|is a folder, not a file|is not a file): ([\s\S]*))$/.exec(line);
    const stepIndex = guide ? Number(guide[1]) : -1;
    if (guide && steps[stepIndex]?.id === guide[2]) {
      const reported = guide[6];
      // The gate whose own guide the line names: by kind and text, and when
      // two gates share those, by the guide's path. Unclear, the step's.
      const same = steps[stepIndex].gates.flatMap((g, i) => (g.kind === guide[4] && g.text === guide[5] && g.guide ? [i] : []));
      const byGuide = same.filter((i) => guideNames(steps[stepIndex].gates[i].guide!, reported));
      const itemIndex = same.length === 1 ? same[0] : byGuide.length === 1 ? byGuide[0] : -1;
      return { stepIndex, field: "gate", ...(itemIndex >= 0 ? { itemIndex, subfield: "guide" as const } : {}), message: guide[3] };
    }
    return { stepIndex: -1, field: "steps", message: line };
  });
}

// Whether `reported`, a guide's path as the server resolved it, can be the
// gate's `guide` as written: the same path, or it ends with the written one
// once its leading ./ and ../ are taken off.
function guideNames(guide: string, reported: string): boolean {
  if (guide === reported) return true;
  const rest = guide.replace(/^(?:\.\.?\/)+/, "");
  return rest !== "" && reported.endsWith(`/${rest}`);
}

// The problems of the open text: the schema's, and once it parses, the
// engine's checks that need other files, when the server has answered for
// this text (`engine`). Save is blocked while there are any, as
// `fuse-flow validate` would refuse the file.
export function problemsForText(text: string, engine?: EngineValidation | null): Problem[] {
  const result = parseWorkflowText(text);
  if (result.ok) return engine ? engineProblems(text, engine) : [];
  const doc = raw(text);
  return result.issues.map((issue) => translate(issue, doc));
}
export function problemsByStep(problems: Problem[]): Map<number, Problem[]> {
  const out = new Map<number, Problem[]>();
  for (const problem of problems) {
    if (problem.stepIndex < 0) continue;
    const list = out.get(problem.stepIndex) ?? [];
    list.push(problem);
    out.set(problem.stepIndex, list);
  }
  return out;
}
