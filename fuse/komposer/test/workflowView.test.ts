// SPDX-License-Identifier: Apache-2.0
// The saved form of an open workflow.

import { describe, expect, test } from "bun:test";
import { openWorkflow, savedVersion, stepViews } from "../src/workflowView.ts";

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
});
