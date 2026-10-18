// SPDX-License-Identifier: Apache-2.0
// The problems Komposer shows for a workflow text: the engine parser's issues
// in Komposer's wording, each with the repair it really needs, and the
// engine's checks that need other files, placed on the step they name.

import { describe, expect, test } from "bun:test";
import { engineProblems, problemsForText } from "../src/validate.ts";

const step = (extra: string) => `version: 1
name: a
steps:
  - id: a
    instruction: Do it.
${extra}`;
const messages = (text: string) => problemsForText(text).map((p) => [p.field, p.itemIndex, p.message]);

describe("schema problems keep the engine's reason", () => {
  test("max_rounds on a gate that is not an agent gate says where it goes, not that its value is wrong", () => {
    expect(messages(step("    gates:\n      - script: true-command\n        max_rounds: 2\n"))).toEqual([
      ["gate", 0, "max_rounds goes on an agent gate only."],
    ]);
    expect(messages(step("    gates:\n      - agent: review it\n        max_rounds: 0\n"))).toEqual([
      ["gate", 0, "max_rounds is a whole number, at least 1."],
    ]);
  });

  test("an output entry names what is wrong with it, and which entry", () => {
    expect(messages(step("    produces: {artifact: note}\n"))).toEqual([["art", 0, "`note` has no path."]]);
    expect(messages(step("    produces: [{artifact: ok, path: ok.md}, {artifact: note}]\n"))).toEqual([["art", 1, "`note` has no path."]]);
    expect(messages(step("    produces: {artifact: BAD, path: x.md}\n"))).toEqual([["art", 0, "Artifact id: lower-case letters, digits and hyphens."]]);
    expect(messages(step("    produces: {path: x.md}\n"))).toEqual([["art", 0, "An artifact entry needs an artifact id."]]);
    expect(messages(step("    produces: {artifact: note, path: x.md, foo: 1}\n"))[0][2]).toContain("`note`: Unrecognized key");
    // An updates entry counts after the step's produces, as the panel lists them.
    expect(messages(step("    produces: {artifact: ok, path: ok.md}\n    updates: {artifact: code}\n"))).toEqual([["art", 1, "`code` has no path."]]);
  });

  test("a consumed id that is not an id says so, besides that no earlier step produces it", () => {
    expect(messages(step("    consumes: [BAD]\n"))).toEqual([
      ["consumes", 0, "`BAD`: lower-case letters, digits and hyphens."],
      ["consumes", 0, "`BAD` is not produced or updated by an earlier step."],
    ]);
  });
});

describe("the engine's checks that need other files", () => {
  const TEXT = `version: 1
name: parent
steps:
  - id: draft
    instruction: Write it.
    gates:
      - check: default
      - agent: review the draft
        guide: nope.md
  - id: ask
    instruction: Ask.
    gates:
      - owner-action: approve
      - workflow: child
`;

  test("each error is placed on the step and gate it names, in the engine's words", () => {
    const problems = engineProblems(TEXT, {
      errors: [
        "/p/.konductor/workflows/parent.yml: steps.0 (draft): the review guide of agent(review the draft) does not exist: /p/.konductor/workflows/nope.md",
        'step ask, workflow child: child requires the input "request", and the gate\'s inputs do not give it',
        "hands_off_to next: no workflow named next",
      ],
      warnings: [],
    });
    expect(problems).toEqual([
      {
        stepIndex: 0,
        field: "gate",
        itemIndex: 1,
        subfield: "guide",
        message: "the review guide of agent(review the draft) does not exist: /p/.konductor/workflows/nope.md",
      },
      { stepIndex: 1, field: "gate", itemIndex: 1, message: 'child requires the input "request", and the gate\'s inputs do not give it' },
      { stepIndex: -1, field: "steps", message: "hands_off_to next: no workflow named next" },
    ]);
  });

  test("a child workflow's guide error goes on the parent step's workflow gate, not on the child's step index", () => {
    const line =
      "step ask, workflow child: /p/.konductor/workflows/child.yml: steps.0 (child-step): the review guide of agent(review child) does not exist: /p/.konductor/workflows/gone.md";
    expect(engineProblems(TEXT, { errors: [line], warnings: [] })).toEqual([
      {
        stepIndex: 1,
        field: "gate",
        itemIndex: 1,
        message: "/p/.konductor/workflows/child.yml: steps.0 (child-step): the review guide of agent(review child) does not exist: /p/.konductor/workflows/gone.md",
      },
    ]);
  });

  test("of two agent gates with the same text, the error goes on the one whose guide it names, or on the step when that is unclear", () => {
    const two = (a: string, b: string) => `version: 1
name: parent
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: review it
        guide: ${a}
      - agent: review it
        guide: ${b}
`;
    const line = "/p/.konductor/workflows/parent.yml: steps.0 (draft): the review guide of agent(review it) does not exist: /p/.konductor/workflows/missing.md";
    const message = "the review guide of agent(review it) does not exist: /p/.konductor/workflows/missing.md";
    expect(engineProblems(two("ok.md", "missing.md"), { errors: [line], warnings: [] })).toEqual([
      { stepIndex: 0, field: "gate", itemIndex: 1, subfield: "guide", message },
    ]);
    expect(engineProblems(two("./missing.md", "ok.md"), { errors: [line], warnings: [] })).toEqual([
      { stepIndex: 0, field: "gate", itemIndex: 0, subfield: "guide", message },
    ]);
    expect(engineProblems(two("missing.md", "missing.md"), { errors: [line], warnings: [] })).toEqual([{ stepIndex: 0, field: "gate", message }]);
  });

  test("the server's places are used when it gives them, so a line goes on exactly the gate it names", () => {
    const text = `version: 1
name: parent
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: review it
        guide: missing.md
      - agent: review it
        guide: missing.md
`;
    const line = "/p/.konductor/workflows/parent.yml: steps.0 (draft): the review guide of agent(review it) does not exist: /p/.konductor/workflows/missing.md";
    const detail = "the review guide of agent(review it) does not exist: /p/.konductor/workflows/missing.md";
    const handOff = "hands_off_to next: no workflow named next";
    expect(
      engineProblems(text, {
        errors: [line, handOff],
        warnings: ["a warning"],
        problems: [
          { severity: "error", line, detail, at: [{ step: 0, gate: 1, field: "guide" }] },
          { severity: "error", line: handOff, detail: "no workflow named next", at: [{ handOff: 0 }] },
          { severity: "warning", line: "a warning", detail: "a warning", at: [] },
        ],
      }),
    ).toEqual([
      { stepIndex: 0, field: "gate", itemIndex: 1, subfield: "guide", message: detail },
      { stepIndex: -1, field: "steps", message: handOff },
    ]);
  });

  test("a guide line whose step id is not the step at that index stays the workflow's", () => {
    const line = "/p/x.yml: steps.0 (other): the review guide of agent(review the draft) does not exist: /p/.konductor/workflows/nope.md";
    expect(engineProblems(TEXT, { errors: [line], warnings: [] })).toEqual([{ stepIndex: -1, field: "steps", message: line }]);
  });

  test("they count as problems once the server has answered, and only when the text parses", () => {
    const answer = { errors: ["hands_off_to next: no workflow named next"], warnings: ["a warning is not a problem"] };
    expect(problemsForText(TEXT)).toEqual([]);
    expect(problemsForText(TEXT, answer)).toHaveLength(1);
    expect(problemsForText(TEXT, { errors: [], warnings: ["only a warning"] })).toEqual([]);
    const broken = TEXT.replace("id: draft", "id: Draft");
    expect(problemsForText(broken, answer).map((p) => p.field)).toEqual(["id"]);
  });
});
