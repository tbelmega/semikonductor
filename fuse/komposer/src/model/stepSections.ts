// SPDX-License-Identifier: Apache-2.0
// Which section of the Step tab holds each problem a step can have. A section
// that holds a problem is forced open and marked with a red dot.

import type { Problem, ProblemField } from "../validate.ts";

export type StepSection = "basics" | "instruction" | "artifacts" | "gates";

// Every field a problem of one step can name; "name" and "steps" belong to
// the workflow, not to a step. A new field fails to compile until it has a
// section.
const SECTION_OF: Record<Exclude<ProblemField, "name" | "steps">, StepSection> = {
  id: "basics",
  mode: "basics",
  instr: "instruction",
  cond: "instruction",
  consumes: "artifacts",
  art: "artifacts",
  gate: "gates",
};

export function sectionsWithProblems(problems: Problem[]): Set<StepSection> {
  const out = new Set<StepSection>();
  for (const p of problems) if (p.field !== "name" && p.field !== "steps") out.add(SECTION_OF[p.field]);
  return out;
}
