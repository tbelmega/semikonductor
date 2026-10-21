// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drawnBuses, layoutEdges } from "../src/layout.ts";
import { jsxAttributes } from "./jsxAttributes.ts";
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

describe("drawn buses", () => {
  const text = `version: 1
name: w
steps:
  - id: write
    instruction: Write.
    produces:
      - artifact: note
        path: note.md
      - artifact: plan
        path: plan.md
  - id: other
    instruction: Something else.
  - id: read
    instruction: Read.
    consumes: [note, plan]
`;
  const drawn = (hoveredArtifact: string | null, selectedIndex: number, onlyHovered: boolean) =>
    drawnBuses(layoutEdges(steps(text)), { hoveredArtifact, selectedIndex, onlyHovered }).map(({ bus, highlighted }) => [
      bus.artifact,
      highlighted,
    ]);

  test("the edit page draws no consumes line while nothing is hovered, even with a step selected", () => {
    expect(drawn(null, -1, true)).toEqual([]);
    expect(drawn(null, 0, true)).toEqual([]);
    expect(drawn(null, 2, true)).toEqual([]);
  });

  test("the edit page draws only the hovered artifact's line, highlighted, whatever is selected", () => {
    expect(drawn("note", -1, true)).toEqual([["note", true]]);
    expect(drawn("note", 0, true)).toEqual([["note", true]]);
    expect(drawn("unconsumed", -1, true)).toEqual([]);
  });

  test("Present draws every line and highlights the hovered artifact's", () => {
    expect(drawn(null, -1, false)).toEqual([
      ["note", false],
      ["plan", false],
    ]);
    expect(drawn("plan", -1, false)).toEqual([
      ["note", false],
      ["plan", true],
    ]);
  });
});

describe("which pages draw consumes lines only on hover", () => {
  const flowProps = (file: string) =>
    jsxAttributes(readFileSync(join(import.meta.dir, "..", "src", file), "utf8"), file)
      .filter((a) => a.tag === "Flow")
      .map((a) => a.name);

  test("the edit page's diagram sets consumesOnHover, Present's does not", () => {
    expect(flowProps("App.tsx")).toContain("consumesOnHover");
    expect(flowProps("Present.tsx")).toContain("hoveredArtifact");
    expect(flowProps("Present.tsx")).not.toContain("consumesOnHover");
  });
});
