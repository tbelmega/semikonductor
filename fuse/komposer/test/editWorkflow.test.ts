// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { copyStepEdits } from "../src/model/compare.ts";
import { copyWrite, editedWorkflow } from "../src/model/editWorkflow.ts";
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

describe("copyWrite", () => {
  const target = open(TARGET);
  const changed = editedWorkflow(target, copyStepEdits(stepViews(open(SOURCE)), 2, stepViews(target)));
  const reverted = editedWorkflow(target, [{ op: "setStepField", step: 0, key: "title", value: null }]);

  test("a copy into a workflow that is not open writes its working copy at once", () => {
    expect(copyWrite(changed, "/other.yml")).toBe("put");
  });

  test("a copy into the open workflow is left to the autosave, so it is written once", () => {
    expect(copyWrite(changed, "/target.yml")).toBe("autosave");
  });

  test("a result equal to the file removes the working copy", () => {
    expect(copyWrite(reverted, "/other.yml")).toBe("delete");
  });
});
