// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { compareWorkflows, copySourceProblem, copyStepEdits, defaultComparePair, swapPair } from "../src/model/compare.ts";
import { applyEdit } from "../src/model/yamlEdit.ts";
import { artifactCount, gateCount, openWorkflow, routeBackCount, stepViews } from "../src/workflowView.ts";

function steps(text: string) {
  const w = openWorkflow({ location: "project", dir: "", file: "w.yml", path: "/w.yml", onDisk: true, text, hash: "" });
  return stepViews(w);
}

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

describe("compareWorkflows", () => {
  const result = compareWorkflows(steps(LEFT), steps(RIGHT));

  test("a step in both workflows with equal fields is the same on both sides", () => {
    expect(result.left[0]).toEqual({ id: "intake", status: "same", fields: [] });
    expect(result.right[0]).toEqual({ id: "intake", status: "same", fields: [] });
  });

  test("a step in both with differing fields is changed on both sides, naming each field", () => {
    const expected = { id: "build", status: "changed" as const, fields: ["title", "instruction", "gates"] };
    expect(result.left[1]).toEqual(expected);
    expect(result.right[2]).toEqual(expected);
  });

  test("a step on one side only is marked only-here on that side", () => {
    expect(result.left[2]).toEqual({ id: "only-left", status: "only-here", fields: [] });
    expect(result.right[1]).toEqual({ id: "extra", status: "only-here", fields: [] });
  });

  test("each side keeps its own step order, one entry per step", () => {
    expect(result.left.map((s) => s.id)).toEqual(["intake", "build", "only-left"]);
    expect(result.right.map((s) => s.id)).toEqual(["intake", "extra", "build"]);
  });

  test("the same workflow on both sides marks every step as the same", () => {
    const same = compareWorkflows(steps(RIGHT), steps(RIGHT));
    expect([...same.left, ...same.right].every((s) => s.status === "same")).toBe(true);
  });

  test("gates are compared by content, not by the order of their keys", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - agent: Review.\n        max_rounds: 2\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: x\n    gates:\n      - max_rounds: 2\n        agent: Review.\n`;
    expect(compareWorkflows(steps(a), steps(b)).left[0].status).toBe("same");
  });

  test("the counts equal those the editor's toolbar shows, with gates by kind", () => {
    const right = steps(RIGHT);
    expect(result.rightCounts).toEqual({
      steps: right.length,
      artifacts: artifactCount(right),
      routesBack: routeBackCount(right),
      gates: { "owner-action": 0, agent: 1, check: 0, script: 0, workflow: 0 },
    });
    expect(result.leftCounts.gates["owner-action"]).toBe(1);
    const total = Object.values(result.leftCounts.gates).reduce((n, v) => n + v, 0);
    expect(total).toBe(gateCount(steps(LEFT)));
  });

  test("the four shipped fuse/ workflows compare, sharing only intake", () => {
    const dir = `${import.meta.dir}/../../flow/workflows/fuse`;
    const read = (name: string) => steps(readFileSync(`${dir}/${name}.yml`, "utf8"));
    const names = ["fuse-dependency-migration", "fuse-feature-development", "fuse-rapid-prototyping", "fuse-system-development"];
    for (const a of names)
      for (const b of names) {
        if (a === b) continue;
        const r = compareWorkflows(read(a), read(b));
        expect({ a, b, shared: r.left.filter((s) => s.status !== "only-here").map((s) => s.id) }).toEqual({ a, b, shared: ["intake"] });
        expect({ a, b, shared: r.right.filter((s) => s.status !== "only-here").map((s) => s.id) }).toEqual({ a, b, shared: ["intake"] });
      }
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

  test("with only one workflow, both sides show it", () => {
    expect(defaultComparePair(["a"], "a")).toEqual(["a", "a"]);
  });

  test("with none, both sides are empty", () => {
    expect(defaultComparePair([], null)).toEqual([null, null]);
  });
});

describe("copyStepEdits", () => {
  const dir = `${import.meta.dir}/../../flow/workflows/fuse`;
  const text = (name: string) => readFileSync(`${dir}/${name}.yml`, "utf8");
  const NAMES = ["fuse-dependency-migration", "fuse-feature-development", "fuse-rapid-prototyping", "fuse-system-development"];

  const copyInto = (targetText: string, from: ReturnType<typeof steps>, index: number) =>
    copyStepEdits(from, index, steps(targetText)).reduce((t, edit) => applyEdit(t, edit), targetText);

  test("a step only on the source side is inserted, and then compares as the same", () => {
    const source = steps(text("fuse-system-development"));
    const index = source.findIndex((s) => s.id === "system-design");
    const out = copyInto(text("fuse-feature-development"), source, index);
    const result = compareWorkflows(source, steps(out));
    expect(result.left[index]).toEqual({ id: "system-design", status: "same", fields: [] });
  });

  test("a changed step replaces the step with its id, at the same position", () => {
    const source = steps(text("fuse-system-development"));
    const target = text("fuse-feature-development");
    const out = copyInto(target, source, 0);
    expect(steps(out).map((s) => s.id)).toEqual(steps(target).map((s) => s.id));
    expect(compareWorkflows(source, steps(out)).left[0].status).toBe("same");
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

  test("every step of every shipped fuse/ workflow copies into every other exactly", () => {
    for (const from of NAMES)
      for (const to of NAMES) {
        if (from === to) continue;
        const source = steps(text(from));
        source.forEach((step, index) => {
          const out = copyInto(text(to), source, index);
          const copied = steps(out).find((s) => s.id === step.id)!;
          const status = compareWorkflows([step], [copied]).left[0];
          expect({ from, to, ...status }).toEqual({ from, to, id: step.id, status: "same", fields: [] });
        });
      }
  });

  test("copying leaves every other step of the target as it was", () => {
    const target = text("fuse-feature-development");
    const out = copyInto(target, steps(text("fuse-rapid-prototyping")), 1);
    const before = steps(target);
    const after = steps(out).filter((s) => s.id !== "iterate");
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id));
    expect(compareWorkflows(before, after).left.every((s) => s.status === "same")).toBe(true);
  });
});

describe("swapPair", () => {
  test("exchanges the two sides", () => {
    expect(swapPair(["a", "b"])).toEqual(["b", "a"]);
  });
});

describe("compareWorkflows text normalization", () => {
  test("a final newline alone does not make an instruction differ, other whitespace does", () => {
    const a = `version: 1\nname: a\nsteps:\n  - id: s\n    instruction: >-\n      Do it.\n`;
    const b = `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: >\n      Do it.\n`;
    const c = `version: 1\nname: c\nsteps:\n  - id: s\n    instruction: |\n      Do\n      it.\n`;
    expect(compareWorkflows(steps(a), steps(b)).left[0].status).toBe("same");
    expect(compareWorkflows(steps(a), steps(c)).left[0].status).toBe("changed");
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

  test("a workflow gate is counted under its own kind", () => {
    expect(compareWorkflows(steps(WF), steps(PLAIN)).leftCounts.gates.workflow).toBe(1);
  });

  test("a step whose workflow gate has a slug, inputs or returns is refused, not copied without them", () => {
    expect(() => copyStepEdits(steps(WF), 0, steps(PLAIN))).toThrow(/workflow gate/);
  });

  test("a workflow gate without a slug, inputs or returns copies exactly", () => {
    const bare = WF.replace('        slug: "{slug}-child"\n', "");
    const out = copyStepEdits(steps(bare), 0, steps(PLAIN)).reduce((t, edit) => applyEdit(t, edit), PLAIN);
    const copied = steps(out).find((s) => s.id === "delegate")!;
    expect(compareWorkflows(steps(bare), [copied]).left[0].status).toBe("same");
  });
});

describe("compareWorkflows detects a difference in each compared field", () => {
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
`;
  const variants: [string, string, string][] = [
    ["title", "    title: Step\n", "    title: Other\n"],
    ["phase", "    phase: Build\n", "    phase: Ship\n"],
    ["description", "    description: What it does.\n", "    description: Something else.\n"],
    ["instruction", "    instruction: Do it.\n", "    instruction: Do it again.\n"],
    ["condition", "      check: default\n    consumes", "      owner-action: only if asked\n    consumes"],
    ["consumes", "    consumes: [doc]\n", "    consumes: []\n"],
    ["artifacts", "        path: out.md\n", "        path: elsewhere.md\n"],
    ["gates", "      - owner-action: Approve.\n", "      - owner-action: Approve twice.\n"],
  ];
  for (const [field, from, to] of variants)
    test(`a change only in ${field} is reported as that field`, () => {
      expect(base.includes(from)).toBe(true);
      const result = compareWorkflows(steps(base), steps(base.replace(from, to)));
      expect(result.left[1]).toEqual({ id: "s", status: "changed", fields: [field] });
    });
});

describe("copy fidelity", () => {
  const TARGET = `version: 1\nname: t\nsteps:\n  - id: other\n    instruction: X.\n`;

  test("an instruction is copied exactly, repeated spaces included", () => {
    const src = `version: 1\nname: s\nsteps:\n  - id: s\n    instruction: Run printf '%s' 'a  b'  and  wait.\n`;
    const out = copyStepEdits(steps(src), 0, steps(TARGET)).reduce((t, edit) => applyEdit(t, edit), TARGET);
    const copied = steps(out).find((s) => s.id === "s")!;
    expect(copied.instruction!.trimEnd()).toBe("Run printf '%s' 'a  b'  and  wait.");
    expect(compareWorkflows(steps(src), [copied]).left[0].status).toBe("same");
  });

  test("a workflow that does not parse cannot be copied from, so no gate or condition is lost", () => {
    const broken = openWorkflow({
      location: "project", dir: "", file: "b.yml", path: "/b.yml", onDisk: true, hash: "",
      text: `version: 1\nname: b\nsteps:\n  - id: s\n    instruction: Do it.\n    gates: ['script("bun run check")']\n  - id: t\n    instruction: ""\n`,
    });
    expect(broken.parsed).toBeNull();
    expect(copySourceProblem(broken)).toMatch(/Fix the problems/);
    const valid = openWorkflow({ ...broken, text: TARGET });
    expect(copySourceProblem(valid)).toBeNull();
  });
});
