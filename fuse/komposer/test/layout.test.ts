// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { layoutEdges } from "../src/layout.ts";
import { openWorkflow, stepViews } from "../src/workflowView.ts";

const steps = (text: string) =>
  stepViews(openWorkflow({ location: "project", dir: "", file: "w.yml", path: "/w.yml", onDisk: true, text, hash: "" }));
const buses = (text: string) => layoutEdges(steps(text)).buses.map((b) => [b.artifact, b.producerIndex, b.consumerIndices]);

describe("artifact buses", () => {
  test("a consumer reads from the nearest earlier writer, as fuse-flow reads it, not from the first", () => {
    const text = `version: 1
name: w
steps:
  - id: initial
    instruction: Write.
    produces:
      - artifact: note
        path: initial.md
  - id: early
    instruction: Read the first.
    consumes: [note]
  - id: revise
    instruction: Revise.
    updates:
      - artifact: note
        path: revised.md
  - id: read
    instruction: Read.
    consumes: [note]
`;
    expect(buses(text)).toEqual([
      ["note", 0, [1]],
      ["note", 2, [3]],
    ]);
  });

  test("a later child's return is the source after an earlier declaration", () => {
    const text = `version: 1
name: w
steps:
  - id: first
    instruction: Write.
    produces:
      - artifact: report
        path: report.md
  - id: delegate
    instruction: Delegate.
    gates:
      - workflow: child
        returns: { report: report }
  - id: use
    instruction: Use.
    consumes: [report]
`;
    expect(buses(text)).toEqual([["report", 1, [2]]]);
  });
});
