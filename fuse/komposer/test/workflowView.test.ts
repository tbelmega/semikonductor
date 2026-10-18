// SPDX-License-Identifier: Apache-2.0
// The saved form of an open workflow, and what saving its open text changes
// for the workstreams that follow it.

import { describe, expect, test } from "bun:test";
import { editedWorkflow } from "../src/model/editWorkflow.ts";
import { openWorkflow, savedVersion, stepViews, structureChanges } from "../src/workflowView.ts";

const SAVED = `version: 1
name: x
steps:
  - id: a
    instruction: First.
    gates:
      - agent: review it
  - id: b
    instruction: Second.
`;

const open = (text: string, workingCopy?: string) =>
  openWorkflow({ location: "project", dir: "", file: "x.yml", path: "/p/x.yml", onDisk: true, text, hash: "h", workingCopy });

describe("savedVersion", () => {
  test("the workstreams see the saved steps, not a working copy's", () => {
    const edited = open(SAVED, SAVED.replace("steps:\n", "steps:\n  - id: unsaved\n    instruction: New.\n"));
    expect(stepViews(edited).map((s) => s.id)).toEqual(["unsaved", "a", "b"]);
    expect(stepViews(savedVersion(edited)).map((s) => s.id)).toEqual(["a", "b"]);
  });

  test("a workflow without edits is its own saved version", () => {
    const clean = open(SAVED);
    expect(savedVersion(clean)).toBe(clean);
  });

  test("when the file changed on disk under the edits, the workstreams see the file on disk", () => {
    const edited = open(SAVED, SAVED.replace("steps:\n", "steps:\n  - id: unsaved\n    instruction: New.\n"));
    const onDisk = SAVED.replace("id: b", "id: gamma");
    const saved = savedVersion(edited, { text: onDisk, hash: "h2" });
    expect(stepViews(saved).map((s) => s.id)).toEqual(["a", "gamma"]);
    expect(saved.hash).toBe("h2");
  });
});

describe("structureChanges", () => {
  test("a changed gate is named, since fuse-flow takes back a review accepted under it", () => {
    const edited = editedWorkflow(open(SAVED), [{ op: "setGate", step: 0, index: 0, fields: { text: "review it carefully" } }]);
    expect(structureChanges(edited)).toEqual(["changed gates of a"]);
  });

  test("an added gate is named; an instruction edit is not a change that matters", () => {
    const added = open(SAVED, SAVED.replace("    instruction: Second.\n", "    instruction: Second.\n    gates:\n      - owner-action: approve it\n"));
    expect(structureChanges(added)).toEqual(["changed gates of b"]);
    expect(structureChanges(open(SAVED, SAVED.replace("Second.", "Second, reworded.")))).toEqual([]);
  });

  test("renamed, deleted and moved steps are named as before", () => {
    const renamed = editedWorkflow(open(SAVED), [{ op: "setStepField", step: 1, key: "id", value: "c" }]);
    expect(structureChanges(renamed)).toEqual(["renamed b → c"]);
    const deleted = editedWorkflow(open(SAVED), [{ op: "deleteStep", index: 0 }]);
    expect(structureChanges(deleted)).toEqual(["deleted a"]);
    const moved = editedWorkflow(open(SAVED), [{ op: "moveStep", from: 1, to: 0 }]);
    expect(structureChanges(moved)).toEqual(["moved a 1 → 2", "moved b 2 → 1"]);
  });
});
