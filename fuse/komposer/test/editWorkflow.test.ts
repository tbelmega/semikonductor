// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { copyStepEdits } from "../src/model/compare.ts";
import { editedWorkflow, movedRef, movedRefEdits, shownText } from "../src/model/editWorkflow.ts";
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

describe("saving a workflow at another path", () => {
  const TEXT = `version: 1
name: alpha
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: review it
        guide: ../../README.md
      - agent: review it again
        guide: /abs/rules.md
  - id: hand
    instruction: Hand it on.
    gates:
      - workflow: ./child.yml
  - id: named
    instruction: Ask.
    gates:
      - workflow: child
`;
  const FROM = "/p/.konductor/workflows/alpha.yml";

  test("relative references are written again from the new folder, naming the same files", () => {
    expect(movedRef("../../README.md", FROM, "/p/.konductor/workflows/team/alpha3.yml")).toBe("../../../README.md");
    expect(movedRef("rules/review.md", FROM, "/p/.konductor/workflows/team/alpha3.yml")).toBe("../rules/review.md");
    expect(movedRef("../shared/rules.md", "/p/.konductor/workflows/team/a.yml", FROM)).toBe("shared/rules.md");
    expect(movedRef("/abs/rules.md", FROM, "/q/x.yml")).toBe("/abs/rules.md");
    expect(movedRef("x.md", FROM, "/p/.konductor/workflows/beta.yml")).toBe("x.md");
  });

  // fuse-flow reads a reference without "/" and without .yml or .yaml as a
  // name, so a path that would be rebased to one is written ./<file>.
  test("a path that would lose its last slash is written ./<file>, so it stays a path", () => {
    expect(movedRef("../tail", "/p/w/origin/deep/a.yml", "/p/w/origin/copied.yml")).toBe("./tail");
    expect(movedRef("../tail.yml", "/p/w/origin/deep/a.yml", "/p/w/origin/copied.yml")).toBe("./tail.yml");
    expect(movedRef("../guide.md", "/p/w/origin/deep/a.yml", "/p/w/origin/copied.yml")).toBe("./guide.md");
    expect(movedRef("tail", "/p/w/origin/a.yml", "/p/w/origin/b.yml")).toBe("tail");
    const text = "version: 1\nname: p\nhands_off_to: ../tail\nsteps:\n  - id: s\n    instruction: Do.\n    gates:\n      - workflow: ../tail\n";
    expect(movedRefEdits(text, "/p/w/origin/deep/a.yml", "/p/w/origin/copied.yml")).toEqual([
      { op: "setHandOff", index: 0, workflow: "./tail" },
      { op: "setGate", step: 0, index: 0, fields: { text: "./tail" } },
    ]);
  });

  test("the edits rewrite gate guides and workflow paths and leave names and absolute paths", () => {
    const to = "/p/.konductor/workflows/team/alpha3.yml";
    const edits = movedRefEdits(TEXT, FROM, to);
    expect(edits).toEqual([
      { op: "setGate", step: 0, index: 0, fields: { guide: "../../../README.md" } },
      { op: "setGate", step: 1, index: 0, fields: { text: "../child.yml" } },
    ]);
    const moved = editedWorkflow(open(TEXT, FROM), edits);
    expect(moved.openText).toBe(TEXT.replace("guide: ../../README.md", "guide: ../../../README.md").replace("workflow: ./child.yml", "workflow: ../child.yml"));
    expect(movedRefEdits(TEXT, FROM, "/p/.konductor/workflows/beta.yml")).toEqual([]);
  });
});

describe("hand-offs at a new place", () => {
  const text = (handOff: string) => `version: 1\nname: handoff\nhands_off_to: ${handOff}\nsteps:\n  - id: a\n    instruction: Do it.\n`;
  const FROM = "/p/.konductor/workflows/origin/handoff.yml";
  const TO = "/p/.konductor/workflows/destination/handoff.yml";

  test("a relative hand-off is written again from the new folder, naming the same file", () => {
    // destination/next.yml may be a valid workflow too, so the engine's check would pass.
    const edits = movedRefEdits(text("next.yml"), FROM, TO);
    expect(edits).toEqual([{ op: "setHandOff", index: 0, workflow: "../origin/next.yml" }]);
    expect(editedWorkflow(open(text("next.yml"), FROM), edits).openText).toBe(text("../origin/next.yml"));
  });

  test("each form of hands_off_to keeps its form and its when", () => {
    const list = `version: 1
name: handoff
hands_off_to:
  # the release comes last
  - workflow: ./next.yml
    when: once merged
  - other
  - ../shared/third.yml
steps:
  - id: a
    instruction: Do it.
`;
    const edits = movedRefEdits(list, FROM, TO);
    // ../shared/third.yml names the same file from both folders, so it stays.
    expect(edits).toEqual([{ op: "setHandOff", index: 0, workflow: "../origin/next.yml" }]);
    expect(editedWorkflow(open(list, FROM), edits).openText).toBe(list.replace("workflow: ./next.yml", "workflow: ../origin/next.yml"));
    const single = text("{ workflow: next.yml, when: later }");
    const moved = editedWorkflow(open(single, FROM), movedRefEdits(single, FROM, TO)).openText;
    expect(moved).toBe(text("{ workflow: ../origin/next.yml, when: later }"));
  });

  test("names, absolute paths and a save in the same folder change nothing", () => {
    expect(movedRefEdits(text("next"), FROM, TO)).toEqual([]);
    expect(movedRefEdits(text("/abs/next.yml"), FROM, TO)).toEqual([]);
    expect(movedRefEdits(text("next.yml"), FROM, "/p/.konductor/workflows/origin/other.yml")).toEqual([]);
  });
});
