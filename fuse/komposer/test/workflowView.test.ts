// SPDX-License-Identifier: Apache-2.0
// The saved form of an open workflow, and what saving its open text changes
// for the workstreams that follow it.

import { describe, expect, test } from "bun:test";
import { editedWorkflow } from "../src/model/editWorkflow.ts";
import { differenceCaveats, differencePrompt, openWorkflow, savedVersion, stepViews, structureChanges, workflowDescription } from "../src/workflowView.ts";

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

describe("workflowDescription", () => {
  test("is the description, trimmed, and undefined when there is none or only whitespace", () => {
    expect(workflowDescription(open(SAVED.replace("name: x\n", "name: x\ndescription: |\n  Builds a thing.\n")))).toBe("Builds a thing.");
    expect(workflowDescription(open(SAVED))).toBeUndefined();
    expect(workflowDescription(open(SAVED.replace("name: x\n", 'name: x\ndescription: "  "\n')))).toBeUndefined();
  });

  test("is read from the raw YAML when the workflow fails validation", () => {
    const broken = open("version: 1\nname: x\ndescription: Still readable.\nsteps: []\n");
    expect(broken.parsed).toBeNull();
    expect(workflowDescription(broken)).toBe("Still readable.");
  });
});

describe("differencePrompt", () => {
  test("asks about both workflows by name and path, left first", () => {
    const left = open(SAVED);
    const right = openWorkflow({ location: "personal", dir: "team", file: "y.yml", path: "/home/u/y.yml", onDisk: true, text: SAVED.replace("name: x", "name: why"), hash: "h" });
    expect(differencePrompt(left, right)).toBe(
      "Explain the difference between the fuse-flow workflows x (/p/x.yml) and why (/home/u/y.yml). " +
        "When should I use which? What are the most significant trade-offs between the two workflows?",
    );
  });

  test("names a workflow without a name by its file", () => {
    const nameless = open("version: 1\nsteps: []\n");
    expect(differencePrompt(nameless, open(SAVED))).toStartWith("Explain the difference between the fuse-flow workflows x (/p/x.yml) and x (/p/x.yml).");
  });
});

describe("differenceCaveats", () => {
  const other = (text = SAVED, workingCopy?: string, onDisk = true) =>
    openWorkflow({ location: "project", dir: "", file: "y.yml", path: "/p/y.yml", onDisk, text, hash: "h", workingCopy });

  test("two saved workflows without edits have none", () => {
    expect(differenceCaveats(open(SAVED), other())).toEqual({ unsaved: null, edited: [] });
  });

  test("a workflow never saved, on either side, keeps the question from being asked", () => {
    expect(differenceCaveats(open(SAVED), other("", SAVED, false)).unsaved).toBe("Save y.yml first, so your agent can read it.");
    expect(differenceCaveats(other("", SAVED, false), open(SAVED)).unsaved).toBe("Save y.yml first, so your agent can read it.");
  });

  test("names the workflows with unsaved edits, on either side", () => {
    const edited = SAVED.replace("First.", "Changed.");
    expect(differenceCaveats(open(SAVED), other(SAVED, edited)).edited).toEqual(["y.yml"]);
    expect(differenceCaveats(open(SAVED, edited), other(SAVED, edited)).edited).toEqual(["x.yml", "y.yml"]);
  });
});

describe("a workflow gate the engine refuses keeps its per-item settings when well-typed", () => {
  // The folder is produced by no earlier step, so the engine refuses the
  // workflow and Komposer reads its gates loosely.
  const refused = (keys: string) =>
    open(`version: 1\nname: x\nsteps:\n  - id: a\n    instruction: Fan out.\n    gates:\n      - workflow: child\n        inputs: { spec: units }\n${keys}`);
  const gate = (keys: string) => {
    const w = refused(keys);
    expect(w.parsed).toBeNull();
    return stepViews(w)[0].gates[0];
  };

  test("for_each is kept as a string and dropped otherwise", () => {
    expect(gate("        for_each: units\n").for_each).toBe("units");
    expect(gate("        for_each: 3\n")).not.toHaveProperty("for_each");
    expect(gate("        for_each: \"\"\n")).not.toHaveProperty("for_each");
    expect(gate("        for_each: 3\n")).toMatchObject({ kind: "workflow", text: "child" });
  });

  test("accept, rerun, rerun_override and retries are kept in their domain and dropped outside it", () => {
    expect(gate("        for_each: units\n        accept: succeeded\n").accept).toBe("succeeded");
    expect(gate("        for_each: units\n        accept: maybe\n")).not.toHaveProperty("accept");
    expect(gate("        for_each: units\n        rerun: failed\n").rerun).toBe("failed");
    expect(gate("        for_each: units\n        rerun: some\n")).not.toHaveProperty("rerun");
    expect(gate("        for_each: units\n        rerun_override: false\n").rerun_override).toBe(false);
    expect(gate('        for_each: units\n        rerun_override: "no"\n')).not.toHaveProperty("rerun_override");
    expect(gate("        for_each: units\n        retries: 2\n").retries).toBe(2);
    for (const bad of ["-1", "1.5", '"2"']) expect(gate(`        for_each: units\n        retries: ${bad}\n`)).not.toHaveProperty("retries");
  });
});
