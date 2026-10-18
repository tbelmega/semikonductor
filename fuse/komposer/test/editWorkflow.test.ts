// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { copyStepEdits } from "../src/model/compare.ts";
import { editedWorkflow, shownText } from "../src/model/editWorkflow.ts";
import type { Edit } from "../src/model/yamlEdit.ts";
import { openWorkflow, stepViews, type OpenWorkflow } from "../src/workflowView.ts";

const open = (text: string, path = "/target.yml"): OpenWorkflow =>
  openWorkflow({ location: "project", dir: "", file: "target.yml", path, onDisk: true, text, hash: "h" });

const TARGET = `version: 1
name: target
steps:
  - id: a
    instruction: First.
  - id: b
    instruction: Second.
  - id: c
    instruction: Third.
`;
const SOURCE = `version: 1
name: source
steps:
  - id: a
    instruction: First.
  - id: b
    title: Changed
    instruction: Second, but different.
  - id: n
    instruction: New.
`;

describe("editedWorkflow", () => {
  test("a step replaced by a copy keeps its step key, so Save does not report it deleted and added", () => {
    const target = open(TARGET);
    const next = editedWorkflow(target, copyStepEdits(stepViews(open(SOURCE)), 1, stepViews(target)));
    expect(stepViews(next).map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(next.stepKeys).toEqual(target.stepKeys);
    expect(stepViews(next)[1].title).toBe("Changed");
  });

  test("an inserted copy gets a new step key and every other step keeps its own", () => {
    const target = open(TARGET);
    const next = editedWorkflow(target, copyStepEdits(stepViews(open(SOURCE)), 2, stepViews(target)));
    expect(stepViews(next).map((s) => s.id)).toEqual(["a", "b", "n", "c"]);
    expect([next.stepKeys[0], next.stepKeys[1], next.stepKeys[3]]).toEqual(target.stepKeys);
    expect(target.stepKeys).not.toContain(next.stepKeys[2]);
  });

  test("a step can be copied over a workflow's only step", () => {
    const one = open(`version: 1\nname: one\nsteps:\n  - id: s\n    instruction: Old.\n`);
    const from = stepViews(open(`version: 1\nname: src\nsteps:\n  - id: s\n    instruction: New.\n`));
    const next = editedWorkflow(one, copyStepEdits(from, 0, stepViews(one)));
    expect(stepViews(next).map((s) => [s.id, s.instruction?.trim()])).toEqual([["s", "New."]]);
    expect(next.stepKeys).toEqual(one.stepKeys);
  });

  test("the result is a working copy of the target, and the file text is unchanged", () => {
    const target = open(TARGET);
    const next = editedWorkflow(target, copyStepEdits(stepViews(open(SOURCE)), 2, stepViews(target)));
    expect(next.text).toBe(TARGET);
    expect(next.workingCopy).toBe(next.openText);
    expect(next.openText).not.toBe(TARGET);
  });

  test("edits that bring the text back to the file leave no working copy", () => {
    const target = open(TARGET);
    const same = editedWorkflow(target, [{ op: "setStepField", step: 0, key: "title", value: null }]);
    expect(same.workingCopy).toBeUndefined();
  });
});

// Typing into a field one character at a time, as the Inspector does: each
// keystroke is an edit, and the field shows shownText of what was typed and
// the value the engine reads back.
describe("typing into a field the engine trims", () => {
  const TEXT = `version: 1
name: typing
steps:
  - id: a
    instruction: Do it.
    condition:
      agent: when needed
    gates:
      - script: bun test
`;
  const type = (start: string, typed: string, edit: (value: string) => Edit, read: (w: OpenWorkflow) => string) => {
    let w = open(TEXT);
    let shown = start;
    for (const ch of typed) {
      const draft = shown + ch;
      w = editedWorkflow(w, [edit(draft)]);
      shown = shownText(draft, read(w));
    }
    return { shown, value: read(w) };
  };

  test("spaces and line breaks typed at the end of the instruction stay", () => {
    const out = type("Do it.", " More work.\nAnd then.", (text) => ({ op: "setInstruction", step: 0, text, style: ">" }), (w) => stepViews(w)[0].instruction ?? "");
    expect(out).toEqual({ shown: "Do it. More work.\nAnd then.", value: "Do it. More work.\nAnd then." });
  });

  test("in a gate's text and a condition's text too", () => {
    const gate = type("bun test", " --bail", (text) => ({ op: "setGate", step: 0, index: 0, fields: { text } }), (w) => stepViews(w)[0].gates[0].text);
    expect(gate).toEqual({ shown: "bun test --bail", value: "bun test --bail" });
    const condition = type(
      "when needed",
      " most",
      (text) => ({ op: "setCondition", step: 0, condition: { kind: "agent", text } }),
      (w) => stepViews(w)[0].condition?.text ?? "",
    );
    expect(condition).toEqual({ shown: "when needed most", value: "when needed most" });
  });

  test("the value wins once it is something else", () => {
    expect(shownText("Do it. ", "Do it.")).toBe("Do it. ");
    expect(shownText("Do it. ", "Other text.")).toBe("Other text.");
    expect(shownText(null, "Do it.")).toBe("Do it.");
  });
});
