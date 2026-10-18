// SPDX-License-Identifier: Apache-2.0
// End-to-end tests of applyEdit: real workflow files on disk, real edits, the
// real engine parser. No mocks of our own code.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseWorkflowText } from "../../flow/src/parse.ts";
import YAML from "yaml";
import { applyEdit, instructionTakesBlock, verifyEdit, type Edit } from "../src/model/yamlEdit.ts";

const WORKFLOWS_DIR = resolve(import.meta.dir, "..", "..", "flow", "workflows");

// Every *.yml under the workflows directory, at any depth, following
// symlinks (personal/ and team/ are symlinks to the real files). A link whose
// target is missing is skipped, as fuse-flow's own lookup skips it.
function listWorkflowFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "schemas") continue;
    const full = join(dir, name);
    if (!existsSync(full)) continue;
    const real = realpathSync(full);
    const st = statSync(real);
    if (st.isDirectory()) out.push(...listWorkflowFiles(real));
    else if (name.endsWith(".yml")) out.push(full);
  }
  return out;
}

const WORKFLOW_FILES = listWorkflowFiles(WORKFLOWS_DIR);

// A line-level diff: which 0-based line indices differ between two texts.
// Lines are compared by exact content; this is good enough to assert that a
// change stayed confined to the lines it should have touched.
function changedLines(a: string, b: string): Set<number> {
  const la = a.split("\n");
  const lb = b.split("\n");
  const max = Math.max(la.length, lb.length);
  const changed = new Set<number>();
  for (let i = 0; i < max; i++) {
    if (la[i] !== lb[i]) changed.add(i);
  }
  return changed;
}

function commentLines(text: string): Map<number, string> {
  const out = new Map<number, string>();
  text.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("#")) out.set(i, line);
  });
  return out;
}

describe("applyEdit on every real workflow file", () => {
  // personal/ and team/ are gitignored links to the owner's own workflows, so
  // a fresh clone has none; the tracked ones are always there. The count is a
  // floor, so adding a workflow does not break this test. Every file found,
  // tracked or not, is still tested below.
  const tracked = WORKFLOW_FILES.filter((f) => !/\/workflows\/(personal|team)\//.test(f));
  test("found at least five tracked workflow files", () => {
    expect(tracked.length).toBeGreaterThanOrEqual(5);
  });

  for (const file of WORKFLOW_FILES) {
    const rel = file.slice(WORKFLOWS_DIR.length + 1);

    test(`${rel}: a representative edit stays confined and keeps comments`, () => {
      const original = readFileSync(file, "utf8");
      const before = parseWorkflowText(original);
      expect(before.ok).toBe(true);
      if (!before.ok) return;
      const stepId = before.workflow.steps[0].id;
      const originalTitle = before.workflow.steps[0].title;
      expect(originalTitle).toBeDefined();
      if (originalTitle === undefined) return;
      const newTitle = `${originalTitle} (edited)`;

      const edited = applyEdit(original, { op: "setStepField", step: 0, key: "title", value: newTitle });

      // (a) parses OK
      const after = parseWorkflowText(edited);
      expect(after.ok).toBe(true);
      if (!after.ok) return;

      // (b) reflects the edit
      expect(after.workflow.steps[0].title).toBe(newTitle);
      expect(after.workflow.steps[0].id).toBe(stepId);

      // (c) only the existing title line differs. Using an existing field is
      // deliberate: an insertion shifts later line indices, so a same-index
      // comparison would falsely report every later line as changed.
      const changed = changedLines(original, edited);
      expect(changed.size).toBe(1);
      for (const line of changed) {
        expect(original.split("\n")[line]).toContain("title:");
        expect(edited.split("\n")[line]).toContain(`title: ${newTitle}`);
      }

      // (d) every original comment line outside the edited node survives
      const origComments = commentLines(original);
      const newComments = commentLines(edited);
      for (const [line, text] of origComments) {
        if (changed.has(line)) continue;
        expect(newComments.get(line)).toBe(text);
      }
    });

    test(`${rel}: no-op edit returns an identical string`, () => {
      const original = readFileSync(file, "utf8");
      const parsed = parseWorkflowText(original);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      const step = parsed.workflow.steps[0];

      const edited = applyEdit(original, { op: "setStepField", step: 0, key: "title", value: step.title ?? null });
      expect(edited).toBe(original);
    });
  }
});

// The lines that differ between two texts, as one region: everything before
// `start` and from `endA` (in a) / `endB` (in b) onward is identical. Unlike a
// same-index comparison, an insertion does not mark the lines after it.
function changedRegion(a: string, b: string): { start: number; endA: number; endB: number } {
  const la = a.split("\n");
  const lb = b.split("\n");
  let start = 0;
  while (start < la.length && start < lb.length && la[start] === lb[start]) start++;
  let endA = la.length;
  let endB = lb.length;
  while (endA > start && endB > start && la[endA - 1] === lb[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endA, endB };
}

// The 0-based line span [first, last] of step i in the file's text, widened
// over the comment and blank lines directly above it and the blank lines
// directly below it, which travel with the step when it moves.
function stepLines(text: string, i: number): [number, number] {
  const steps = YAML.parseDocument(text).get("steps") as YAML.YAMLSeq;
  const node = steps.items[i] as YAML.YAMLMap;
  const [start, , end] = node.range!;
  const lineOf = (offset: number) => text.slice(0, offset).split("\n").length - 1;
  const lines = text.split("\n");
  // The node's end offset points just past its last character.
  let first = lineOf(start);
  let last = lineOf(Math.max(start, end - 1));
  while (first > 0 && /^\s*(#.*)?$/.test(lines[first - 1])) first--;
  while (last + 1 < lines.length && lines[last + 1].trim() === "") last++;
  return [first, last];
}

// Acceptance (spec): on every real workflow, each kind of edit changes only
// lines inside the step it edits (or, for a move, the two steps it swaps), the
// result is a valid workflow that says what the edit said, and every comment
// outside those lines survives.
describe("acceptance: edits on every real workflow stay inside the step they edit", () => {
  for (const file of WORKFLOW_FILES) {
    const rel = file.slice(WORKFLOWS_DIR.length + 1);
    const original = readFileSync(file, "utf8");
    const parsed = parseWorkflowText(original);
    if (!parsed.ok) throw new Error(`${rel} does not parse`);
    const steps = parsed.workflow.steps;
    const last = steps.length - 1;
    const agentAt = steps.findIndex((s) => s.gates.some((g) => g.kind === "agent"));

    const cases: {
      name: string;
      edit: Edit;
      span: [number, number];
      raw?: boolean;
      check: (w: (typeof steps)[number][]) => void;
    }[] = [
      {
        name: "title",
        edit: { op: "setStepField", step: last, key: "title", value: "A new title" },
        span: [last, last],
        check: (w) => expect(w[last].title).toBe("A new title"),
      },
      {
        name: "folded instruction",
        edit: { op: "setInstruction", step: 0, text: `${"Do the work carefully. ".repeat(12)}Then stop.`, style: ">" },
        span: [0, 0],
        check: (w) => expect(w[0].instruction).toBe(`${"Do the work carefully. ".repeat(12)}Then stop.`),
      },
      {
        name: "literal instruction",
        edit: { op: "setInstruction", step: 0, text: "Line one.\nLine two.", style: "|" },
        span: [0, 0],
        check: (w) => expect(w[0].instruction).toBe("Line one.\nLine two."),
      },
      {
        name: "add an output",
        edit: { op: "addOutput", step: last, mode: "produces", artifact: "extra-notes", path: "docs/{slug}-notes.md" },
        span: [last, last],
        check: (w) => expect(w[last].produces.map((a) => a.artifact)).toContain("extra-notes"),
      },
      {
        name: "add a gate",
        edit: { op: "addGate", step: last, gate: { kind: "owner-action", text: "approve the extra" } },
        span: [last, last],
        check: (w) => expect(w[last].gates.map((g) => g.text)).toContain("approve the extra"),
      },
    ];
    if (agentAt >= 0) {
      const gateIndex = steps[agentAt].gates.findIndex((g) => g.kind === "agent");
      cases.push({
        name: "max_rounds and route_back_to on an agent gate",
        edit: { op: "setGate", step: agentAt, index: gateIndex, fields: { max_rounds: 4, route_back_to: [steps[0].id] } },
        span: [agentAt, agentAt],
        check: (w) => {
          const g = w[agentAt].gates.find((x) => x.kind === "agent")!;
          expect(g.max_rounds).toBe(4);
          expect(g.route_back_to).toEqual([steps[0].id]);
        },
      });
    }
    if (steps.length >= 3) {
      // A move may break consumes or route_back_to order, so this case checks
      // the raw step order instead of requiring a valid workflow.
      cases.push({
        name: "move a step",
        edit: { op: "moveStep", from: 1, to: 2 },
        span: [1, 2],
        raw: true,
        check: () => {},
      });
    }

    for (const c of cases) {
      test(`${rel}: ${c.name}`, () => {
        const edited = applyEdit(original, c.edit);
        if (c.raw) {
          const ids = (YAML.parse(edited).steps as { id: string }[]).map((x) => x.id);
          expect(ids).toEqual([steps[0].id, steps[2].id, steps[1].id, ...steps.slice(3).map((x) => x.id)]);
        } else {
          const after = parseWorkflowText(edited);
          if (!after.ok) throw new Error(`${rel} ${c.name}: ${JSON.stringify(after.issues)}`);
          c.check(after.workflow.steps);
        }
        const [first] = stepLines(original, c.span[0]);
        const [, lastLine] = stepLines(original, c.span[1]);
        const region = changedRegion(original, edited);
        // Unchanged before the edited step(s) and after them.
        expect(region.start).toBeGreaterThanOrEqual(first);
        expect(region.endA).toBeLessThanOrEqual(lastLine + 1);
        // Every comment outside the edited step(s) survives.
        const lines = original.split("\n");
        const keptBefore = lines.slice(0, first).join("\n");
        const keptAfter = lines.slice(lastLine + 1).join("\n");
        expect(edited.startsWith(keptBefore)).toBe(true);
        expect(edited.endsWith(keptAfter)).toBe(true);
      });
    }
  }
});

describe("setWorkflowField", () => {
  const text = `version: 1
name: demo
description: old description
steps:
  - id: one
    instruction: Do it.
`;

  test("sets name", () => {
    const edited = applyEdit(text, { op: "setWorkflowField", key: "name", value: "renamed" });
    expect(edited).toContain("name: renamed\n");
    expect(parseWorkflowText(edited)).toMatchObject({ ok: true });
    const changed = changedLines(text, edited);
    expect(changed).toEqual(new Set([1]));
  });

  test("sets description when absent", () => {
    const noDesc = `version: 1\nname: demo\nsteps:\n  - id: one\n    instruction: Do it.\n`;
    const edited = applyEdit(noDesc, { op: "setWorkflowField", key: "description", value: "a new one" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.description).toBe("a new one");
  });

  test("clears description (removes the key)", () => {
    const edited = applyEdit(text, { op: "setWorkflowField", key: "description", value: null });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.description).toBeUndefined();
    expect(edited).not.toContain("description:");
  });

  test("no-op returns identical string", () => {
    const edited = applyEdit(text, { op: "setWorkflowField", key: "description", value: "old description" });
    expect(edited).toBe(text);
  });
});

describe("setStepField", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    title: One
    instruction: Do it.
  - id: two
    instruction: Do it too.
    gates:
      - owner-action: approve
        route_back_to: one
`;

  test("sets title", () => {
    const edited = applyEdit(text, { op: "setStepField", step: 0, key: "title", value: "New Title" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].title).toBe("New Title");
  });

  test("clears title", () => {
    const edited = applyEdit(text, { op: "setStepField", step: 0, key: "title", value: null });
    expect(edited).not.toContain("title:");
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].title).toBeUndefined();
  });

  test("sets phase when absent, inserted in key order", () => {
    const edited = applyEdit(text, { op: "setStepField", step: 0, key: "phase", value: "Build" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].phase).toBe("Build");
    // phase must land after title and before instruction
    const lines = edited.split("\n");
    const titleIdx = lines.findIndex((l) => l.includes("title: One"));
    const phaseIdx = lines.findIndex((l) => l.includes("phase: Build"));
    const instrIdx = lines.findIndex((l) => l.includes("instruction: Do it."));
    expect(titleIdx).toBeLessThan(phaseIdx);
    expect(phaseIdx).toBeLessThan(instrIdx);
  });

  test("renaming id rewrites route_back_to elsewhere (scalar form)", () => {
    const edited = applyEdit(text, { op: "setStepField", step: 0, key: "id", value: "first" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workflow.steps[0].id).toBe("first");
    expect(parsed.workflow.steps[1].gates[0].route_back_to).toEqual(["first"]);
  });

  test("renaming id rewrites route_back_to elsewhere (list form)", () => {
    const withList = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
  - id: two
    instruction: Do it too.
  - id: three
    instruction: Review.
    gates:
      - agent: review
        route_back_to: [one, two]
`;
    const edited = applyEdit(withList, { op: "setStepField", step: 0, key: "id", value: "first" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workflow.steps[2].gates[0].route_back_to).toEqual(["first", "two"]);
  });

  test("no-op on id returns identical string", () => {
    const edited = applyEdit(text, { op: "setStepField", step: 0, key: "id", value: "one" });
    expect(edited).toBe(text);
  });
});

describe("setInstruction", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: >
      Old folded text here.
`;

  test("rewrites a folded instruction, wrapped at ~100 columns", () => {
    const long = "word ".repeat(40).trim();
    const edited = applyEdit(text, { op: "setInstruction", step: 0, text: long, style: ">" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].instruction.trim()).toBe(long);
    const lines = edited.split("\n");
    const bodyLines = lines.filter((l) => l.startsWith("      ") && l.trim().length > 0);
    for (const l of bodyLines) expect(l.length).toBeLessThanOrEqual(110);
  });

  test("switches to literal style", () => {
    const edited = applyEdit(text, { op: "setInstruction", step: 0, text: "Line one.\nLine two.", style: "|" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].instruction).toBe("Line one.\nLine two.");
    expect(edited).toContain("instruction: |\n");
  });

  test("honors folded style for a short instruction", () => {
    const edited = applyEdit(text, { op: "setInstruction", step: 0, text: "Do the thing.", style: ">" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].instruction).toBe("Do the thing.");
    expect(edited).toContain("instruction: >\n");
  });

  // A comment on the instruction's line stays a comment, on the new block's header.
  for (const [label, line] of [
    ["a plain", "instruction: Old text. # keep this comment"],
    ["a quoted", 'instruction: "" # keep this comment'],
    ["a folded block's header", "instruction: > # keep this comment\n      Old text."],
    ["a literal block's header", "instruction: |-  # keep this comment\n      Old text."],
    ["a commented, with replacement tokens,", "instruction: Old. # keep this comment, $' and $& and $1"],
    ["a multi-line plain", "instruction: # keep this comment\n      Old text\n      on two lines."],
    ["a multi-line quoted", 'instruction: "Old text\n      on two lines." # keep this comment'],
    ["a folded block, with the indicator on the next line,", "instruction:\n      > # keep this comment\n        Old text."],
    ["a literal block, with the indicator on the next line,", "instruction:\n      | # keep this comment\n        Old text."],
  ] as const) {
    test(`keeps the comment on ${label} instruction`, () => {
      const before = `version: 1\nname: demo\nsteps:\n  - id: one\n    ${line}\n`;
      for (const style of [">", "|"] as const) {
        const edited = applyEdit(before, { op: "setInstruction", step: 0, text: "Line one.\nLine two.", style });
        const parsed = parseWorkflowText(edited);
        expect(parsed.ok ? parsed.workflow.steps[0].instruction.trimEnd() : parsed.issues).toBe("Line one.\nLine two.");
        const comment = line.slice(line.indexOf("#")).split("\n")[0].trimEnd();
        expect(edited).toContain(`    instruction: ${style} ${comment}\n`);
      }
    });
  }

  test("keeps a comment after the key when the block indicator is on the next line", () => {
    const before = `version: 1\nname: demo\nsteps:\n  - id: one\n    instruction: # key comment\n      | # block comment\n        Old text.\n`;
    const edited = applyEdit(before, { op: "setInstruction", step: 0, text: "New text.", style: "|" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok ? parsed.workflow.steps[0].instruction.trim() : parsed.issues).toBe("New text.");
    expect(edited).toContain("    instruction: | # key comment # block comment\n      New text.\n");
  });

  test("keeps every comment between the key and a plain value on later lines", () => {
    const before = `version: 1\nname: demo\nsteps:\n  - id: one\n    instruction: # first comment\n      # second comment\n      Old text.\n`;
    const edited = applyEdit(before, { op: "setInstruction", step: 0, text: "New text.", style: ">" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok ? parsed.workflow.steps[0].instruction.trim() : parsed.issues).toBe("New text.");
    expect(edited).toContain("    # second comment\n    instruction: > # first comment\n      New text.\n");
  });
});

describe("setCondition", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Maybe do it.
  - id: two
    instruction: Do it too.
`;

  test("sets a check condition", () => {
    const edited = applyEdit(text, { op: "setCondition", step: 0, condition: { kind: "check", text: "default" } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].condition).toEqual({ kind: "check", text: "default" });
  });

  test("sets then changes an agent condition with description", () => {
    const withCond = applyEdit(text, {
      op: "setCondition",
      step: 0,
      condition: { kind: "agent", text: "only when risky", description: "judgment call" },
    });
    const parsed1 = parseWorkflowText(withCond);
    expect(parsed1.ok).toBe(true);
    if (parsed1.ok) expect(parsed1.workflow.steps[0].condition).toEqual({ kind: "agent", text: "only when risky", description: "judgment call" });
    expect(withCond).toContain("description: judgment call");

    const changed = applyEdit(withCond, { op: "setCondition", step: 0, condition: { kind: "script", text: "check.sh" } });
    const parsed2 = parseWorkflowText(changed);
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) expect(parsed2.workflow.steps[0].condition).toEqual({ kind: "script", text: "check.sh" });
  });

  test("clears a condition", () => {
    const withCond = applyEdit(text, { op: "setCondition", step: 0, condition: { kind: "check", text: "default" } });
    const cleared = applyEdit(withCond, { op: "setCondition", step: 0, condition: null });
    const parsed = parseWorkflowText(cleared);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].condition).toBeUndefined();
    expect(cleared).toBe(text);
  });
});

describe("setConsumes", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Produce.
    produces:
      - artifact: notes
        path: notes.md
  - id: two
    instruction: Consume.
`;

  test("adds a consumes list", () => {
    const edited = applyEdit(text, { op: "setConsumes", step: 1, ids: ["notes"] });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[1].consumes).toEqual(["notes"]);
    expect(edited).toContain("consumes: [notes]");
  });

  test("multiple ids as a flow list", () => {
    const withTwo = `version: 1
name: demo
steps:
  - id: one
    instruction: Produce.
    produces:
      - artifact: notes
        path: notes.md
      - artifact: plan
        path: plan.md
  - id: two
    instruction: Consume.
`;
    const edited = applyEdit(withTwo, { op: "setConsumes", step: 1, ids: ["notes", "plan"] });
    expect(edited).toContain("consumes: [notes, plan]");
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[1].consumes).toEqual(["notes", "plan"]);
  });

  test("empty list removes the key", () => {
    const withConsumes = applyEdit(text, { op: "setConsumes", step: 1, ids: ["notes"] });
    const removed = applyEdit(withConsumes, { op: "setConsumes", step: 1, ids: [] });
    expect(removed).toBe(text);
  });
});

describe("outputs: addOutput, removeOutput, setOutput, changeOutputMode", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    produces:
      - artifact: notes
        path: notes.md
        description: the notes
`;

  test("addOutput appends a new block-mapping entry", () => {
    const edited = applyEdit(text, { op: "addOutput", step: 0, mode: "produces", artifact: "plan", path: "plan.md" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].produces).toEqual([
      { artifact: "notes", path: "notes.md", description: "the notes" },
      { artifact: "plan", path: "plan.md" },
    ]);
  });

  test("addOutput to a single (non-list) existing artifact converts it to a list", () => {
    const single = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    produces:
      artifact: notes
      path: notes.md
`;
    const edited = applyEdit(single, { op: "addOutput", step: 0, mode: "produces", artifact: "plan", path: "plan.md" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.workflow.steps[0].produces).toEqual([
        { artifact: "notes", path: "notes.md" },
        { artifact: "plan", path: "plan.md" },
      ]);
  });

  test("addOutput creates the key when the mode is absent", () => {
    const edited = applyEdit(text, { op: "addOutput", step: 0, mode: "optional_produces", artifact: "extra", path: "extra.md" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].optional_produces).toEqual([{ artifact: "extra", path: "extra.md" }]);
  });

  test("removeOutput removes the one entry and the key", () => {
    const edited = applyEdit(text, { op: "removeOutput", step: 0, mode: "produces", index: 0 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].produces).toEqual([]);
    expect(edited).not.toContain("produces:");
  });

  test("removeOutput removes one of several entries, keeping the key", () => {
    const two = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    produces:
      - artifact: notes
        path: notes.md
      - artifact: plan
        path: plan.md
`;
    const edited = applyEdit(two, { op: "removeOutput", step: 0, mode: "produces", index: 0 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].produces).toEqual([{ artifact: "plan", path: "plan.md" }]);
  });

  test("setOutput changes fields in place", () => {
    const edited = applyEdit(text, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { path: "new-notes.md", description: null } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].produces).toEqual([{ artifact: "notes", path: "new-notes.md" }]);
  });

  test("changeOutputMode moves an entry from one mode list to another", () => {
    const edited = applyEdit(text, { op: "changeOutputMode", step: 0, mode: "produces", index: 0, to: "updates" });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.workflow.steps[0].produces).toEqual([]);
    expect(parsed.workflow.steps[0].updates).toEqual([{ artifact: "notes", path: "notes.md", description: "the notes" }]);
  });
});

describe("review findings: source kept and meaning kept", () => {
  test("a folded instruction keeps its paragraph breaks", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
`;
    for (const instruction of ["first paragraph\nsecond paragraph", "a\n\nb", "one\ntwo\n\n\nthree"]) {
      const out = applyEdit(t, { op: "setInstruction", step: 0, text: instruction, style: ">" });
      const parsed = parseWorkflowText(out);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
      expect(parsed.workflow.steps[0].instruction).toBe(instruction);
      expect(out).toContain("instruction: >");
    }
  });

  test("adding an output to a single artifact mapping keeps its comments and lines", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces:
      # keep this artifact note
      artifact: first # keep inline
      path: first.md # keep path note
`;
    const out = applyEdit(t, { op: "addOutput", step: 0, mode: "produces", artifact: "second", path: "second.md" });
    for (const kept of ["# keep this artifact note", "artifact: first # keep inline", "path: first.md # keep path note"]) {
      expect(out).toContain(kept);
    }
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.workflow.steps[0].produces.map((a) => [a.artifact, a.path])).toEqual([
      ["first", "first.md"],
      ["second", "second.md"],
    ]);
  });

  test("adding a gate to a single gate mapping with several fields keeps it as written", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    gates:
      agent: review   # why
      description: Independent.
      max_rounds: 2
      route_back_to: a
`;
    const out = applyEdit(t, { op: "addGate", step: 0, gate: { kind: "check", text: "default" } });
    expect(out).toContain("agent: review   # why");
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.workflow.steps[0].gates).toEqual([
      { kind: "agent", text: "review", description: "Independent.", max_rounds: 2, route_back_to: ["a"] },
      { kind: "check", text: "default", route_back_to: [] },
    ]);
  });

  test("a single flow-mapping output and a single string gate become one-item lists unchanged", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces: { artifact: first, path: first.md }
    gates: script("bun test")
`;
    const withOutput = applyEdit(t, { op: "addOutput", step: 0, mode: "produces", artifact: "second", path: "second.md" });
    expect(withOutput).toContain("- { artifact: first, path: first.md }");
    const withGate = applyEdit(t, { op: "addGate", step: 0, gate: { kind: "check", text: "default" } });
    expect(withGate).toContain(`- script("bun test")`);
    for (const out of [withOutput, withGate]) {
      const parsed = parseWorkflowText(out);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    }
  });
});

describe("review round 2: edits keep the lines they don't change", () => {
  test("changing an output's mode moves its lines and comments as written", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces:
      - artifact: first
        path: first.md
      # about the second
      - artifact: second # keep inline
        path: second.md # keep path note
    updates:
      - artifact: code
        path: .
`;
    const out = applyEdit(t, { op: "changeOutputMode", step: 0, mode: "produces", index: 1, to: "updates" });
    for (const kept of ["# about the second", "artifact: second # keep inline", "path: second.md # keep path note"]) {
      expect(out).toContain(kept);
    }
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.workflow.steps[0].produces.map((a) => a.artifact)).toEqual(["first"]);
    expect(parsed.workflow.steps[0].updates.map((a) => a.artifact)).toEqual(["code", "second"]);
  });

  test("changing the mode of the only output creates the other key with its lines", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces:
      - artifact: only # note
        path: only.md
`;
    const out = applyEdit(t, { op: "changeOutputMode", step: 0, mode: "produces", index: 0, to: "optional_produces" });
    expect(out).toContain("artifact: only # note");
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.workflow.steps[0].produces).toEqual([]);
    expect(parsed.workflow.steps[0].optional_produces.map((a) => a.artifact)).toEqual(["only"]);
  });

  test("toggling consumes on a block list keeps the other items and their comments", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces: [{ artifact: one, path: one.md }, { artifact: two, path: two.md }, { artifact: three, path: three.md }]
  - id: b
    instruction: y
    consumes:
      - one # the first input
      - two
`;
    const removed = applyEdit(t, { op: "setConsumes", step: 1, ids: ["one"] });
    expect(removed).toBe(t.replace("      - two\n", ""));
    const added = applyEdit(t, { op: "setConsumes", step: 1, ids: ["one", "two", "three"] });
    expect(added).toBe(t.replace("      - two\n", "      - two\n      - three\n"));
    for (const out of [removed, added]) {
      const parsed = parseWorkflowText(out);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    }
  });

  test("changing a condition's kind keeps its description and comments", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    condition:
      # why this step is optional
      agent: when needed # inline
      description: d # about d
`;
    const out = applyEdit(t, { op: "setCondition", step: 0, condition: { kind: "owner-action", text: "ask the owner", description: "d" } });
    expect(out).toBe(t.replace("agent: when needed", "owner-action: ask the owner"));
  });
});

describe("review round 3: flow lists and empty lists", () => {
  const ok = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(`${JSON.stringify(parsed.issues)}\n${out}`);
    return parsed.workflow;
  };

  test("changing the mode of one entry of a flow list moves that entry only", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces: [{ artifact: first, path: first.md }, { artifact: second, path: second.md }]
    updates: [{ artifact: code, path: . }]
`;
    const w = ok(applyEdit(t, { op: "changeOutputMode", step: 0, mode: "produces", index: 0, to: "updates" }));
    expect(w.steps[0].produces.map((a) => a.artifact)).toEqual(["second"]);
    expect(w.steps[0].updates.map((a) => a.artifact)).toEqual(["code", "first"]);
  });

  test("moving an output into an empty flow list fills it", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces:
      - artifact: first # note
        path: first.md
      - artifact: second
        path: second.md
    updates: []
`;
    const out = applyEdit(t, { op: "changeOutputMode", step: 0, mode: "produces", index: 0, to: "updates" });
    expect(out).toContain("artifact: first # note");
    const w = ok(out);
    expect(w.steps[0].updates.map((a) => a.artifact)).toEqual(["first"]);
  });

  test("adding and removing on flow lists, and adding to gates: []", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces: [{ artifact: first, path: first.md }, { artifact: second, path: second.md }]
    gates: []
`;
    expect(ok(applyEdit(t, { op: "addOutput", step: 0, mode: "produces", artifact: "third", path: "third.md" })).steps[0].produces.map((a) => a.artifact)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(ok(applyEdit(t, { op: "removeOutput", step: 0, mode: "produces", index: 0 })).steps[0].produces.map((a) => a.artifact)).toEqual(["second"]);
    expect(ok(applyEdit(t, { op: "addGate", step: 0, gate: { kind: "check", text: "default" } })).steps[0].gates).toEqual([
      { kind: "check", text: "default", route_back_to: [] },
    ]);
  });

  test("a field edit on a flow entry stays on its line", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces: [{ artifact: first, path: first.md }]
`;
    expect(applyEdit(t, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { path: "other.md" } })).toBe(
      t.replace("path: first.md", "path: other.md"),
    );
    const described = applyEdit(t, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { description: "the first" } });
    expect(ok(described).steps[0].produces[0].description).toBe("the first");
  });

  test("the first step of an empty workflow replaces steps: []", () => {
    const t = `version: 1
name: x
steps: []
`;
    const out = applyEdit(t, { op: "insertStep", at: 0, step: { id: "a", instruction: "Do it." } });
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(`${JSON.stringify(parsed.issues)}\n${out}`);
    expect(parsed.workflow.steps.map((st) => st.id)).toEqual(["a"]);
  });
});

describe("review round 4: flow steps, step comments, flow gates", () => {
  const ok = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(`${JSON.stringify(parsed.issues)}\n${out}`);
    return parsed.workflow;
  };
  const flowSteps = `version: 1
name: x
steps: [{ id: a, instruction: x }, { id: b, instruction: y }]
`;

  test("insert, delete and move work on steps written as a flow list", () => {
    expect(ok(applyEdit(flowSteps, { op: "insertStep", at: 1, step: { id: "n", instruction: "New." } })).steps.map((st) => st.id)).toEqual([
      "a",
      "n",
      "b",
    ]);
    expect(ok(applyEdit(flowSteps, { op: "deleteStep", index: 0 })).steps.map((st) => st.id)).toEqual(["b"]);
    expect(ok(applyEdit(flowSteps, { op: "moveStep", from: 1, to: 0 })).steps.map((st) => st.id)).toEqual(["b", "a"]);
    const one = `version: 1\nname: x\nsteps: [{ id: a, instruction: x }]\n`;
    expect(ok(applyEdit(one, { op: "insertStep", at: 0, step: { id: "n", instruction: "New." } })).steps.map((st) => st.id)).toEqual(["n", "a"]);
  });

  const commented = `version: 1
name: x
steps:
  # comment for a
  - id: a
    instruction: x
  # comment for b
  - id: b # inline b
    instruction: y
  # comment for c
  - id: c
    instruction: z
`;

  test("a moved step takes the comments directly above it", () => {
    const out = applyEdit(commented, { op: "moveStep", from: 1, to: 0 });
    expect(out).toBe(`version: 1
name: x
steps:
  # comment for b
  - id: b # inline b
    instruction: y
  # comment for a
  - id: a
    instruction: x
  # comment for c
  - id: c
    instruction: z
`);
    const last = applyEdit(commented, { op: "moveStep", from: 0, to: 2 });
    expect(ok(last).steps.map((st) => st.id)).toEqual(["b", "c", "a"]);
    expect(last.endsWith("  # comment for a\n  - id: a\n    instruction: x\n")).toBe(true);
  });

  test("a deleted step takes the comments directly above it", () => {
    expect(applyEdit(commented, { op: "deleteStep", index: 1 })).toBe(commented.replace("  # comment for b\n  - id: b # inline b\n    instruction: y\n", ""));
  });

  test("editing one gate of a flow list rewrites that gate only", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    gates: [{ agent: review, max_rounds: 2 }, { check: default }] # keep layout
`;
    expect(applyEdit(t, { op: "setGate", step: 0, index: 0, fields: { max_rounds: 3 } })).toBe(t.replace("max_rounds: 2", "max_rounds: 3"));
    const routed = applyEdit(t, { op: "setGate", step: 0, index: 1, fields: { route_back_to: ["a"] } });
    expect(routed).toBe(t.replace("{ check: default }", "{ check: default, route_back_to: a }"));
    expect(ok(routed).steps[0].gates[1].route_back_to).toEqual(["a"]);
  });
});

describe("review round 5: which comments belong to a list item", () => {
  const steps = `version: 1
name: x
steps:
  - id: a
    instruction: x
    # note about a
  # comment for b
  - id: b
    instruction: y
`;

  test("a comment indented as a field stays with the step above; one at the dash goes with the step below", () => {
    expect(applyEdit(steps, { op: "deleteStep", index: 1 })).toBe(`version: 1
name: x
steps:
  - id: a
    instruction: x
    # note about a
`);
    const inserted = applyEdit(steps, { op: "insertStep", at: 1, step: { id: "n", instruction: "New." } });
    expect(inserted.indexOf("# note about a")).toBeLessThan(inserted.indexOf("- id: n"));
    expect(inserted.indexOf("- id: n")).toBeLessThan(inserted.indexOf("# comment for b"));
    const moved = applyEdit(steps, { op: "moveStep", from: 1, to: 0 });
    expect(moved).toBe(`version: 1
name: x
steps:
  # comment for b
  - id: b
    instruction: y
  - id: a
    instruction: x
    # note about a
`);
  });

  test("removing a consumes id, an output or a gate removes the comment above it too", () => {
    const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    produces:
      - artifact: one
        path: one.md
      # about two
      - artifact: two
        path: two.md
  - id: b
    instruction: y
    consumes:
      - one
      # belongs to two
      - two
    gates:
      - check: default
      # about the owner
      - owner-action: approve
`;
    expect(applyEdit(t, { op: "setConsumes", step: 1, ids: ["one"] })).toBe(t.replace("      # belongs to two\n      - two\n", ""));
    expect(applyEdit(t, { op: "removeOutput", step: 0, mode: "produces", index: 1 })).toBe(
      t.replace("      # about two\n      - artifact: two\n        path: two.md\n", ""),
    );
    expect(applyEdit(t, { op: "removeGate", step: 1, index: 1 })).toBe(t.replace("      # about the owner\n      - owner-action: approve\n", ""));
  });
});

describe("condition mappings", () => {
  const t = `version: 1
name: x
steps:
  - id: a
    instruction: x
    condition:
      agent: when needed   # keep me
      description: d
`;
  test("a text or description change keeps the other lines and comments", () => {
    expect(applyEdit(t, { op: "setCondition", step: 0, condition: { kind: "agent", text: "when really needed", description: "d" } })).toBe(
      t.replace("agent: when needed", "agent: when really needed"),
    );
    expect(applyEdit(t, { op: "setCondition", step: 0, condition: { kind: "agent", text: "when needed" } })).toBe(
      t.replace("      description: d\n", ""),
    );
  });
});

describe("gates", () => {
  const commented = `version: 1
name: x
steps:
  - id: a
    instruction: x
    gates:
      - agent: review it   # why this review
        max_rounds: 2
        # the target
        route_back_to: a
`;

  test("setGate changes only the keys that changed, keeping order and comments", () => {
    expect(applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { text: "review again" } })).toBe(
      commented.replace("agent: review it", "agent: review again"),
    );
    expect(applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { max_rounds: 3 } })).toBe(
      commented.replace("max_rounds: 2", "max_rounds: 3"),
    );
    expect(applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { description: "Independent." } })).toBe(
      commented.replace("   # why this review\n", "   # why this review\n        description: Independent.\n"),
    );
    expect(applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { route_back_to: [] } })).toBe(
      commented.replace("        route_back_to: a\n", ""),
    );
  });

  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
  - id: two
    instruction: Review.
    gates:
      - check: default
`;

  test("addGate on a step with none creates the key", () => {
    const edited = applyEdit(text, { op: "addGate", step: 0, gate: { kind: "owner-action", text: "approve" } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].gates).toEqual([{ kind: "owner-action", text: "approve", route_back_to: [] }]);
  });

  test("addGate on a single gate converts it to a list", () => {
    const edited = applyEdit(text, { op: "addGate", step: 1, gate: { kind: "owner-action", text: "approve" } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok)
      expect(parsed.workflow.steps[1].gates).toEqual([
        { kind: "check", text: "default", route_back_to: [] },
        { kind: "owner-action", text: "approve", route_back_to: [] },
      ]);
  });

  test("removeGate removes the only gate and the key", () => {
    const edited = applyEdit(text, { op: "removeGate", step: 1, index: 0 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[1].gates).toEqual([]);
    expect(edited).not.toContain("gates:");
  });

  test("setGate changes kind away from agent, dropping max_rounds and guide", () => {
    const withAgent = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    gates:
      - agent: review it
        max_rounds: 3
        guide: review.md
`;
    const edited = applyEdit(withAgent, { op: "setGate", step: 0, index: 0, fields: { kind: "check", text: "default" } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].gates).toEqual([{ kind: "check", text: "default", route_back_to: [] }]);
    expect(edited).not.toContain("max_rounds");
    expect(edited).not.toContain("guide:");
  });

  test("setGate sets and clears max_rounds", () => {
    const withAgent = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    gates:
      - agent: review it
`;
    const withRounds = applyEdit(withAgent, { op: "setGate", step: 0, index: 0, fields: { max_rounds: 3 } });
    const parsed1 = parseWorkflowText(withRounds);
    expect(parsed1.ok).toBe(true);
    if (parsed1.ok) expect(parsed1.workflow.steps[0].gates[0].max_rounds).toBe(3);

    const cleared = applyEdit(withRounds, { op: "setGate", step: 0, index: 0, fields: { max_rounds: null } });
    const parsed2 = parseWorkflowText(cleared);
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) expect(parsed2.workflow.steps[0].gates[0].max_rounds).toBeUndefined();
  });

  test("route_back_to: one, many, none", () => {
    const withTwoSteps = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
  - id: two
    instruction: Also.
  - id: three
    instruction: Review.
    gates:
      - agent: review
`;
    const oneTarget = applyEdit(withTwoSteps, { op: "setGate", step: 2, index: 0, fields: { route_back_to: ["one"] } });
    const parsed1 = parseWorkflowText(oneTarget);
    expect(parsed1.ok).toBe(true);
    if (parsed1.ok) expect(parsed1.workflow.steps[2].gates[0].route_back_to).toEqual(["one"]);
    expect(oneTarget).toContain("route_back_to: one\n");

    const twoTargets = applyEdit(withTwoSteps, { op: "setGate", step: 2, index: 0, fields: { route_back_to: ["one", "two"] } });
    const parsed2 = parseWorkflowText(twoTargets);
    expect(parsed2.ok).toBe(true);
    if (parsed2.ok) expect(parsed2.workflow.steps[2].gates[0].route_back_to).toEqual(["one", "two"]);
    expect(twoTargets).toContain("route_back_to: [one, two]");

    const removed = applyEdit(oneTarget, { op: "setGate", step: 2, index: 0, fields: { route_back_to: [] } });
    const parsed3 = parseWorkflowText(removed);
    expect(parsed3.ok).toBe(true);
    if (parsed3.ok) expect(parsed3.workflow.steps[2].gates[0].route_back_to).toEqual([]);
    expect(removed).not.toContain("route_back_to");
  });

  test("a string-form gate stays untouched until it is edited, then becomes a mapping", () => {
    const stringGate = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
    gates:
      - 'script("bun run check")'
      - check: default
`;
    const editOther = applyEdit(stringGate, { op: "setGate", step: 0, index: 1, fields: { text: "lint" } });
    expect(editOther).toContain('script("bun run check")');
    const parsedOther = parseWorkflowText(editOther);
    expect(parsedOther.ok).toBe(true);
    if (parsedOther.ok) {
      expect(parsedOther.workflow.steps[0].gates[0]).toEqual({ kind: "script", text: "bun run check", route_back_to: [] });
      expect(parsedOther.workflow.steps[0].gates[1]).toEqual({ kind: "check", text: "lint", route_back_to: [] });
    }

    const editItself = applyEdit(stringGate, { op: "setGate", step: 0, index: 0, fields: { text: "bun run check2" } });
    expect(editItself).not.toContain('script("bun run check")');
    expect(editItself).toContain("script: bun run check2");
    const parsedSelf = parseWorkflowText(editItself);
    expect(parsedSelf.ok).toBe(true);
    if (parsedSelf.ok) expect(parsedSelf.workflow.steps[0].gates[0]).toEqual({ kind: "script", text: "bun run check2", route_back_to: [] });
  });
});

describe("insertStep, deleteStep, moveStep", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: First.
  - id: two
    # a comment on two
    instruction: Second.
  - id: three
    instruction: Third.
`;

  test("insertStep at the start", () => {
    const edited = applyEdit(text, { op: "insertStep", at: 0, step: { id: "zero", instruction: "Zeroth." } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["zero", "one", "two", "three"]);
      expect(parsed.workflow.steps[0].instruction).toBe("Zeroth.");
    }
  });

  test("insertStep in the middle", () => {
    const edited = applyEdit(text, { op: "insertStep", at: 1, step: { id: "onepointfive", instruction: "In between." } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["one", "onepointfive", "two", "three"]);
  });

  test("insertStep at the end", () => {
    const edited = applyEdit(text, { op: "insertStep", at: 3, step: { id: "four", instruction: "Fourth." } });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["one", "two", "three", "four"]);
  });

  test("deleteStep removes a step and its comments", () => {
    const edited = applyEdit(text, { op: "deleteStep", index: 1 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["one", "three"]);
    expect(edited).not.toContain("a comment on two");
  });

  test("moveStep carries its own comments and lines with it", () => {
    const edited = applyEdit(text, { op: "moveStep", from: 1, to: 0 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["two", "one", "three"]);
    expect(edited).toContain("# a comment on two");
  });

  test("moveStep to a later position", () => {
    const edited = applyEdit(text, { op: "moveStep", from: 0, to: 2 });
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps.map((s) => s.id)).toEqual(["two", "three", "one"]);
  });

  test("moveStep to the same position is a no-op", () => {
    const edited = applyEdit(text, { op: "moveStep", from: 1, to: 1 });
    expect(edited).toBe(text);
  });
});

describe("errors", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Do it.
`;

  test("throws a clear error for an out-of-range step", () => {
    expect(() => applyEdit(text, { op: "setStepField", step: 5, key: "title", value: "x" })).toThrow(/step/i);
  });

  test("throws a clear error for a duplicate id on rename", () => {
    const two = `version: 1
name: demo
steps:
  - id: one
    instruction: First.
  - id: two
    instruction: Second.
`;
    expect(() => applyEdit(two, { op: "setStepField", step: 0, key: "id", value: "two" })).toThrow();
  });
});

// Satisfy the type checker that Edit is exported and usable by callers.
const _typeCheck: Edit = { op: "setWorkflowField", key: "name", value: "x" };
void _typeCheck;

describe("semantic no-ops", () => {
  const text = `version: 1
name: demo
steps:
  - id: one
    instruction: Produce.
    produces:
      - artifact: notes
        path: notes.md
  - id: two
    instruction: >
      Review.
    condition:
      agent: only when needed
      description: judgment call
    consumes: [notes]
    produces:
      - artifact: report
        path: report.md
    gates:
      - agent: review
        max_rounds: 2
        route_back_to: one
`;

  test("return the identical source across editable structured fields", () => {
    const edits: Edit[] = [
      { op: "setInstruction", step: 1, text: "Review.", style: ">" },
      { op: "setCondition", step: 1, condition: { kind: "agent", text: "only when needed", description: "judgment call" } },
      { op: "setConsumes", step: 1, ids: ["notes"] },
      { op: "setOutput", step: 1, mode: "produces", index: 0, fields: { path: "report.md" } },
      { op: "changeOutputMode", step: 1, mode: "produces", index: 0, to: "produces" },
      { op: "setGate", step: 1, index: 0, fields: { text: "review", max_rounds: 2, route_back_to: ["one"] } },
    ];
    for (const edit of edits) expect(applyEdit(text, edit)).toBe(text);
  });
});

describe("a workflow with inputs, hand-offs and a workflow gate", () => {
  const text = `version: 1
name: parent
inputs:
  - artifact: brief
    required: true
hands_off_to:
  - workflow: next
    when: once the parent is done
steps:
  - id: intake
    instruction: Write the diff.
    consumes: [brief]
    produces: { artifact: diff, path: "diffs/{slug}.diff" }
  - id: adversarial
    instruction: Merge the new findings.
    gates:
      - owner-action: approve the findings
      # the child does the review
      - workflow: child
        slug: "{slug}-adv"
        inputs:
          given-diff: diff
        returns: [report]
        route_back_to: intake
  - id: summary
    instruction: Summarize.
    consumes: [report]
`;
  const workflowGateLines = ['      - workflow: child', '        slug: "{slug}-adv"', "        inputs:", "          given-diff: diff", "        returns: [report]"];
  const gateOf = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    const step = parsed.workflow.steps.find((s) => s.gates.some((g) => g.kind === "workflow"))!;
    return { step, gate: step.gates.find((g) => g.kind === "workflow")!, workflow: parsed.workflow };
  };
  // The workflow gate, inputs and hand-offs as plain YAML, so an edit that
  // makes the file invalid (moving a step) can still be compared.
  const rawOf = (out: string) => {
    const doc = YAML.parse(out);
    const gate = doc.steps.flatMap((s: { gates?: Record<string, unknown>[] }) => s.gates ?? []).find((g: Record<string, unknown>) => "workflow" in g);
    return { gate, inputs: doc.inputs, hands_off_to: doc.hands_off_to };
  };

  test("an unrelated edit leaves the workflow gate, the inputs and the hand-offs as written", () => {
    const before = rawOf(text);
    expect(before.gate).toEqual({ workflow: "child", slug: "{slug}-adv", inputs: { "given-diff": "diff" }, returns: ["report"], route_back_to: "intake" });
    const edits: Edit[] = [
      { op: "setStepField", step: 1, key: "title", value: "Adversarial review" },
      { op: "setStepField", step: 0, key: "description", value: "The diff." },
      { op: "setInstruction", step: 1, text: "Merge every new finding.", style: ">" },
      { op: "setConsumes", step: 2, ids: ["report", "diff"] },
      { op: "setGate", step: 1, index: 0, fields: { text: "approve the merged findings" } },
      { op: "addGate", step: 1, gate: { kind: "check", text: "default" } },
      { op: "removeGate", step: 1, index: 0 },
      { op: "insertStep", at: 0, step: { id: "first", instruction: "Begin." } },
      { op: "moveStep", from: 2, to: 1 },
      { op: "moveStep", from: 1, to: 2 },
      { op: "deleteStep", index: 2 },
      { op: "setWorkflowField", key: "description", value: "Reviews a diff." },
      { op: "addOutput", step: 0, mode: "produces", artifact: "plan", path: "plan.md" },
      { op: "setCondition", step: 2, condition: { kind: "agent", text: "when there are findings" } },
    ];
    for (const edit of edits) {
      const out = applyEdit(text, edit);
      expect({ edit, ...rawOf(out) }).toEqual({ edit, ...before });
      for (const line of workflowGateLines) expect(out).toContain(line);
      expect(out).toContain("      # the child does the review\n");
    }
  });

  test("editing the workflow gate's own text, description or route back changes only that line", () => {
    const renamed = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { text: "deep-review" } });
    expect(changedLines(text, renamed).size).toBe(1);
    expect(gateOf(renamed).gate).toMatchObject({ text: "deep-review", slug: "{slug}-adv", inputs: { "given-diff": "diff" }, returns: { report: "report" } });

    const described = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { description: "an independent review" } });
    expect(described).toContain('        returns: [report]\n        description: an independent review\n        route_back_to: intake\n');
    expect(gateOf(described).gate).toMatchObject({ description: "an independent review", slug: "{slug}-adv", returns: { report: "report" } });

    const routed = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { route_back_to: [] } });
    expect(routed).not.toContain("route_back_to");
    expect(gateOf(routed).gate).toMatchObject({ slug: "{slug}-adv", inputs: { "given-diff": "diff" }, returns: { report: "report" } });

    // Renaming the step a workflow gate routes back to rewrites the route, not the gate's own fields.
    const renamedStep = applyEdit(text, { op: "setStepField", step: 0, key: "id", value: "start" });
    expect(gateOf(renamedStep).gate).toMatchObject({ route_back_to: ["start"], slug: "{slug}-adv", returns: { report: "report" } });
  });

  test("making the workflow gate another kind removes its slug, inputs and returns, which only it may carry", () => {
    const out = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { kind: "agent", text: "review the diff" } });
    expect(out).toContain("      - agent: review the diff\n        route_back_to: intake\n");
    for (const key of ["slug:", "        inputs:", "given-diff", "returns:"]) expect(out).not.toContain(key);
    // The comment above the gate stays.
    expect(out).toContain("      # the child does the review\n");
    // The step after it consumed what the child returned; the engine now says so.
    const parsed = parseWorkflowText(out);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.path.join("."))).toEqual(["steps.2.consumes.0"]);
  });

  test("a workflow gate in a flow list keeps its fields when it is edited", () => {
    const flow = text.replace(
      /    gates:\n[\s\S]*?route_back_to: intake\n/,
      '    gates: [{ owner-action: approve }, { workflow: child, slug: "{slug}-x", inputs: { given-diff: diff }, returns: [report] }]\n',
    );
    expect(gateOf(flow).gate).toMatchObject({ slug: "{slug}-x" });
    const out = applyEdit(flow, { op: "setGate", step: 1, index: 1, fields: { description: "independent" } });
    expect(out).toContain('{ workflow: child, slug: "{slug}-x", inputs: { given-diff: diff }, returns: [report], description: independent }');
    expect(gateOf(out).gate).toMatchObject({ slug: "{slug}-x", inputs: { "given-diff": "diff" }, returns: { report: "report" }, description: "independent" });
    const other = applyEdit(flow, { op: "setGate", step: 1, index: 0, fields: { text: "approve it" } });
    expect(other).toContain('{ workflow: child, slug: "{slug}-x", inputs: { given-diff: diff }, returns: [report] }');
  });

  test("the child's slug and the returned ids of a workflow gate are set in place, and removed when empty", () => {
    const slugged = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { slug: "{slug}-deep" } });
    expect(changedLines(text, slugged).size).toBe(1);
    expect(slugged).toContain("        slug: '{slug}-deep'\n        inputs:\n");
    expect(gateOf(slugged).gate).toMatchObject({ slug: "{slug}-deep", inputs: { "given-diff": "diff" }, returns: { report: "report" } });

    const returned = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { returns: ["report", "notes"] } });
    expect(changedLines(text, returned).size).toBe(1);
    expect(returned).toContain("        returns: [report, notes]\n        route_back_to: intake\n");

    const cleared = applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { slug: null, returns: [] } });
    expect(cleared).not.toContain("slug:");
    expect(cleared).not.toContain("returns:");
    expect(cleared).toContain("        inputs:\n          given-diff: diff\n        route_back_to: intake\n");

    // A gate without these keys gets them in the engine's key order.
    const bare = text.replace('        slug: "{slug}-adv"\n', "").replace("        returns: [report]\n", "");
    const both = applyEdit(bare, { op: "setGate", step: 1, index: 1, fields: { slug: "{slug}-x", returns: ["report"] } });
    expect(both).toContain("      - workflow: child\n        slug: '{slug}-x'\n        inputs:\n          given-diff: diff\n        returns: [report]\n");
    expect(gateOf(both).gate).toMatchObject({ slug: "{slug}-x", returns: { report: "report" } });

    // Returns written as a mapping are replaced whole by the list.
    const mapped = text.replace("        returns: [report]\n", "        returns:\n          report: review\n");
    const listed = applyEdit(mapped, { op: "setGate", step: 1, index: 1, fields: { returns: ["report"] } });
    expect(listed).toContain("        returns: [report]\n        route_back_to: intake\n");
    expect(listed).not.toContain("report: review");

    expect(applyEdit(text, { op: "setGate", step: 1, index: 1, fields: { slug: "{slug}-adv", returns: ["report"] } })).toBe(text);
  });

  test("returns written as a block list followed by another gate key stay a block list, and the next key keeps its line", () => {
    const block = text.replace("        returns: [report]\n", "        returns:\n          - report\n");
    expect(rawOf(block).gate.returns).toEqual(["report"]);
    const out = applyEdit(block, { op: "setGate", step: 1, index: 1, fields: { returns: ["report", "notes"] } });
    expect(out).toContain("          given-diff: diff\n        returns:\n          - report\n          - notes\n        route_back_to: intake\n  - id: summary\n");
    expect(rawOf(out).gate).toEqual({ workflow: "child", slug: "{slug}-adv", inputs: { "given-diff": "diff" }, returns: ["report", "notes"], route_back_to: "intake" });
    expect(gateOf(out).gate).toMatchObject({ returns: { report: "report", notes: "notes" }, route_back_to: ["intake"] });
  });

  test("returns written as a block list at the end of a step stay a block list, and the next step keeps its line", () => {
    const block = text.replace("        returns: [report]\n        route_back_to: intake\n", "        returns:\n          - report\n");
    expect(rawOf(block).gate.returns).toEqual(["report"]);
    const out = applyEdit(block, { op: "setGate", step: 1, index: 1, fields: { returns: ["report", "notes"] } });
    expect(out).toContain("        returns:\n          - report\n          - notes\n  - id: summary\n    instruction: Summarize.\n");
    const doc = YAML.parse(out);
    expect(doc.steps.map((s: { id: string }) => s.id)).toEqual(["intake", "adversarial", "summary"]);
    expect(rawOf(out).gate).toEqual({ workflow: "child", slug: "{slug}-adv", inputs: { "given-diff": "diff" }, returns: ["report", "notes"] });
  });

  test("a workflow gate can be added, and a workflow written as a condition can be replaced", () => {
    const added = applyEdit(text, { op: "addGate", step: 0, gate: { kind: "workflow", text: "child" } });
    expect(added).toContain('    produces: { artifact: diff, path: "diffs/{slug}.diff" }\n    gates:\n      - workflow: child\n');
    // A workflow is not a condition; the engine says so, and the editor can still replace it.
    const wrong = text.replace("    instruction: Summarize.\n", "    instruction: Summarize.\n    condition: { workflow: child }\n");
    expect(parseWorkflowText(wrong).ok).toBe(false);
    const fixed = applyEdit(wrong, { op: "setCondition", step: 2, condition: { kind: "script", text: "test -f report.md" } });
    expect(parseWorkflowText(fixed).ok).toBe(true);
  });

  test("a new workflow description goes before the inputs, in the file's key order", () => {
    const out = applyEdit(text, { op: "setWorkflowField", key: "description", value: "Reviews a diff." });
    expect(out.startsWith("version: 1\nname: parent\ndescription: Reviews a diff.\ninputs:\n")).toBe(true);
  });
});

describe("replacing a block value keeps the line after it", () => {
  // Block scalars and block lists end with their own newline; each edit that
  // replaces one must leave the following key on its own line.
  const text = `version: 1
name: blocks
description: >
  A long
  description.
steps:
  - id: a
    description: >
      folded
    instruction: Do.
    produces:
      - artifact: x
        path: >
          x.md
    condition:
      agent: >
        when needed
    gates:
      - agent: >
          review it
        route_back_to:
          - a
        max_rounds: 2
  - id: b
    instruction: Next.
`;
  const parse = (out: string) => YAML.parse(out) as { description: string; steps: Record<string, unknown>[] };

  test("a folded workflow or step description replaced by a plain one", () => {
    const workflow = applyEdit(text, { op: "setWorkflowField", key: "description", value: "short" });
    expect(workflow).toContain("description: short\nsteps:\n");
    expect(parse(workflow).description).toBe("short");
    const step = applyEdit(text, { op: "setStepField", step: 0, key: "description", value: "short" });
    expect(step).toContain("    description: short\n    instruction: Do.\n");
    expect(parse(step).steps[0]).toMatchObject({ description: "short", instruction: "Do." });
  });

  test("a folded output path replaced by a plain one", () => {
    const out = applyEdit(text, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { path: "y.md" } });
    expect(out).toContain("        path: y.md\n    condition:\n");
    expect(parse(out).steps[0].produces).toEqual([{ artifact: "x", path: "y.md" }]);
  });

  test("a folded condition or gate text replaced by a plain one", () => {
    const condition = applyEdit(text, { op: "setCondition", step: 0, condition: { kind: "agent", text: "other" } });
    expect(condition).toContain("      agent: other\n    gates:\n");
    expect(parse(condition).steps[0].condition).toEqual({ agent: "other" });
    const gate = applyEdit(text, { op: "setGate", step: 0, index: 0, fields: { text: "other" } });
    expect(gate).toContain("      - agent: other\n        route_back_to:\n");
    expect(parse(gate).steps[0].gates).toEqual([{ agent: "other", route_back_to: ["a"], max_rounds: 2 }]);
  });

  test("a block route_back_to list that gets a second target stays a block list", () => {
    const out = applyEdit(text, { op: "setGate", step: 0, index: 0, fields: { route_back_to: ["a", "b"] } });
    expect(out).toContain("        route_back_to:\n          - a\n          - b\n        max_rounds: 2\n  - id: b\n");
    expect(parse(out).steps[0].gates).toEqual([{ agent: "review it\n", route_back_to: ["a", "b"], max_rounds: 2 }]);
  });
});

describe("review round 6: a flow mapping inside a block list is edited inside its braces", () => {
  const ok = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(`${JSON.stringify(parsed.issues)}\n${out}`);
    return parsed.workflow;
  };
  const text = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    produces:
      - { artifact: report, path: report.md }
    gates:
      - { workflow: child, returns: [report] }
      - check: default
`;

  test("clearing the returns of a flow workflow gate keeps the gate", () => {
    const out = applyEdit(text, { op: "setGate", step: 0, index: 0, fields: { returns: null } });
    expect(out).toBe(text.replace("{ workflow: child, returns: [report] }", "{ workflow: child }"));
    expect(YAML.parse(out).steps[0].gates).toEqual([{ workflow: "child" }, { check: "default" }]);
  });

  test("adding a slug to a flow workflow gate writes it inside the braces, quoted for a flow mapping", () => {
    const out = applyEdit(text, { op: "setGate", step: 0, index: 0, fields: { slug: "x-{slug}" } });
    expect(out).toBe(text.replace("{ workflow: child, returns: [report] }", "{ workflow: child, slug: 'x-{slug}', returns: [report] }"));
    expect(YAML.parse(out).steps[0].gates[0]).toEqual({ workflow: "child", slug: "x-{slug}", returns: ["report"] });
  });

  test("a flow gate written as the step's only gate is edited in place", () => {
    const single = text.replace("    gates:\n      - { workflow: child, returns: [report] }\n      - check: default\n", "    gates: { agent: review }\n");
    const out = applyEdit(single, { op: "setGate", step: 0, index: 0, fields: { description: "d" } });
    expect(out).toBe(single.replace("{ agent: review }", "{ agent: review, description: d }"));
    expect(ok(out).steps[0].gates).toEqual([{ kind: "agent", text: "review", description: "d", route_back_to: [] }]);
  });

  test("a flow gate's text with a comma is quoted", () => {
    const out = applyEdit(text, { op: "setGate", step: 0, index: 1, fields: { text: "a, b" } });
    expect(YAML.parse(out).steps[0].gates[1]).toEqual({ check: "a, b" });
    const flowList = text.replace("      - { workflow: child, returns: [report] }\n      - check: default\n", "").replace("    gates:\n", "    gates: [{ agent: review }]\n");
    expect(YAML.parse(applyEdit(flowList, { op: "setGate", step: 0, index: 0, fields: { text: "a, b" } })).steps[0].gates).toEqual([{ agent: "a, b" }]);
  });

  test("a flow condition's description is added and removed inside its braces", () => {
    const withCondition = text.replace("    produces:\n", "    condition: { agent: when needed, description: d }\n    produces:\n");
    const removed = applyEdit(withCondition, { op: "setCondition", step: 0, condition: { kind: "agent", text: "when needed" } });
    expect(removed).toBe(withCondition.replace("{ agent: when needed, description: d }", "{ agent: when needed }"));
    const added = applyEdit(removed, { op: "setCondition", step: 0, condition: { kind: "agent", text: "when needed", description: "e" } });
    expect(added).toBe(withCondition.replace("description: d", "description: e"));
    const comma = applyEdit(removed, { op: "setCondition", step: 0, condition: { kind: "agent", text: "when, needed" } });
    expect(YAML.parse(comma).steps[0].condition).toEqual({ agent: "when, needed" });
  });

  test("a flow output entry's value with a comma is quoted", () => {
    const out = applyEdit(text, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { path: "a, b.md" } });
    expect(YAML.parse(out).steps[0].produces).toEqual([{ artifact: "report", path: "a, b.md" }]);
  });

  const flowStep = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
  - { id: b, title: T, instruction: y }
`;

  test("a step field of a flow step is removed, added and set inside its braces", () => {
    const removed = applyEdit(flowStep, { op: "setStepField", step: 1, key: "title", value: null });
    expect(removed).toBe(flowStep.replace("{ id: b, title: T, instruction: y }", "{ id: b, instruction: y }"));
    const added = applyEdit(flowStep, { op: "setStepField", step: 1, key: "phase", value: "p" });
    expect(added).toBe(flowStep.replace("title: T,", "title: T, phase: p,"));
    const comma = applyEdit(flowStep, { op: "setStepField", step: 1, key: "title", value: "a, b" });
    expect(ok(comma).steps[1]).toMatchObject({ id: "b", title: "a, b", instruction: "y" });
    const consumes = applyEdit(flowStep, { op: "setConsumes", step: 1, ids: ["x"] });
    expect(consumes).toBe(flowStep.replace("instruction: y }", "instruction: y, consumes: [x] }"));
  });

  test("an instruction inside a flow step is written inside its braces, as a flow scalar", () => {
    const out = applyEdit(flowStep, { op: "setInstruction", step: 1, text: "new", style: ">" });
    expect(out).toBe(flowStep.replace("instruction: y }", "instruction: new }"));
  });

  test("a condition, an output or a gate is added inside a flow step's braces", () => {
    const keep = "  - id: a\n    instruction: do it\n";
    const cases: [Edit, string][] = [
      [{ op: "setCondition", step: 1, condition: { kind: "agent", text: "x" } }, "  - { id: b, title: T, instruction: y, condition: { agent: x } }\n"],
      [{ op: "addOutput", step: 1, mode: "produces", artifact: "q", path: "q.md" }, "  - { id: b, title: T, instruction: y, produces: [{ artifact: q, path: q.md }] }\n"],
      [{ op: "addGate", step: 1, gate: { kind: "check", text: "default" } }, "  - { id: b, title: T, instruction: y, gates: [{ check: default }] }\n"],
    ];
    for (const [edit, line] of cases) {
      const out = applyEdit(flowStep, edit);
      expect(out).toBe(`version: 1\nname: demo\nsteps:\n${keep}${line}`);
      ok(out);
    }
    const flowGates = flowStep.replace("instruction: y }", "instruction: y, gates: [{ check: default }, { agent: review }], produces: [] }");
    expect(applyEdit(flowGates, { op: "removeGate", step: 1, index: 0 })).toBe(flowGates.replace("[{ check: default }, { agent: review }]", "[{ agent: review }]"));
    expect(applyEdit(flowGates, { op: "addOutput", step: 1, mode: "produces", artifact: "q", path: "q.md" })).toBe(
      flowGates.replace("produces: []", "produces: [{ artifact: q, path: q.md }]"),
    );
  });
});

describe("review round 7: the first key of a list item's mapping shares the line with its dash", () => {
  const ok = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(`${JSON.stringify(parsed.issues)}\n${out}`);
    return parsed.workflow;
  };
  const gates = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    gates:
      - returns: [report]
        workflow: child
      - check: default
`;

  test("removing a gate's first key moves the next key onto the dash line", () => {
    const out = applyEdit(gates, { op: "setGate", step: 0, index: 0, fields: { returns: null } });
    expect(out).toBe(gates.replace("      - returns: [report]\n        workflow: child\n", "      - workflow: child\n"));
    expect(YAML.parse(out).steps[0].gates).toEqual([{ workflow: "child" }, { check: "default" }]);
  });

  test("adding a key before a gate's first key writes it after the dash and moves the old first key to its own line", () => {
    const out = applyEdit(gates, { op: "setGate", step: 0, index: 0, fields: { slug: "x" } });
    expect(out).toBe(gates.replace("      - returns: [report]\n", "      - slug: x\n        returns: [report]\n"));
    expect(YAML.parse(out).steps[0].gates).toEqual([{ slug: "x", returns: ["report"], workflow: "child" }, { check: "default" }]);
  });

  test("a comment on the first key's line stays with that key when a key is added before it", () => {
    const commented = gates.replace("- returns: [report]", "- returns: [report] # what comes back");
    const out = applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { slug: "x" } });
    expect(out).toBe(commented.replace("      - returns:", "      - slug: x\n        returns:"));
    expect(YAML.parse(out).steps[0].gates[0]).toEqual({ slug: "x", returns: ["report"], workflow: "child" });
  });

  test("removing the first key keeps the comment lines above the next key, after the dash", () => {
    const commented = gates.replace("        workflow: child\n", "        # the child to run\n        workflow: child\n");
    const out = applyEdit(commented, { op: "setGate", step: 0, index: 0, fields: { returns: null } });
    expect(out).toBe(commented.replace("      - returns: [report]\n        # the child to run\n", "      - # the child to run\n"));
    expect(YAML.parse(out).steps[0].gates).toEqual([{ workflow: "child" }, { check: "default" }]);
  });

  const steps = `version: 1
name: demo
inputs:
  - artifact: x
steps:
  - title: T
    id: a
    instruction: do it
  - phase: p
    id: b
    instruction: again
  - consumes: [x]
    id: c
    instruction: more
`;

  test("a step's first field is removed and a field is added before a step's first field", () => {
    const removed = applyEdit(steps, { op: "setStepField", step: 0, key: "title", value: null });
    expect(removed).toBe(steps.replace("  - title: T\n    id: a\n", "  - id: a\n"));
    expect(ok(removed).steps[0]).toMatchObject({ id: "a", instruction: "do it" });
    const added = applyEdit(steps, { op: "setStepField", step: 1, key: "title", value: "U" });
    expect(added).toBe(steps.replace("  - phase: p\n", "  - title: U\n    phase: p\n"));
    expect(ok(added).steps[1]).toMatchObject({ id: "b", title: "U", phase: "p" });
  });

  test("a condition of several lines is added before, and removed as, a step's first field", () => {
    const added = applyEdit(steps, { op: "setCondition", step: 2, condition: { kind: "agent", text: "when needed" } });
    expect(added).toBe(steps.replace("  - consumes: [x]\n", "  - condition:\n      agent: when needed\n    consumes: [x]\n"));
    expect(YAML.parse(added).steps[2]).toEqual({ condition: { agent: "when needed" }, consumes: ["x"], id: "c", instruction: "more" });
    const removed = applyEdit(added, { op: "setCondition", step: 2, condition: null });
    expect(removed).toBe(steps);
  });

  test("an output entry's description written first is removed", () => {
    const t = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    produces:
      - description: the report
        artifact: report
        path: report.md
`;
    const out = applyEdit(t, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { description: null } });
    expect(out).toBe(t.replace("      - description: the report\n        artifact: report\n", "      - artifact: report\n"));
    expect(ok(out).steps[0].produces).toEqual([{ artifact: "report", path: "report.md" }]);
  });

  test("removing the only key of a list item's mapping throws instead of leaving a bare dash", () => {
    const t = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    produces:
      - description: d
`;
    expect(() => applyEdit(t, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { description: null } })).toThrow(/only key/);
  });
});

describe("review round 7 findings: steps and gates written in braces", () => {
  test("F1: clearing a field of a step in braces keeps the alias of the field before it", () => {
    const t = `version: 1
name: demo
steps:
  - id: a
    instruction: &do Do it.
  - { id: b, instruction: *do, title: T }
`;
    const out = applyEdit(t, { op: "setStepField", step: 1, key: "title", value: null });
    expect(out).toBe(t.replace(", title: T", ""));
    expect(YAML.parse(out).steps[1]).toEqual({ id: "b", instruction: "Do it." });
  });

  test("F2: editing one field of a gate in braces keeps the anchor another step uses", () => {
    const t = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    gates:
      - { agent: &review review the change, max_rounds: 2 }
  - id: b
    instruction: again
    gates:
      - agent: *review
`;
    const out = applyEdit(t, { op: "setGate", step: 0, index: 0, fields: { max_rounds: 3 } });
    expect(out).toBe(t.replace("max_rounds: 2", "max_rounds: 3"));
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    expect(parsed.workflow.steps[1].gates[0]).toMatchObject({ kind: "agent", text: "review the change" });
  });

  test("F3: editing the description of a gate in braces keeps an escaped newline in its script", () => {
    const t = `version: 1
name: demo
steps:
  - id: a
    instruction: do it
    gates:
      - { script: "bun test\\nbun run lint", description: old }
`;
    const out = applyEdit(t, { op: "setGate", step: 0, index: 0, fields: { description: "new" } });
    expect(out).toBe(t.replace("description: old", "description: new"));
    expect(YAML.parse(out).steps[0].gates[0]).toEqual({ script: "bun test\nbun run lint", description: "new" });
  });
});

describe("the safety net", () => {
  test("accepts text that means the expected data, aliases resolved", () => {
    expect(() => verifyEdit("a: &x [1, 2]\nb: *x\n", { a: [1, 2], b: [1, 2] })).not.toThrow();
  });

  test("throws when the text does not parse", () => {
    expect(() => verifyEdit("a: [1, 2\n", { a: [1, 2] })).toThrow(/invalid YAML/);
  });

  test("throws when the text means other data, and says where", () => {
    expect(() => verifyEdit("steps:\n  - id: a\n    instruction:\n", { steps: [{ id: "a", instruction: "Do it." }] })).toThrow(/steps\.0\.instruction/);
    expect(() => verifyEdit("a: *x\n", { a: 1 })).toThrow();
  });
});

describe("every kind of edit keeps comments, anchors and aliases elsewhere", () => {
  const text = `# The workflow's own comment
version: 1
name: demo # the name
description: >
  A description that is folded
  over two lines.
steps:
  # the first step
  - id: a
    title: A   # spaced comment
    instruction: &shared >
      Shared instruction text that is folded
      over two lines.
    produces:
      - artifact: notes # inline
        path: notes.md
    gates:
      - &review { agent: review the change, max_rounds: 2 }
  # the second step
  - id: b
    instruction: Do b.
    consumes: [notes]
    produces:
      - artifact: plan
        path: plan.md
    gates:
      - check: default
      - owner-action: approve
  - id: c
    instruction: *shared
    gates:
      - *review
    # trailing note of c
`;
  const edits: Edit[] = [
    { op: "setWorkflowField", key: "name", value: "renamed" },
    { op: "setWorkflowField", key: "description", value: "short" },
    { op: "setStepField", step: 1, key: "title", value: "B" },
    { op: "setStepField", step: 1, key: "id", value: "bee" },
    { op: "setInstruction", step: 1, text: "Line one.\nLine two.", style: "|" },
    { op: "setCondition", step: 1, condition: { kind: "agent", text: "when needed", description: "why" } },
    { op: "setConsumes", step: 1, ids: ["notes", "more"] },
    { op: "addOutput", step: 1, mode: "produces", artifact: "extra", path: "extra.md" },
    { op: "removeOutput", step: 1, mode: "produces", index: 0 },
    { op: "setOutput", step: 1, mode: "produces", index: 0, fields: { path: "other.md", description: "the plan" } },
    { op: "changeOutputMode", step: 1, mode: "produces", index: 0, to: "updates" },
    { op: "addGate", step: 1, gate: { kind: "script", text: "bun test" } },
    { op: "removeGate", step: 1, index: 0 },
    { op: "setGate", step: 1, index: 1, fields: { text: "approve it", route_back_to: ["a"] } },
    { op: "insertStep", at: 1, step: { id: "n", instruction: "New." } },
    { op: "deleteStep", index: 1 },
    { op: "moveStep", from: 1, to: 2 },
  ];
  const kept = [
    "# The workflow's own comment",
    "  # the first step",
    "    title: A   # spaced comment",
    "    instruction: &shared >\n      Shared instruction text that is folded\n      over two lines.\n",
    "      - artifact: notes # inline",
    "      - &review { agent: review the change, max_rounds: 2 }",
    "    instruction: *shared",
    "      - *review",
    "    # trailing note of c",
  ];
  const aliased = (out: string) => YAML.parse(out).steps.find((s: { id: string }) => s.id === "c");

  for (const edit of edits) {
    test(`${edit.op}${"key" in edit ? ` ${edit.key}` : ""}`, () => {
      const out = applyEdit(text, edit);
      expect(out).not.toBe(text);
      expect(YAML.parseDocument(out).errors).toEqual([]);
      for (const line of kept) expect(out).toContain(line);
      if (edit.op !== "setWorkflowField") expect(out).toContain("name: demo # the name\n");
      expect(aliased(out)).toEqual(aliased(text));
      if (edit.op !== "deleteStep") expect(out).toContain("  # the second step\n");
    });
  }
});

describe("aliases whose anchor the edit changes", () => {
  const text = `version: 1
name: demo
steps:
  - id: a
    instruction: &do Do it.
  - id: b
    instruction: *do
`;

  test("editing the anchored value leaves the alias meaning the old value", () => {
    const out = applyEdit(text, { op: "setStepField", step: 0, key: "title", value: "T" });
    expect(out).toBe(text.replace("  - id: a\n", "  - id: a\n    title: T\n"));
    const changed = applyEdit(text, { op: "setInstruction", step: 0, text: "Do something else.", style: ">" });
    expect(YAML.parse(changed).steps.map((s: { instruction: string }) => s.instruction)).toEqual(["Do something else.\n", "Do it."]);
  });

  test("deleting the step with the anchor writes the alias's value out", () => {
    const out = applyEdit(text, { op: "deleteStep", index: 0 });
    expect(out).toBe("version: 1\nname: demo\nsteps:\n  - id: b\n    instruction: Do it.\n");
  });

  test("moving the alias before its anchor writes the alias's value out", () => {
    const out = applyEdit(text, { op: "moveStep", from: 1, to: 0 });
    expect(YAML.parseDocument(out).errors).toEqual([]);
    expect(YAML.parse(out).steps).toEqual([
      { id: "b", instruction: "Do it." },
      { id: "a", instruction: "Do it." },
    ]);
  });
});

describe("an anchored collection that holds an alias of its own", () => {
  const text = `version: 1
name: demo
steps:
  - id: a
    instruction: x
    gates: &g [{ agent: &review Review. }, { agent: *review }]
  - id: b
    instruction: y
    gates: *g
`;
  const gates = [{ agent: "Review." }, { agent: "Review." }];

  test("deleting the step with the anchor writes the whole value out, nested aliases included", () => {
    const out = applyEdit(text, { op: "deleteStep", index: 0 });
    expect(YAML.parseDocument(out).errors).toEqual([]);
    expect(YAML.parse(out).steps).toEqual([{ id: "b", instruction: "y", gates }]);
  });

  test("moving the alias before its anchor writes the whole value out, nested aliases included", () => {
    const out = applyEdit(text, { op: "moveStep", from: 1, to: 0 });
    expect(YAML.parseDocument(out).errors).toEqual([]);
    expect(YAML.parse(out).steps).toEqual([
      { id: "b", instruction: "y", gates },
      { id: "a", instruction: "x", gates },
    ]);
  });
});

describe("an alias at the top level of the file", () => {
  const text = `version: 1
name: &n demo
description: *n
steps:
  - id: a
    instruction: x
`;

  test("editing the anchored name writes the alias's old value out in its own place", () => {
    const out = applyEdit(text, { op: "setWorkflowField", key: "name", value: "renamed" });
    expect(YAML.parse(out)).toEqual({ version: 1, name: "renamed", description: "demo", steps: [{ id: "a", instruction: "x" }] });
    expect(out).toBe("version: 1\nname: &n renamed\ndescription: demo\nsteps:\n  - id: a\n    instruction: x\n");
  });
});

describe("moving a block output into a list written in brackets", () => {
  const text = `version: 1
name: demo
steps:
  - id: a
    instruction: x
    produces:
      - artifact: p
        path: a, b.md
        description: >
          A folded
          description.
    updates: [{ artifact: q, path: q.md }]
`;

  test("a value that cannot stand as written inside braces is written so that it can", () => {
    const out = applyEdit(text, { op: "changeOutputMode", step: 0, mode: "produces", index: 0, to: "updates" });
    expect(YAML.parseDocument(out).errors).toEqual([]);
    expect(YAML.parse(out).steps[0]).toEqual({
      id: "a",
      instruction: "x",
      updates: [
        { artifact: "q", path: "q.md" },
        { artifact: "p", path: "a, b.md", description: "A folded description.\n" },
      ],
    });
  });
});

describe("bug bash: steps fuse-flow accepts and Komposer could not edit", () => {
  const ok = (out: string) => {
    const parsed = parseWorkflowText(out);
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
    return parsed.workflow;
  };

  test("an instruction in a step written in braces is edited there, also with several lines", () => {
    const t = "version: 1\nname: flow-step\nsteps:\n  - { id: a, instruction: Do it. }\n";
    for (const style of [">", "|"] as const) {
      const out = applyEdit(t, { op: "setInstruction", step: 0, text: "Do it again.", style });
      expect(out).toBe(t.replace("Do it.", "Do it again."));
    }
    const lines = applyEdit(t, { op: "setInstruction", step: 0, text: "Write the note.\nWrite the extra.", style: "|" });
    expect(ok(lines).steps[0].instruction).toBe("Write the note.\nWrite the extra.");
    expect(lines.split("\n").slice(0, 3).join("\n")).toBe(t.split("\n").slice(0, 3).join("\n"));
    expect(applyEdit(t, { op: "setInstruction", step: 0, text: "Do it. ", style: "|" })).toBe(t);
  });

  test("a step list written in brackets takes an instruction edit too", () => {
    const t = 'version: 1\nname: flow-instruction\nsteps: [{id: write, instruction: "Write the bash-note.", produces: {artifact: bash-note, path: note.md}}]\n';
    const out = applyEdit(t, { op: "setInstruction", step: 0, text: "Write the bash-note.\nWrite the bash-extra.", style: "|" });
    expect(ok(out).steps[0].instruction).toBe("Write the bash-note.\nWrite the bash-extra.");
  });

  test("whether an instruction can be a block is told apart", () => {
    expect(instructionTakesBlock("version: 1\nname: a\nsteps:\n  - id: a\n    instruction: x\n", 0)).toBe(true);
    expect(instructionTakesBlock("version: 1\nname: a\nsteps:\n  - { id: a, instruction: x }\n", 0)).toBe(false);
    expect(instructionTakesBlock("version: 1\nname: a\nsteps: [{ id: a, instruction: x }]\n", 0)).toBe(false);
  });

  const dash = "version: 1\nname: dash-lines\nsteps:\n  -\n    id: a\n    instruction: Do it.\n  - id: b\n    instruction: Then this.\n";

  test("a step whose dash stands on its own line is edited, and so is the rest of the file", () => {
    expect(ok(dash).steps.map((s) => s.id)).toEqual(["a", "b"]);
    const name = applyEdit(dash, { op: "setWorkflowField", key: "name", value: "renamed" });
    expect(name).toBe(dash.replace("name: dash-lines", "name: renamed"));
    const title = applyEdit(dash, { op: "setStepField", step: 0, key: "title", value: "A" });
    expect(ok(title).steps[0]).toMatchObject({ id: "a", title: "A", instruction: "Do it." });
    expect(title.endsWith("  - id: b\n    instruction: Then this.\n")).toBe(true);
    const other = applyEdit(dash, { op: "setStepField", step: 1, key: "title", value: "B" });
    expect(other.startsWith("version: 1\nname: dash-lines\nsteps:\n  -\n    id: a\n    instruction: Do it.\n")).toBe(true);
    expect(ok(other).steps[1]).toMatchObject({ id: "b", title: "B" });
    const moved = applyEdit(dash, { op: "moveStep", from: 0, to: 1 });
    expect(ok(moved).steps.map((s) => s.id)).toEqual(["b", "a"]);
  });

  // An anchor, a tag or a comment between a step's dash and its first key
  // stands between the two in the text; the dash is still the step's.
  const between: [string, string][] = [
    ["an anchor on the dash line", "  - &first id: a\n"],
    ["a tag on the dash line", "  - !!map id: a\n"],
    ["an anchor alone on the dash line", "  - &first\n    id: a\n"],
    ["a comment on the dash line", "  - # first step\n    id: a\n"],
    ["a comment between the dash and the first key", "  -\n    # first step\n    id: a\n"],
  ];
  for (const [what, head] of between) {
    const t = `version: 1\nname: between\nsteps:\n${head}    instruction: Do it.\n  - id: b\n    instruction: Then this.\n`;
    test(`a step with ${what} is edited, and so is the step after it`, () => {
      expect(ok(t).steps.map((s) => s.id)).toEqual(["a", "b"]);
      const first = applyEdit(t, { op: "setStepField", step: 0, key: "title", value: "A" });
      expect(first).toBe(t.replace("id: a\n", "id: a\n    title: A\n"));
      const second = applyEdit(t, { op: "setStepField", step: 1, key: "title", value: "B" });
      expect(second).toBe(t.replace("id: b\n", "id: b\n    title: B\n"));
      const moved = applyEdit(t, { op: "moveStep", from: 1, to: 0 });
      expect(ok(moved).steps.map((s) => s.id)).toEqual(["b", "a"]);
      expect(moved).toContain(`${head}    instruction: Do it.\n`);
    });
  }

  test("a step in braces rendered again keeps the comment between its dash and its braces, above the dash", () => {
    const t = "version: 1\nname: between\nsteps:\n  -\n    # first step\n    { id: a, instruction: x }\n  - id: b\n    instruction: Then this.\n";
    const out = applyEdit(t, { op: "setStepField", step: 0, key: "title", value: "A" });
    expect(out).toBe("version: 1\nname: between\nsteps:\n  # first step\n  - { id: a, title: A, instruction: x }\n  - id: b\n    instruction: Then this.\n");
  });
});

describe("bug bash: an edit to one key of a step keeps the layout of its other keys", () => {
  const t = `version: 1
name: indent
steps:
  - id: a
    title: Old
    instruction   : Do it.
    description: >2
        Indented further.
    produces:
        - artifact: note
          path: note.md
    gates:
        - check: default
  - id: b
    instruction: Then.
`;

  test("setting the title changes the title line only", () => {
    const out = applyEdit(t, { op: "setStepField", step: 0, key: "title", value: "New" });
    expect(out).toBe(t.replace("title: Old", "title: New"));
  });

  test("adding and removing a key adds and removes its line only", () => {
    const phase = applyEdit(t, { op: "setStepField", step: 0, key: "phase", value: "Build" });
    expect(phase).toBe(t.replace("    title: Old\n", "    title: Old\n    phase: Build\n"));
    const noTitle = applyEdit(t, { op: "setStepField", step: 0, key: "title", value: null });
    expect(noTitle).toBe(t.replace("    title: Old\n", ""));
    const gate = applyEdit(t, { op: "addGate", step: 1, gate: { kind: "check", text: "default" } });
    expect(gate).toBe(`${t}    gates:\n      - check: default\n`);
  });

  test("changing one list writes that list and leaves the others", () => {
    const out = applyEdit(t, { op: "addGate", step: 0, gate: { kind: "agent", text: "review it" } });
    expect(out.startsWith(t.slice(0, t.indexOf("    gates:")))).toBe(true);
    expect(YAML.parse(out).steps[0].gates).toEqual([{ check: "default" }, { agent: "review it" }]);
  });

  test("renaming the id on the dash line keeps the step's other lines", () => {
    const out = applyEdit(t, { op: "setStepField", step: 0, key: "id", value: "first" });
    expect(out).toBe(t.replace("  - id: a\n", "  - id: first\n"));
  });
});

describe("bug bash: an edit to one item of a step's list keeps the list's other items", () => {
  const t = `version: 1
name: indent
steps:
  - id: a
    instruction: Do it.
    produces:
        - artifact: note
          path: note.md
        # the plan
        - artifact: plan
          path:   plan.md
    gates:
        - check: default
        # run the tests
        - script: bun   test
        - agent: look at it
          max_rounds: 2
    consumes: [
      x, # first
      y
    ]
  - id: b
    instruction: Then.
`;
  const steps0 = (out: string) => YAML.parse(out).steps[0];

  test("adding a gate keeps the gates there and writes the new one at their column", () => {
    const out = applyEdit(t, { op: "addGate", step: 0, gate: { kind: "agent", text: "review it" } });
    expect(out).toBe(t.replace("          max_rounds: 2\n", "          max_rounds: 2\n        - agent: review it\n"));
  });

  test("editing one gate writes that gate only", () => {
    const out = applyEdit(t, { op: "setGate", step: 0, index: 2, fields: { text: "look again" } });
    expect(out).toBe(t.replace("- agent: look at it", "- agent: look again"));
  });

  test("removing a gate takes out its lines and the comment lines above it, and leaves the others", () => {
    const out = applyEdit(t, { op: "removeGate", step: 0, index: 1 });
    expect(out).toBe(t.replace("        # run the tests\n        - script: bun   test\n", ""));
    expect(steps0(out).gates).toHaveLength(2);
  });

  test("editing one output writes that output only", () => {
    const out = applyEdit(t, { op: "setOutput", step: 0, mode: "produces", index: 0, fields: { path: "notes.md" } });
    expect(out).toBe(t.replace("path: note.md", "path: notes.md"));
  });

  test("adding an output keeps the outputs there", () => {
    const out = applyEdit(t, { op: "addOutput", step: 0, mode: "produces", artifact: "log", path: "log.md" });
    expect(out).toBe(t.replace("          path:   plan.md\n", "          path:   plan.md\n        - artifact: log\n          path: log.md\n"));
  });

  test("removing a gate from a flow list keeps the step's other flow list, comments on its brackets included", () => {
    const flow = "version: 1\nname: a\nsteps:\n  - id: a\n    instruction: Do it.\n    consumes: [ # on open\n      x,\n      y\n    ] # on close\n    gates: [\n      { check: default },\n      { script: bun test }\n    ]\n";
    const out = applyEdit(flow, { op: "removeGate", step: 0, index: 1 });
    expect(out).toBe("version: 1\nname: a\nsteps:\n  - id: a\n    instruction: Do it.\n    consumes: [ # on open\n      x,\n      y\n    ] # on close\n    gates: [{ check: default }]\n");
  });
});

describe("setHandOff", () => {
  const text = (handOff: string) => `version: 1\nname: h\nhands_off_to: ${handOff}\nsteps:\n  - id: a\n    instruction: Do it.\n`;

  test("sets the workflow of one hand-off in each form fuse-flow reads", () => {
    expect(applyEdit(text("next"), { op: "setHandOff", index: 0, workflow: "../next.yml" })).toBe(text("../next.yml"));
    expect(applyEdit(text("{ workflow: next, when: later }"), { op: "setHandOff", index: 0, workflow: "other" })).toBe(
      text("{ workflow: other, when: later }"),
    );
    expect(applyEdit(text("[a, { workflow: b, when: then }]"), { op: "setHandOff", index: 1, workflow: "c" })).toBe(
      text("[a, { workflow: c, when: then }]"),
    );
    const parsed = parseWorkflowText(applyEdit(text("[a, b]"), { op: "setHandOff", index: 1, workflow: "c" }));
    expect(parsed.ok && parsed.workflow.hands_off_to.map((h) => h.workflow)).toEqual(["a", "c"]);
  });

  test("refuses an index the file has no hand-off at", () => {
    expect(() => applyEdit(text("next"), { op: "setHandOff", index: 1, workflow: "x" })).toThrow("hand-off index 1 is out of range");
    expect(() => applyEdit(`version: 1\nname: h\nsteps:\n  - id: a\n    instruction: Do it.\n`, { op: "setHandOff", index: 0, workflow: "x" })).toThrow(
      "hand-off index 0 is out of range",
    );
  });
});
