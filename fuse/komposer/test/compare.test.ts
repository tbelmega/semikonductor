// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import {
  alignSteps,
  applyProblem,
  compareItems,
  foldedStep,
  comparePair,
  compareOrder,
  comparePick,
  copySourceProblem,
  copyStepEdits,
  defaultComparePair,
  differences,
  hasDifferences,
  moveEdits,
  removeEdits,
  rowCounts,
  stepDiff,
  type CompareRow,
} from "../src/model/compare.ts";
import { lineDiff, wordDiff } from "../src/diff.ts";
import { isWorkflowPath as engineReadsAsPath } from "../../flow/src/project.ts";
import { applyEdit, type Edit } from "../src/model/yamlEdit.ts";
import { openWorkflow, readsCompletely, stepViews, type StepView } from "../src/workflowView.ts";

function open(text: string, file = "w.yml") {
  return openWorkflow({ location: "project", dir: "", file, path: `/${file}`, onDisk: true, text, hash: "" });
}
function steps(text: string) {
  return stepViews(open(text));
}
const run = (text: string, edits: Edit[]) => edits.reduce((t, edit) => applyEdit(t, edit), text);

// Field-by-field equality of two step views, lists by position and strings
// up to trailing whitespace: stricter than Compare's own diff, which ignores
// the order of consumes, outputs and gates and other whitespace. Copies must
// pass this. Returns the fields that differ.
function strictDifferences(a: StepView, b: StepView): string[] {
  const canonical = (value: unknown) =>
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
        : v,
    );
  const normal = (value: unknown) => (typeof value === "string" ? value.trimEnd() : value);
  const fields = ["id", "title", "phase", "mode", "description", "instruction", "condition", "consumes", "artifacts", "gates"] as const;
  return fields.filter((f) => canonical(normal(a[f])) !== canonical(normal(b[f])));
}

const FLOW = `${import.meta.dir}/../../flow/workflows`;
const read = (path: string) => readFileSync(`${FLOW}/${path}`, "utf8");
const FUSE = ["fuse-dependency-migration", "fuse-feature-development", "fuse-rapid-prototyping", "fuse-system-development"].map(
  (n) => `fuse/${n}.yml`,
);
const EXAMPLES = readdirSync(`${FLOW}/customization-examples`)
  .filter((f) => f.endsWith(".yml"))
  .map((f) => `customization-examples/${f}`);

const LEFT = `version: 1
name: left
steps:
  - id: intake
    instruction: Ask the owner.
    produces:
      - artifact: feature-spec
        path: spec.md
  - id: build
    instruction: Build it.
    consumes: [feature-spec]
    gates:
      - owner-action: Approve.
  - id: only-left
    instruction: Left only.
`;

const RIGHT = `version: 1
name: right
steps:
  - id: intake
    instruction: Ask the owner.
    produces:
      - artifact: feature-spec
        path: spec.md
  - id: extra
    instruction: Right only.
  - id: build
    title: Build
    instruction: Build it differently.
    consumes: [feature-spec]
    gates:
      - agent: Review it.
        route_back_to: intake
`;

const kinds = (rows: CompareRow[]) => rows.map((r) => [r.kind, r.left, r.right]);
const ids = (text: string) => steps(text).map((s) => s.id);
const wf = (...list: string[]) => `version: 1\nname: w\nsteps:\n${list.map((id) => `  - id: ${id}\n    instruction: ${id}.\n`).join("")}`;

describe("alignSteps", () => {
  test("pairs steps with the same id in common order, and marks steps on one side only", () => {
    expect(kinds(alignSteps(steps(LEFT), steps(RIGHT)))).toEqual([
      ["same", 0, 0],
      ["right", null, 1],
      ["changed", 1, 2],
      ["left", 2, null],
    ]);
  });

  test("the same workflow on both sides is the same in every row", () => {
    expect(alignSteps(steps(RIGHT), steps(RIGHT)).every((r) => r.kind === "same")).toBe(true);
  });

  test("a step on both sides outside the common order is moved, shown on each side with the other's position", () => {
    const rows = alignSteps(steps(wf("a", "b", "c")), steps(wf("c", "a", "b")));
    expect(rows.map((r) => ({ kind: r.kind, left: r.left, right: r.right, to: r.to, from: r.from }))).toEqual([
      { kind: "moved", left: null, right: 0, to: undefined, from: 2 },
      { kind: "same", left: 0, right: 1, to: undefined, from: undefined },
      { kind: "same", left: 1, right: 2, to: undefined, from: undefined },
      { kind: "moved", left: 2, right: null, to: 0, from: undefined },
    ]);
  });

  test("on a tie the left step goes first: two swapped steps pair the second and move the first", () => {
    expect(kinds(alignSteps(steps(wf("a", "b")), steps(wf("b", "a"))))).toEqual([
      ["moved", 0, null],
      ["same", 1, 0],
      ["moved", null, 1],
    ]);
  });

  test("each row's insert position is right after the last left step above it", () => {
    const rows = alignSteps(steps(wf("a", "x", "b")), steps(wf("a", "n", "b", "m")));
    expect(rows.map((r) => [r.kind, r.at])).toEqual([
      ["same", 0],
      ["left", 1],
      ["right", 2],
      ["same", 2],
      ["right", 3],
    ]);
  });

  test("a moved step counts once; the rest once per row", () => {
    expect(rowCounts(alignSteps(steps(wf("a", "b", "c", "x")), steps(wf("c", "a", "b", "y"))))).toEqual({
      same: 2,
      changed: 0,
      left: 1,
      right: 1,
      moved: 1,
    });
  });

  test("the four shipped fuse/ workflows share only intake", () => {
    for (const a of FUSE)
      for (const b of FUSE) {
        if (a === b) continue;
        const rows = alignSteps(steps(read(a)), steps(read(b)));
        const paired = rows.filter((r) => r.left !== null && r.right !== null).map((r) => steps(read(a))[r.left!].id);
        expect({ a, b, paired }).toEqual({ a, b, paired: ["intake"] });
      }
  });

  test("custom-example-medium against -large gives the reference screenshot's counts", () => {
    const rows = alignSteps(steps(read("customization-examples/custom-example-medium.yml")), steps(read("customization-examples/custom-example-large.yml")));
    expect(rowCounts(rows)).toEqual({ same: 0, changed: 6, left: 1, right: 11, moved: 0 });
  });
});

describe("foldedStep", () => {
  const rows = alignSteps(steps(wf("a", "b", "x")), steps(wf("a", "b", "y")));

  test("a left step whose row is the same is folded away while only differences is on", () => {
    expect([0, 1, 2].map((i) => foldedStep(rows, i, true))).toEqual([true, true, false]);
  });

  test("with only differences off, no step is folded", () => {
    expect([0, 1, 2].map((i) => foldedStep(rows, i, false))).toEqual([false, false, false]);
  });
});

describe("compareItems", () => {
  const rows = alignSteps(steps(wf("a", "b", "c", "x", "d")), steps(wf("a", "b", "c", "y", "d")));
  const left = steps(wf("a", "b", "c", "x", "d"));

  test("with only differences off, every row is shown", () => {
    expect(compareItems(rows, left, false).map((i) => i.type)).toEqual(["row", "row", "row", "row", "row", "row"]);
  });

  test("with only differences on, each run of same rows folds into one gap naming its steps", () => {
    expect(compareItems(rows, left, true).map((i) => (i.type === "gap" ? i.ids : i.row.kind))).toEqual([["a", "b", "c"], "left", "right", ["d"]]);
  });
});

describe("stepDiff", () => {
  const base = `version: 1
name: base
steps:
  - id: a
    instruction: Make it.
    produces:
      - artifact: doc
        path: doc.md
  - id: s
    title: Step
    phase: Build
    description: What it does.
    instruction: Do it.
    condition:
      check: default
    consumes: [doc]
    produces:
      - artifact: out
        path: out.md
    gates:
      - owner-action: Approve.
      - agent: Review.
        max_rounds: 2
`;
  const diffOf = (from: string, to: string) => {
    expect(base.includes(from)).toBe(true);
    return stepDiff(steps(base)[1], steps(base.replace(from, to))[1]);
  };
  const none = stepDiff(steps(base)[1], steps(base)[1]);

  test("equal steps have no differences", () => {
    expect(hasDifferences(none)).toBe(false);
  });

  const cases: [string, string, string, Partial<typeof none>][] = [
    ["title", "    title: Step\n", "    title: Other\n", { title: true }],
    ["phase", "    phase: Build\n", "    phase: Ship\n", { phase: true }],
    ["description", "    description: What it does.\n", "    description: Something else.\n", { description: true }],
    ["instruction", "    instruction: Do it.\n", "    instruction: Do it again.\n", { instruction: true }],
    ["condition", "      check: default\n    consumes", "      owner-action: only if asked\n    consumes", { condition: true }],
    ["a consume on the left only", "    consumes: [doc]\n", "    consumes: []\n", { consumesLeft: ["doc"] }],
    ["an output path", "        path: out.md\n", "        path: elsewhere.md\n", { outputsChanged: ["produces:out"] }],
    ["an output's mode", "    produces:\n      - artifact: out", "    updates:\n      - artifact: out", { outputsChanged: ["produces:out", "updates:out"] }],
    ["a gate's text", "      - owner-action: Approve.\n", "      - owner-action: Approve twice.\n", { gatesLeft: [0], gatesRight: [0] }],
    ["a gate's settings", "        max_rounds: 2\n", "        max_rounds: 3\n", { gatesChanged: [{ left: 1, right: 1 }] }],
  ];
  for (const [name, from, to, expected] of cases)
    test(`a change only in ${name} is reported as that element`, () => {
      expect(diffOf(from, to)).toEqual({ ...none, ...expected });
    });

  test("gates are compared by content, not by the order of their keys", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - agent: Review.\n        max_rounds: 2\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - max_rounds: 2\n        agent: Review.\n`;
    expect(hasDifferences(stepDiff(steps(a)[0], steps(b)[0]))).toBe(false);
  });

  test("an instruction is compared as fuse-flow reads it: trimmed, its line breaks and indentation kept", () => {
    // The v3 spec's earlier agent decision normalised all whitespace, which
    // labelled instructions whose code differs only in indentation as
    // identical (c-k-docs2-2). Only the scalar style and the trailing line
    // break, which the YAML parser and the engine's trim remove, do not count.
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: >-\n      Do it.\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: >\n      Do\n      it.\n`;
    const c = `version: 1\nname: c\nsteps:\n  - id: s\n    instruction: |\n      Do\n      it.\n`;
    const d = `version: 1\nname: d\nsteps:\n  - id: s\n    instruction: Do that.\n`;
    expect(stepDiff(steps(a)[0], steps(b)[0]).instruction).toBe(false);
    expect(stepDiff(steps(a)[0], steps(c)[0]).instruction).toBe(true);
    expect(stepDiff(steps(a)[0], steps(d)[0]).instruction).toBe(true);
  });

  test("instructions whose code differs only in indentation differ", () => {
    const code = (indent: string) =>
      `version: 1\nname: w\nsteps:\n  - id: task\n    instruction: |\n      def clean(enabled):\n          if enabled:\n              log_action()\n      ${indent}delete_file()\n`;
    expect(stepDiff(steps(code("        "))[0], steps(code("    "))[0]).instruction).toBe(true);
    expect(stepDiff(steps(code("    "))[0], steps(code("    "))[0]).instruction).toBe(false);
  });
});

describe("wordDiff", () => {
  test("marks the words only in the left text on the left, and only in the right text on the right", () => {
    expect(wordDiff("a b c", "a x c")).toEqual({
      left: [
        { text: "a ", changed: false },
        { text: "b", changed: true },
        { text: " c", changed: false },
      ],
      right: [
        { text: "a ", changed: false },
        { text: "x", changed: true },
        { text: " c", changed: false },
      ],
    });
  });

  test("the space between two changed words is part of the change, so it reads as one run", () => {
    expect(wordDiff("a b c d", "a x y d")).toEqual({
      left: [
        { text: "a ", changed: false },
        { text: "b c", changed: true },
        { text: " d", changed: false },
      ],
      right: [
        { text: "a ", changed: false },
        { text: "x y", changed: true },
        { text: " d", changed: false },
      ],
    });
  });

  test("any whitespace matches any other, and each side keeps its own", () => {
    expect(wordDiff("a  b\nc", "a b c")).toEqual({ left: [{ text: "a  b\nc", changed: false }], right: [{ text: "a b c", changed: false }] });
  });

  test("lineDiff is unchanged by the shared subsequence", () => {
    expect(lineDiff("a\nb\nc", "a\nc\nd")).toEqual([
      { kind: " ", text: "a" },
      { kind: "-", text: "b" },
      { kind: " ", text: "c" },
      { kind: "+", text: "d" },
    ]);
  });
});

describe("gates with the same kind and text", () => {
  // The schema allows two gates of one kind with the same text; they are
  // paired one to one, not matched as a set.
  const reviews = (...rounds: number[]) =>
    `version: 1\nname: r\nsteps:\n  - id: s\n    instruction: x\n    gates:\n${rounds.map((n) => `      - agent: Review.\n        max_rounds: ${n}\n`).join("")}`;
  const roundsOf = (text: string) => steps(text)[0].gates.map((g) => g.max_rounds);

  test("identical same-text gates with distinct settings compare as the same in the same order, and as reordered in the other", () => {
    // fuse-flow runs reviews in file order and numbers them so: review 1
    // gets the first gate's rounds. Swapped, the step runs differently.
    const [x, same] = [steps(reviews(2, 3))[0], steps(reviews(2, 3))[0]];
    expect({ differs: hasDifferences(stepDiff(x, same)), lines: differences(x, same, 0).length }).toEqual({ differs: false, lines: 0 });
    const swapped = steps(reviews(3, 2))[0];
    expect(differences(x, swapped, 0).map((d) => d.label)).toEqual(["gate order (agent reviews) → Review., Review."]);
    // Copying the step makes the left run as the right does.
    const out = run(reviews(2, 3), copyStepEdits([swapped], 0, [x]));
    expect(roundsOf(out)).toEqual([3, 2]);
    expect(hasDifferences(stepDiff(steps(out)[0], swapped))).toBe(false);
  });

  test("a change in the second same-text gate's settings is one difference, applied to that gate", () => {
    const [left, right] = [reviews(2, 3), reviews(2, 4)];
    const list = differences(steps(left)[0], steps(right)[0], 0);
    expect(list.map((d) => d.label)).toEqual(["gate agent: Review. (settings)"]);
    expect(list[0].edits).toEqual([{ op: "setGate", step: 0, index: 1, fields: { description: null, max_rounds: 4, guide: null, route_back_to: [] } }]);
    const out = run(left, list[0].edits);
    expect(roundsOf(out)).toEqual([2, 4]);
    expect(hasDifferences(stepDiff(steps(out)[0], steps(right)[0]))).toBe(false);
  });

  test("a duplicate gate on one side is reported once, as removed or added, and its apply round-trips to the same", () => {
    for (const [left, right, mark, op] of [
      [reviews(2, 2), reviews(2), "del", "removeGate"],
      [reviews(2), reviews(2, 2), "add", "addGate"],
    ] as const) {
      const list = differences(steps(left)[0], steps(right)[0], 0);
      expect(list.map((d) => [d.mark, d.label, d.edits[0]?.op])).toEqual([[mark, "gate agent: Review.", op]]);
      const out = run(left, list[0].edits);
      expect(roundsOf(out)).toEqual(roundsOf(right));
      expect(hasDifferences(stepDiff(steps(out)[0], steps(right)[0]))).toBe(false);
    }
  });

  test("a removed duplicate is the left gate that has no match, not the first with its text", () => {
    const list = differences(steps(reviews(3, 2))[0], steps(reviews(2))[0], 0);
    expect(list.map((d) => d.edits)).toEqual([[{ op: "removeGate", step: 0, index: 0 }]]);
  });

  // Gates of one rank run in file order, so an added gate that the right
  // step runs before a gate both steps have cannot be appended after it.
  const scripts = (list: string[]) =>
    `version: 1\nname: w\nsteps:\n  - id: s\n    instruction: x\n    gates:\n${list.map((s) => `      - script: ${s}\n`).join("")}`;
  const gateTexts = (text: string) => steps(text)[0].gates.map((g) => g.text);

  test("an added gate that runs before a gate both steps have is refused, pointing to the whole-step copy", () => {
    for (const [left, right] of [
      [["test -f marker"], ["touch marker", "test -f marker"]],
      [["a", "c"], ["a", "b", "c"]],
    ]) {
      const list = differences(steps(scripts(left))[0], steps(scripts(right))[0], 0);
      expect(list.length).toBe(1);
      expect(list[0].edits).toEqual([]);
      expect(list[0].refused).toMatch(/Make the left step match/);
    }
  });

  test("an added gate whose place is the end of its rank is applied there", () => {
    const left = scripts(["a"]);
    const right = scripts(["a", "b"]);
    const [d] = differences(steps(left)[0], steps(right)[0], 0);
    expect(d.refused).toBeUndefined();
    expect(gateTexts(run(left, d.edits))).toEqual(["a", "b"]);
  });

  test("an added gate before a gate of another rank is applied, since ranks run in their own order", () => {
    const left = "version: 1\nname: w\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - agent: Review.\n";
    const right = "version: 1\nname: w\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - script: bun test\n      - agent: Review.\n";
    const [d] = differences(steps(left)[0], steps(right)[0], 0);
    expect(d.refused).toBeUndefined();
    expect(gateTexts(run(left, d.edits))).toEqual(["Review.", "bun test"]);
  });
});

describe("applies never block the applies that repair them", () => {
  // Applies every row's actions one at a time, as a user would: per
  // difference, then Add, remove and Move. Before each, the guard must allow
  // it; at the end every row is the same.
  function converge(leftText: string, rightText: string) {
    let text = leftText;
    const right = open(rightText, "right.yml");
    const ys = stepViews(right);
    const applied: string[] = [];
    for (let round = 0; round < 50; round++) {
      const xs = steps(text);
      const rows = alignSteps(xs, ys);
      const row = rows.find((r) => r.kind !== "same");
      if (!row) return { text, applied };
      let label: string;
      let edits: Edit[];
      if (row.kind === "changed") {
        const next = differences(xs[row.left!], ys[row.right!], row.left!).find((d) => !d.refused)!;
        [label, edits] = [next.label, next.edits];
      } else if (row.kind === "right") [label, edits] = [`add ${ys[row.right!].id}`, copyStepEdits(ys, row.right!, xs, row.at)];
      else if (row.kind === "left") [label, edits] = [`remove ${xs[row.left!].id}`, removeEdits(row)];
      else if (row.right !== null) [label, edits] = [`move ${ys[row.right].id}`, moveEdits(row)];
      else continue;
      expect({ before: label, problem: applyProblem(open(text), right) }).toEqual({ before: label, problem: null });
      text = run(text, edits);
      applied.push(label);
    }
    throw new Error(`no convergence: ${applied.join(" | ")}`);
  }

  test("F4: a shorthand gate and an output whose mode differs converge to the same", () => {
    const step = (mode: string) =>
      `version: 1\nname: w\nsteps:\n  - id: s\n    instruction: Work.\n    gates: 'agent: Review.'\n    ${mode}: {artifact: doc, path: doc.md}\n`;
    const [left, right] = [step("produces"), step("updates")];
    expect([open(left).parsed !== null, open(right).parsed !== null]).toEqual([true, true]);
    const { text, applied } = converge(left, right);
    expect(applied).toEqual(["doc mode → updates"]);
    expect(hasDifferences(stepDiff(steps(text)[0], steps(right)[0]))).toBe(false);
    expect(steps(text)[0].gates.map((g) => `${g.kind}: ${g.text}`)).toEqual(["agent: Review."]);
  });

  test("a shorthand condition and a temporarily dangling consume do not block the applies that follow", () => {
    const left = `version: 1\nname: l\nsteps:\n  - id: s\n    instruction: Work.\n    condition: 'agent: when it helps'\n    gates: 'script("bun test")'\n`;
    const right = `version: 1\nname: r\nsteps:\n  - id: a\n    instruction: Make doc.\n    produces:\n      - artifact: doc\n        path: doc.md\n  - id: s\n    instruction: Work on doc.\n    condition: 'agent: when it helps'\n    consumes: [doc]\n    gates: 'script("bun test")'\n`;
    expect([open(left).parsed !== null, open(right).parsed !== null]).toEqual([true, true]);
    // Apply the changed step first, so the left consumes doc before any step produces it.
    const xs = steps(left);
    const ys = steps(right);
    const consume = differences(xs[0], ys[1], 0).find((d) => d.label === "consumes doc")!;
    const dangling = run(left, consume.edits);
    expect(open(dangling).parsed).toBeNull();
    expect(applyProblem(open(dangling), open(right, "right.yml"))).toBeNull();
    const { text } = converge(dangling, right);
    expect(alignSteps(steps(text), ys).every((r) => r.kind === "same")).toBe(true);
    expect(steps(text)[1].condition).toEqual({ kind: "agent", text: "when it helps" });
  });
});

describe("readsCompletely", () => {
  const invalid = (gate: string, condition = "'agent: when it helps'") =>
    open(`version: 1\nname: i\nsteps:\n  - id: s\n    instruction: x\n    consumes: [nowhere]\n    condition: ${condition}\n    gates:\n      - ${gate}\n      - owner-action: Approve.\n`);

  test("a workflow that does not parse but writes gates and conditions in the engine's shorthand is read completely, each at its position", () => {
    for (const gate of [`'agent: Review.'`, `'script("bun test")'`]) {
      const w = invalid(gate);
      expect(w.parsed).toBeNull();
      expect({ gate, complete: readsCompletely(w) }).toEqual({ gate, complete: true });
      const [s] = stepViews(w);
      expect(s.gates.map((g) => g.kind)).toEqual([gate.includes("agent") ? "agent" : "script", "owner-action"]);
      expect(s.condition).toEqual({ kind: "agent", text: "when it helps" });
    }
  });

  test("a gate or condition no reader understands is still not read completely", () => {
    expect(readsCompletely(invalid("42"))).toBe(false);
    expect(readsCompletely(invalid(`'nonsense'`))).toBe(false);
    expect(readsCompletely(invalid(`'agent: Review.'`, "42"))).toBe(false);
  });
});

describe("output mode changes", () => {
  const step = (mode: string, path = "doc.md") =>
    `version: 1\nname: w\nsteps:\n  - id: s\n    instruction: Work.\n    ${mode}:\n      - artifact: doc\n        path: ${path}\n`;

  test("a change of mode is one difference, which applies at once and leaves the step the same", () => {
    for (const [from, to, label] of [
      ["produces", "updates", "doc mode → updates"],
      ["updates", "optional_produces", "doc mode → may produce"],
      ["optional_produces", "produces", "doc mode → produces"],
    ]) {
      const [left, right] = [step(from), step(to)];
      const list = differences(steps(left)[0], steps(right)[0], 0);
      expect(list.map((d) => [d.mark, d.label])).toEqual([["chg", label]]);
      const out = run(left, list[0].edits);
      expect(open(out).parsed).not.toBeNull();
      expect(hasDifferences(stepDiff(steps(out)[0], steps(right)[0]))).toBe(false);
    }
  });

  test("a change of mode and path is one difference too", () => {
    const [left, right] = [step("produces"), step("updates", "other.md")];
    const list = differences(steps(left)[0], steps(right)[0], 0);
    expect(list.map((d) => d.label)).toEqual(["doc mode → updates, path → other.md"]);
    expect(hasDifferences(stepDiff(steps(run(left, list[0].edits))[0], steps(right)[0]))).toBe(false);
  });

  test("Apply all still makes such a step strictly equal", () => {
    const [left, right] = [step("produces"), step("updates", "other.md")];
    const out = run(left, copyStepEdits(steps(right), 0, steps(left)));
    expect(strictDifferences(steps(out)[0], steps(right)[0])).toEqual([]);
  });
});

describe("differences", () => {
  test("lists each difference of a changed pair with its label and mark, in the design's order", () => {
    const [x, y] = [steps(LEFT)[1], steps(RIGHT)[2]];
    expect(differences(x, y, 1).map((d) => [d.mark, d.label])).toEqual([
      ["add", "title → Build"],
      ["chg", "instruction"],
      ["add", "gate agent: Review it."],
      ["del", "gate owner: Approve."],
    ]);
  });

  test("a removed title, phase, description or condition says remove", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    title: T\n    phase: P\n    description: D\n    instruction: x\n    condition:\n      check: c\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: x\n`;
    expect(differences(steps(a)[0], steps(b)[0], 0).map((d) => [d.mark, d.label])).toEqual([
      ["del", "remove title"],
      ["del", "remove phase"],
      ["del", "remove description"],
      ["del", "remove condition"],
    ]);
  });

  // Applies each difference on its own, re-reading the left step each time:
  // that difference goes, no other appears, and in the end the step is the
  // same as the right one, except for the differences refused.
  function applyOneByOne(leftText: string, rightText: string, index: number, rightIndex: number) {
    let text = leftText;
    const y = steps(rightText)[rightIndex];
    for (;;) {
      const list = differences(steps(text)[index], y, index);
      const next = list.find((d) => !d.refused);
      if (!next) return { text, refused: list };
      // An apply that succeeded never blocks the ones that repair the rest.
      expect({ before: next.label, problem: applyProblem(open(text), open(rightText, "right.yml")) }).toEqual({ before: next.label, problem: null });
      const after = run(text, next.edits);
      const labels = differences(steps(after)[index], y, index).map((d) => d.label);
      expect({ applied: next.label, remaining: labels }).toEqual({
        applied: next.label,
        remaining: list.filter((d) => d !== next).map((d) => d.label),
      });
      text = after;
    }
  }

  const fixture = `version: 1
name: f
steps:
  - id: a
    instruction: Make doc.
    produces:
      - artifact: doc
        path: doc.md
      - artifact: extra
        path: extra.md
  - id: s
    title: Step
    phase: Build
    description: Old words.
    instruction: Do it   now.
    condition:
      check: default
    consumes: [doc, extra]
    produces:
      - artifact: out
        path: out.md
        description: The out.
      - artifact: gone
        path: gone.md
    optional_produces:
      - artifact: maybe
        path: maybe.md
    gates:
      - owner-action: Approve.
      - agent: Review.
        max_rounds: 2
        route_back_to: a
`;
  const target = `version: 1
name: g
steps:
  - id: a
    instruction: Make doc.
    produces:
      - artifact: doc
        path: doc.md
  - id: s
    title: Other
    description: New words.
    instruction: |
      Do it later,
      and well.
    condition:
      owner-action: only if asked
      description: Ask first.
    consumes: [doc]
    produces:
      - artifact: out
        path: elsewhere.md
      - artifact: fresh
        path: fresh.md
        description: New one.
    updates:
      - artifact: maybe
        path: maybe.md
    gates:
      - agent: Review.
        guide: guides/review.md
        max_rounds: 3
      - script: bun test
        description: Tests.
`;

  test("every kind of difference applies on its own and round-trips the step to the same", () => {
    const { text, refused } = applyOneByOne(fixture, target, 1, 1);
    expect(refused).toEqual([]);
    expect(strictDifferences(steps(text)[1], steps(target)[1]).filter((f) => !["consumes", "artifacts", "gates"].includes(f))).toEqual([]);
    expect(hasDifferences(stepDiff(steps(text)[1], steps(target)[1]))).toBe(false);
    // The other step is untouched.
    expect(strictDifferences(steps(text)[0], steps(fixture)[0])).toEqual([]);
  });

  test("every changed pair of the shipped examples applies one by one to the same", () => {
    const all = EXAMPLES;
    for (const a of all)
      for (const b of all) {
        if (a === b) continue;
        const rows = alignSteps(steps(read(a)), steps(read(b)));
        for (const row of rows.filter((r) => r.kind === "changed")) {
          const { refused } = applyOneByOne(read(a), read(b), row.left!, row.right!);
          for (const r of refused) expect(r.refused).toMatch(/workflow gate/);
        }
      }
  }, 30_000);

  test("a workflow gate with a slug, inputs or returns is refused, not added without them", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: x\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - workflow: child\n        slug: "{slug}-kid"\n`;
    const [d] = differences(steps(a)[0], steps(b)[0], 0);
    expect(d.label).toBe("gate workflow: child");
    expect(d.edits).toEqual([]);
    expect(d.refused).toMatch(/slug, inputs or returns/);
  });

  test("a workflow gate whose slug, inputs or returns differ is refused; its other settings apply", () => {
    const gate = (extra: string) => `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - workflow: child\n${extra}`;
    const slugged = differences(steps(gate(`        slug: a\n`))[0], steps(gate(`        slug: b\n`))[0], 0);
    expect(slugged.map((d) => [d.label, !!d.refused])).toEqual([["gate workflow: child (settings)", true]]);
    const left = gate(`        slug: a\n        description: Old.\n`);
    const right = gate(`        slug: a\n        description: New.\n`);
    const [described] = differences(steps(left)[0], steps(right)[0], 0);
    expect(described.refused).toBeUndefined();
    expect(hasDifferences(stepDiff(steps(run(left, described.edits))[0], steps(right)[0]))).toBe(false);
  });
});

describe("applying whole steps", () => {
  const medium = read("customization-examples/custom-example-medium.yml");
  const large = read("customization-examples/custom-example-large.yml");

  test("Apply all makes a changed left step strictly equal to the right one, in place", () => {
    const rows = alignSteps(steps(medium), steps(large)).filter((r) => r.kind === "changed");
    for (const row of rows) {
      const out = run(medium, copyStepEdits(steps(large), row.right!, steps(medium)));
      expect(ids(out)).toEqual(ids(medium));
      expect(strictDifferences(steps(out)[row.left!], steps(large)[row.right!])).toEqual([]);
    }
  });

  test("Add to left inserts an only-right step at its row's position, where it then pairs as the same", () => {
    for (const row of alignSteps(steps(medium), steps(large)).filter((r) => r.kind === "right")) {
      const out = run(medium, copyStepEdits(steps(large), row.right!, steps(medium), row.at));
      expect(steps(out)[row.at].id).toBe(steps(large)[row.right!].id);
      const paired = alignSteps(steps(out), steps(large)).find((r) => r.right === row.right)!;
      expect({ id: steps(out)[row.at].id, kind: paired.kind }).toEqual({ id: steps(out)[row.at].id, kind: "same" });
    }
  });

  test("remove from left deletes an only-left step", () => {
    const row = alignSteps(steps(LEFT), steps(RIGHT)).find((r) => r.kind === "left")!;
    expect(ids(run(LEFT, removeEdits(row)))).toEqual(["intake", "build"]);
  });

  test("Move left step here moves the step to the row's position, where it then pairs", () => {
    for (const [l, r] of [
      [wf("a", "b", "c"), wf("c", "a", "b")],
      [wf("a", "b", "c"), wf("b", "c", "a")],
      [wf("a", "b"), wf("b", "a")],
      [wf("a", "x", "b", "c"), wf("a", "c", "b")],
    ]) {
      for (const row of alignSteps(steps(l), steps(r)).filter((x) => x.kind === "moved" && x.right !== null)) {
        const out = run(l, moveEdits(row));
        const after = alignSteps(steps(out), steps(r)).find((x) => x.right === row.right)!;
        expect({ l, r, row: row.right, kind: after.kind }).toEqual({ l, r, row: row.right, kind: "same" });
      }
    }
  });
});

describe("apply guards", () => {
  const broken = openWorkflow({
    location: "project", dir: "", file: "b.yml", path: "/b.yml", onDisk: true, hash: "",
    text: `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: Do it.\n    gates: ['script("bun run check")']\n  - id: t\n    instruction: ""\n`,
  });
  const valid = open(`version: 1\nname: t\nsteps:\n  - id: other\n    instruction: X.\n`, "t.yml");

  test("a workflow that does not parse cannot be copied from, so no gate or condition is lost", () => {
    expect(broken.parsed).toBeNull();
    expect(copySourceProblem(broken)).toMatch(/Fix the problems/);
    expect(copySourceProblem(valid)).toBeNull();
  });

  test("nothing is applied from a workflow that does not parse, or to another project's workflow", () => {
    expect(applyProblem(valid, broken)).toMatch(/Fix the problems in b.yml before copying/);
    expect(applyProblem(valid, valid)).toBeNull();
    expect(applyProblem({ ...valid, location: "run" }, valid)).toMatch(/read-only/);
  });

  test("nothing is applied to a left workflow whose shown steps leave out part of its YAML", () => {
    // A gate the engine accepts in its string shorthand is read; one in no
    // form the engine knows is not.
    expect(applyProblem(broken, valid)).toBeNull();
    const unreadable = open(`version: 1\nname: u\nsteps:\n  - id: s\n    instruction: x\n    gates: [42]\n`, "u.yml");
    expect(unreadable.parsed).toBeNull();
    expect(applyProblem(unreadable, valid)).toMatch(/Fix the problems in u.yml before applying/);
    const pathless = open(`version: 1\nname: p\nsteps:\n  - id: s\n    instruction: x\n    produces:\n      - artifact: doc\n`, "p.yml");
    expect(pathless.parsed).toBeNull();
    expect(applyProblem(pathless, valid)).toMatch(/Fix the problems in p.yml before applying/);
  });

  test("a left workflow that only fails to parse for a problem its steps show, such as a dangling consume, still takes applies", () => {
    // An Apply all can leave the left consuming what no earlier step
    // produces yet; the next apply (adding the producing step) must still work.
    const dangling = open(`version: 1\nname: d\nsteps:\n  - id: s\n    instruction: x\n    consumes: [nowhere]\n    gates:\n      - owner-action: Approve.\n`, "d.yml");
    expect(dangling.parsed).toBeNull();
    expect(applyProblem(dangling, valid)).toBeNull();
  });
});

describe("defaultComparePair", () => {
  test("the left side starts on the open workflow and the right on the first other one", () => {
    expect(defaultComparePair(["a", "b", "c"], "b")).toEqual(["b", "a"]);
  });

  test("with no open workflow, the first two in list order", () => {
    expect(defaultComparePair(["a", "b", "c"], null)).toEqual(["a", "b"]);
  });

  test("an open workflow that is not listed is ignored", () => {
    expect(defaultComparePair(["a", "b"], "zzz")).toEqual(["a", "b"]);
  });

  test("with only one workflow, the right side is empty, never the left's workflow", () => {
    expect(defaultComparePair(["a"], "a")).toEqual(["a", null]);
  });

  test("with none, both sides are empty", () => {
    expect(defaultComparePair([], null)).toEqual([null, null]);
  });
});

describe("copyStepEdits", () => {
  const text = (name: string) => read(`fuse/${name}.yml`);
  const NAMES = ["fuse-dependency-migration", "fuse-feature-development", "fuse-rapid-prototyping", "fuse-system-development"];

  const copyInto = (targetText: string, from: ReturnType<typeof steps>, index: number) => run(targetText, copyStepEdits(from, index, steps(targetText)));

  test("a step only on the source side is inserted, and then compares as the same", () => {
    const source = steps(text("fuse-system-development"));
    const index = source.findIndex((s) => s.id === "system-design");
    const out = copyInto(text("fuse-feature-development"), source, index);
    const copied = steps(out).find((s) => s.id === "system-design")!;
    expect(strictDifferences(source[index], copied)).toEqual([]);
  });

  test("a changed step replaces the step with its id, at the same position", () => {
    const source = steps(text("fuse-system-development"));
    const target = text("fuse-feature-development");
    const out = copyInto(target, source, 0);
    expect(steps(out).map((s) => s.id)).toEqual(steps(target).map((s) => s.id));
    expect(strictDifferences(source[0], steps(out)[0])).toEqual([]);
  });

  test("an inserted step goes after the nearest earlier step both workflows share", () => {
    const source = steps(text("fuse-system-development"));
    const out = copyInto(text("fuse-feature-development"), source, 1);
    expect(steps(out).map((s) => s.id)).toEqual(["intake", "requirements", "design", "implementation", "code-review"]);
  });

  test("with no shared earlier step, the inserted step goes first", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: x\n    instruction: X.\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: y\n    instruction: Y.\n`;
    expect(steps(copyInto(b, steps(a), 0)).map((s) => s.id)).toEqual(["x", "y"]);
  });

  test("an inserted step goes at the given position when there is one", () => {
    const out = run(wf("a", "b", "c"), copyStepEdits(steps(wf("n")), 0, steps(wf("a", "b", "c")), 2));
    expect(ids(out)).toEqual(["a", "b", "n", "c"]);
  });

  test("every step of every shipped fuse/ workflow copies into every other exactly", () => {
    for (const from of NAMES)
      for (const to of NAMES) {
        if (from === to) continue;
        const source = steps(text(from));
        source.forEach((step, index) => {
          const out = copyInto(text(to), source, index);
          const copied = steps(out).find((s) => s.id === step.id)!;
          expect({ from, to, id: step.id, fields: strictDifferences(step, copied) }).toEqual({ from, to, id: step.id, fields: [] });
        });
      }
  });

  test("copying leaves every other step of the target as it was", () => {
    const target = text("fuse-feature-development");
    const out = copyInto(target, steps(text("fuse-rapid-prototyping")), 1);
    const before = steps(target);
    const after = steps(out).filter((s) => s.id !== "iterate");
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    before.forEach((s, i) => expect(strictDifferences(s, after[i])).toEqual([]));
  });
});

describe("workflow gates", () => {
  const WF = `version: 1
name: wf
steps:
  - id: delegate
    instruction: Hand the build to a child.
    gates:
      - workflow: fuse-feature-development
        slug: "{slug}-child"
`;
  const PLAIN = `version: 1\nname: p\nsteps:\n  - id: other\n    instruction: X.\n`;

  test("a step whose workflow gate has a slug, inputs or returns is refused, not copied without them", () => {
    expect(() => copyStepEdits(steps(WF), 0, steps(PLAIN))).toThrow(/workflow gate/);
  });

  test("a workflow gate without a slug, inputs or returns copies exactly", () => {
    const bare = WF.replace('        slug: "{slug}-child"\n', "");
    const out = run(PLAIN, copyStepEdits(steps(bare), 0, steps(PLAIN)));
    const copied = steps(out).find((s) => s.id === "delegate")!;
    expect(strictDifferences(steps(bare)[0], copied)).toEqual([]);
  });
});

describe("copy fidelity", () => {
  const TARGET = `version: 1\nname: t\nsteps:\n  - id: other\n    instruction: X.\n`;

  test("an instruction is copied exactly, repeated spaces included", () => {
    const src = `version: 1\nname: s\nsteps:\n  - id: s\n    instruction: Run printf '%s' 'a  b'  and  wait.\n`;
    const out = run(TARGET, copyStepEdits(steps(src), 0, steps(TARGET)));
    const copied = steps(out).find((s) => s.id === "s")!;
    expect(copied.instruction!.trimEnd()).toBe("Run printf '%s' 'a  b'  and  wait.");
    expect(strictDifferences(steps(src)[0], copied)).toEqual([]);
  });

  test("an applied instruction is written exactly too, repeated spaces included", () => {
    const src = `version: 1\nname: s\nsteps:\n  - id: other\n    instruction: Run printf '%s' 'a  b'  and  wait now.\n`;
    const [d] = differences(steps(TARGET)[0], steps(src)[0], 0);
    expect(steps(run(TARGET, d.edits))[0].instruction!.trimEnd()).toBe("Run printf '%s' 'a  b'  and  wait now.");
  });
});

describe("compareOrder", () => {
  test("lists the three locations in the lane's order, a folder's files among the names beside it, and no other project's", () => {
    const at = (location: "project" | "personal" | "fuse-flow" | "run", dir: string, file: string) =>
      openWorkflow({ location, dir, file, path: `/${location}/${dir}/${file}`, onDisk: true, text: wf("a"), hash: "" });
    const listed = compareOrder([
      at("fuse-flow", "customization-examples/superpowers", "superpowers.yml"),
      at("run", "", "theirs.yml"),
      at("fuse-flow", "customization-examples", "custom.yml"),
      at("project", "", "zeta.yml"),
      at("personal", "", "mine.yml"),
      at("project", "docs", "alpha.yml"),
    ]);
    expect(listed.map((w) => `${w.location}:${w.dir ? `${w.dir}/` : ""}${w.file}`)).toEqual([
      "project:docs/alpha.yml",
      "project:zeta.yml",
      "personal:mine.yml",
      "fuse-flow:customization-examples/custom.yml",
      "fuse-flow:customization-examples/superpowers/superpowers.yml",
    ]);
  });
});

describe("comparePair, with the left side following the selected workflow", () => {
  const keys = ["a", "b", "c"];

  test("the left side is the selected workflow, and the right side is kept", () => {
    expect(comparePair(keys, "b", "c")).toEqual(["b", "c"]);
    // Selecting another workflow elsewhere moves the left side with it.
    expect(comparePair(keys, "a", "c")).toEqual(["a", "c"]);
  });

  test("a right side that is gone, missing or the same as the left gives way to another workflow", () => {
    expect(comparePair(keys, "b", null)).toEqual(["b", "a"]);
    expect(comparePair(keys, "b", "zzz")).toEqual(["b", "a"]);
    expect(comparePair(keys, "b", "b")).toEqual(["b", "a"]);
  });

  test("with no listed selection, the left side starts from the first workflow", () => {
    expect(comparePair(keys, null, "c")).toEqual(["a", "c"]);
    expect(comparePair(keys, "zzz", null)).toEqual(["a", "b"]);
    expect(comparePair([], "a", "b")).toEqual([null, null]);
  });

  test("picking or swapping says which workflow to select and which stays on the right", () => {
    expect(comparePick(["a", "c"], "left", "b")).toEqual({ select: "b", right: "c" });
    expect(comparePick(["a", "c"], "right", "b")).toEqual({ select: "a", right: "b" });
    // Picking the right side's workflow for the left trades the two.
    expect(comparePick(["a", "c"], "left", "c")).toEqual({ select: "c", right: "a" });
    expect(comparePick(["a", "c"], "swap")).toEqual({ select: "c", right: "a" });
  });
});

describe("gate order as fuse-flow runs it", () => {
  const step = (...gates: string[]) =>
    `version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n    gates:\n${gates.map((g) => `      - ${g}\n`).join("")}`;

  test("reordered reviews are a difference", () => {
    const [left, right] = [step("agent: first review", "agent: second review"), step("agent: second review", "agent: first review")];
    const rows = alignSteps(steps(left), steps(right));
    expect(rows.map((r) => r.kind)).toEqual(["changed"]);
    const list = differences(steps(left)[0], steps(right)[0], 0);
    expect(list.map((d) => [d.mark, d.label])).toEqual([["chg", "gate order (agent reviews) → second review, first review"]]);
  });

  // rvk-views-7: the edits cannot move a gate, and recreating the gates
  // dropped their comments, which Komposer promises to keep.
  test("a gate order difference is refused rather than applied by recreating the gates without their comments", () => {
    const left = step("script: exit 0 # first policy comment", "check: lint", "script: exit 1 # last policy comment");
    const right = step("script: exit 1", "check: lint", "script: exit 0");
    const list = differences(steps(left)[0], steps(right)[0], 0);
    expect(list.map((d) => d.label)).toEqual(["gate order (checks and scripts) → exit 1, lint, exit 0"]);
    expect(list[0].edits).toEqual([]);
    expect(list[0].refused).toMatch(/cannot move gates without losing their comments/);
  });

  test("reordered checks and scripts are a difference, as one runs before the other", () => {
    const [left, right] = [step("script: touch marker", "script: test -f marker"), step("script: test -f marker", "script: touch marker")];
    expect(hasDifferences(stepDiff(steps(left)[0], steps(right)[0]))).toBe(true);
    const [mixed, swapped] = [step("check: lint", "script: make test"), step("script: make test", "check: lint")];
    expect(hasDifferences(stepDiff(steps(mixed)[0], steps(swapped)[0]))).toBe(true);
  });

  test("a move between kinds that keeps the order fuse-flow runs them in is no difference", () => {
    const [left, right] = [step("owner-action: Approve.", "agent: Review.", "check: lint"), step("check: lint", "agent: Review.", "owner-action: Approve.")];
    expect(hasDifferences(stepDiff(steps(left)[0], steps(right)[0]))).toBe(false);
  });
});

describe("relative references in two folders", () => {
  const at = (path: string, text: string) =>
    stepViews(openWorkflow({ location: "project", dir: "", file: path.split("/").pop()!, path, onDisk: true, text, hash: "" }));
  const guided = (guide: string) =>
    `version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - agent: Review.\n        guide: ${guide}\n`;
  const delegating = (child: string) => `version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - workflow: ${child}\n`;
  const plain = "version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n";

  test("the same guide text in two folders names two files, and a rewritten one names the same file", () => {
    const a = at("/p/a/w.yml", guided("review.md"))[0];
    expect(hasDifferences(stepDiff(a, at("/p/b/w.yml", guided("review.md"))[0], { left: "/p/a/w.yml", right: "/p/b/w.yml" }))).toBe(true);
    expect(hasDifferences(stepDiff(a, at("/p/b/w.yml", guided("../a/review.md"))[0], { left: "/p/a/w.yml", right: "/p/b/w.yml" }))).toBe(false);
  });

  test("a gate's guide applied into another folder is rewritten to name the same file", () => {
    const files = { left: "/p/destination/left.yml", right: "/p/source/right.yml" };
    const x = at(files.left, plain)[0];
    const y = at(files.right, guided("review.md"))[0];
    const [d] = differences(x, y, 0, files);
    const out = run(plain, d.edits);
    expect(at(files.left, out)[0].gates[0].guide).toBe("../source/review.md");
    expect(hasDifferences(stepDiff(at(files.left, out)[0], y, files))).toBe(false);
  });

  test("a step copied into another folder keeps the files its guide and child workflow name", () => {
    const files = { left: "/p/destination/left.yml", right: "/p/source/right.yml" };
    for (const [text, read] of [
      [guided("review.md"), (s: StepView) => s.gates[0].guide],
      [delegating("child.yml"), (s: StepView) => s.gates[0].text],
    ] as const) {
      const out = run(plain, copyStepEdits(at(files.right, text), 0, at(files.left, plain), undefined, files));
      expect(read(at(files.left, out)[0])).toMatch(/^\.\.\/source\//);
    }
    // In one folder nothing is rewritten.
    const same = { left: "/p/source/left.yml", right: "/p/source/right.yml" };
    const out = run(plain, copyStepEdits(at(same.right, guided("review.md")), 0, at(same.left, plain), undefined, same));
    expect(at(same.left, out)[0].gates[0].guide).toBe("review.md");
  });
});

describe("gate references as the files they name", () => {
  const at = (path: string, text: string) =>
    stepViews(openWorkflow({ location: "project", dir: "", file: path.split("/").pop()!, path, onDisk: true, text, hash: "" }));
  const delegating = (child: string) => `version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - workflow: ${child}\n`;
  const guided = (guide: string) =>
    `version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - agent: Review.\n        guide: ${guide}\n`;
  const plain = "version: 1\nname: g\nsteps:\n  - id: s\n    instruction: x\n";
  const W = "/p/.konductor/workflows";

  // rvk-views-1: fuse-flow reads a reference without "/" and without a YAML
  // extension as a name, so ../child rebased next to child must stay a path.
  test("an extensionless child path copied into the child's folder stays a path to that file", () => {
    const files = { left: `${W}/copy-left.yml`, right: `${W}/sub/copy-right.yml` };
    const out = run(plain, copyStepEdits(at(files.right, delegating("../child")), 0, at(files.left, plain), undefined, files));
    expect(at(files.left, out)[0].gates[0].text).toBe("./child");
    // fuse-flow reads it as a path, not as the name of child.yml.
    expect(engineReadsAsPath(at(files.left, out)[0].gates[0].text)).toBe(true);
    expect(hasDifferences(stepDiff(at(files.left, out)[0], at(files.right, delegating("../child"))[0], files))).toBe(false);
    const [d] = differences(at(files.left, plain)[0], at(files.right, delegating("../child"))[0], 0, files);
    expect(run(plain, d.edits)).toContain("workflow: ./child");
  });

  // rvk-views-8: an absolute reference names the same file however it is spelled.
  test("absolute and relative references to one file compare as the same gate", () => {
    const file = `${W}/w.yml`;
    const files = { left: file, right: file };
    const same = (a: string, b: string, make: (ref: string) => string) =>
      hasDifferences(stepDiff(at(file, make(a))[0], at(file, make(b))[0], files));
    expect(same("./child.yml", `${W}/./child.yml`, delegating)).toBe(false);
    expect(same("child.yml", `${W}//child.yml`, delegating)).toBe(false);
    expect(same(`${W}/sub/../child.yml`, `${W}/child.yml`, delegating)).toBe(false);
    expect(same("review.md", `${W}/./review.md`, guided)).toBe(false);
    expect(same("./child.yml", `${W}/other.yml`, delegating)).toBe(true);
    // An absolute reference is copied as it is written.
    const other = { left: "/q/left.yml", right: file };
    const out = run(plain, copyStepEdits(at(file, delegating(`${W}/./child.yml`)), 0, at(other.left, plain), undefined, other));
    expect(at(other.left, out)[0].gates[0].text).toBe(`${W}/./child.yml`);
  });
});
