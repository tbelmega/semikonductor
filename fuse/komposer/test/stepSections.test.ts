// SPDX-License-Identifier: Apache-2.0
// Which Step tab section a step's problems force open and mark, for the
// problems the real engine reports on real workflow text.

import { describe, expect, test } from "bun:test";
import { sectionsWithProblems } from "../src/model/stepSections.ts";
import { problemsByStep, problemsForText } from "../src/validate.ts";

const sectionsOf = (text: string, step: number) =>
  [...sectionsWithProblems(problemsByStep(problemsForText(text)).get(step) ?? [])].sort();

const FLOW = `version: 1
name: two
steps:
  - id: write
    instruction: Write it.
    produces:
      - artifact: essay
        path: essay.md
  - id: check
    instruction: Check it.
    consumes: [essay]
    gates:
      - agent: review it
`;

describe("sectionsWithProblems", () => {
  test("a valid step has no section with a problem", () => {
    expect(sectionsOf(FLOW, 1)).toEqual([]);
  });

  test("an input that no earlier step writes marks Inputs and outputs", () => {
    expect(sectionsOf(FLOW.replace("consumes: [essay]", "consumes: [nothing]"), 1)).toEqual(["artifacts"]);
  });

  test("an input that a later step writes marks Inputs and outputs", () => {
    const text = FLOW.replace("    produces:\n      - artifact: essay\n        path: essay.md\n", "    consumes: [essay]\n").replace(
      "    consumes: [essay]\n    gates:",
      "    produces:\n      - artifact: essay\n        path: essay.md\n    gates:",
    );
    expect(sectionsOf(text, 0)).toEqual(["artifacts"]);
  });

  test("each kind of step problem marks the section that holds its field", () => {
    expect(sectionsOf(FLOW.replace("id: check", "id: Check"), 1)).toEqual(["basics"]);
    expect(sectionsOf(FLOW.replace("instruction: Check it.", 'instruction: ""'), 1)).toEqual(["instruction"]);
    expect(sectionsOf(FLOW.replace("        path: essay.md\n", ""), 0)).toEqual(["artifacts"]);
    expect(sectionsOf(FLOW.replace("agent: review it", 'agent: ""'), 1)).toEqual(["gates"]);
  });
});
