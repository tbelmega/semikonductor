// SPDX-License-Identifier: Apache-2.0
// A step's mode in Komposer: the YAML edit, what the diagram and inspector
// read from parsed and unparsable text, and where a mode error is shown. Real
// workflow text, the real engine parser.

import { describe, expect, test } from "bun:test";
import { parseWorkflowText } from "../../flow/src/parse.ts";
import { copyStepEdits, differences, hasDifferences, stepDiff } from "../src/model/compare.ts";
import { applyEdit } from "../src/model/yamlEdit.ts";
import { problemsForText } from "../src/validate.ts";
import { INVALID_MODE, modeBadge, modeSelectValue, openWorkflow, stepViews } from "../src/workflowView.ts";

const TEXT = `version: 1
name: demo
steps:
  - id: one
    title: One
    phase: Build
    instruction: Do it.
  - id: two
    mode: attended
    instruction: Do it too.
`;

const view = (text: string) =>
  stepViews(openWorkflow({ location: "project", dir: "", file: "demo.yml", path: "/p/demo.yml", onDisk: true, text, hash: "" }));

describe("the mode field", () => {
  test("setting unattended writes the key after phase and before instruction", () => {
    const edited = applyEdit(TEXT, { op: "setStepField", step: 0, key: "mode", value: "unattended" });
    expect(edited).toContain("    phase: Build\n    mode: unattended\n    instruction: Do it.\n");
    const parsed = parseWorkflowText(edited);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.workflow.steps[0].mode).toBe("unattended");
  });

  test("choosing the attended default removes the key", () => {
    const set = applyEdit(TEXT, { op: "setStepField", step: 0, key: "mode", value: "unattended" });
    expect(applyEdit(set, { op: "setStepField", step: 0, key: "mode", value: null })).toBe(TEXT);
    expect(applyEdit(TEXT, { op: "setStepField", step: 1, key: "mode", value: null })).not.toContain("mode:");
  });

  test("a parsed workflow's view carries the mode as written; absent means none", () => {
    const steps = view(TEXT);
    expect(steps[0].mode).toBeUndefined();
    expect(steps[1].mode).toBe("attended");
  });

  test("an unparsable workflow keeps an invalid mode of any type, as written, and shows its error at the mode", () => {
    for (const [written, shown] of [
      ["sometimes", "sometimes"],
      ["7", "7"],
      ["false", "false"],
      ["null", "null"],
    ] as const) {
      const bad = TEXT.replace("    mode: attended\n", `    mode: ${written}\n`);
      const steps = view(bad);
      expect(steps[1].mode).toBe(shown);
      expect(steps[0].mode).toBeUndefined();
      expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
      // Picking a valid value corrects it.
      const fixed = applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: "unattended" });
      expect(problemsForText(fixed)).toEqual([]);
      expect(view(fixed)[1].mode).toBe("unattended");
    }
  });

  test("a mode written as a list or a mapping is shown, and replaced or removed like any other", () => {
    for (const [written, shown] of [
      ["[unattended]", '["unattended"]'],
      ["\n      - unattended", '["unattended"]'],
      ["{ kind: unattended }", '{"kind":"unattended"}'],
      ["\n      kind: unattended", '{"kind":"unattended"}'],
    ] as const) {
      const bad = TEXT.replace("    mode: attended\n", `    mode: ${written}\n`);
      expect(view(bad)[1].mode).toBe(shown);
      expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
      const fixed = applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: "unattended" });
      expect(fixed).toBe(TEXT.replace("    mode: attended\n", "    mode: unattended\n"));
      expect(applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: null })).toBe(TEXT.replace("    mode: attended\n", ""));
    }
  });

  test("setting a mode on a step whose first key is not id keeps the list marker and every step", () => {
    const FIRST = "version: 1\nname: demo\nsteps:\n  - instruction: Do it.\n    id: one\n  - id: two\n    instruction: Do it too.\n";
    const set = applyEdit(FIRST, { op: "setStepField", step: 0, key: "mode", value: "unattended" });
    expect(set).toBe("version: 1\nname: demo\nsteps:\n  - mode: unattended\n    instruction: Do it.\n    id: one\n  - id: two\n    instruction: Do it too.\n");
    // A collection-valued first-key mode followed by instruction is replaced the same way.
    const bad = "version: 1\nname: demo\nsteps:\n  - mode: [unattended]\n    instruction: Do it.\n    id: one\n";
    const fixed = applyEdit(bad, { op: "setStepField", step: 0, key: "mode", value: "unattended" });
    expect(fixed).toBe("version: 1\nname: demo\nsteps:\n  - mode: unattended\n    instruction: Do it.\n    id: one\n");
    expect(parseWorkflowText(fixed).ok).toBe(true);
  });

  test("a mode written as a folded or literal block scalar is replaced, and the next field stays as it was", () => {
    for (const style of ["|", ">"]) {
      const bad = TEXT.replace("    mode: attended\n", `    mode: ${style}\n      sometimes\n`);
      expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
      const fixed = applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: "unattended" });
      expect(fixed).toBe(TEXT.replace("    mode: attended\n", "    mode: unattended\n"));
    }
  });

  test("a bare mode key with no value is corrected, and the next field stays as it was", () => {
    const bad = TEXT.replace("    mode: attended\n", "    mode:\n");
    expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
    const fixed = applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: "unattended" });
    expect(fixed).toBe(TEXT.replace("    mode: attended\n", "    mode: unattended\n"));
  });

  test("a step written as a flow mapping keeps its form and its other keys", () => {
    const FLOW = "version: 1\nname: demo\nsteps:\n  - { id: one, instruction: Do it., mode: unattended }\n  - id: two\n    instruction: Do it too.\n";
    const set = (value: string | null) => applyEdit(FLOW, { op: "setStepField", step: 0, key: "mode", value });
    expect(set(null)).toBe(FLOW.replace(", mode: unattended", ""));
    expect(set("attended")).toBe(FLOW.replace("mode: unattended", "mode: attended"));
    expect(set("unattended")).toBe(FLOW);
  });

  test("an empty mode with a comment or an anchor is set or cleared without touching the next line", () => {
    const HEAD = "version: 1\nname: demo\nsteps:\n  - id: one\n";
    const TAIL = "  - id: two\n    instruction: Do too.\n";
    const set = (text: string, value: string | null) => applyEdit(text, { op: "setStepField", step: 0, key: "mode", value });
    expect(set(`${HEAD}    mode: # choose later\n    instruction: Do it.\n`, "unattended")).toBe(
      `${HEAD}    mode: unattended # choose later\n    instruction: Do it.\n`,
    );
    expect(set(`${HEAD}    mode: &v\n    instruction: Do it.\n`, "unattended")).toBe(`${HEAD}    mode: &v unattended\n    instruction: Do it.\n`);
    // Cleared before another field, and as the step's last field.
    expect(set(`${HEAD}    mode: # choose later\n    instruction: Do it.\n${TAIL}`, null)).toBe(`${HEAD}    instruction: Do it.\n${TAIL}`);
    expect(set(`${HEAD}    instruction: Do it.\n    mode: # choose later\n${TAIL}`, null)).toBe(`${HEAD}    instruction: Do it.\n${TAIL}`);
  });

  test("a list-valued mode that is a step's only key is replaced in that step, and the next step is untouched", () => {
    const ONLY = "version: 1\nname: demo\nsteps:\n  - mode: [x]\n  - id: two\n    instruction: Do it too.\n";
    expect(applyEdit(ONLY, { op: "setStepField", step: 0, key: "mode", value: "unattended" })).toBe(ONLY.replace("[x]", "unattended"));
  });

  test("a mode that refers to itself through an alias is shown as YAML, with its error", () => {
    for (const [written, shown] of [
      ["&loop [*loop]", "&a1 [ *a1 ]"],
      ["&loop { next: *loop }", "&a1 { next: *a1 }"],
    ] as const) {
      const bad = TEXT.replace("    mode: attended\n", `    mode: ${written}\n`);
      expect(view(bad)[1].mode).toBe(shown);
      expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
    }
  });

  test("a mode written as the first key of a step, beside the list marker, is replaced or removed and keeps the step", () => {
    const FIRST = "version: 1\nname: demo\nsteps:\n  - id: one\n    instruction: Do it.\n  - mode: MODE\n    id: two\n    instruction: Do it too.\n";
    const expected = (mode: string | null) =>
      mode === null
        ? "version: 1\nname: demo\nsteps:\n  - id: one\n    instruction: Do it.\n  - id: two\n    instruction: Do it too.\n"
        : FIRST.replace("MODE", mode);
    for (const written of ["unattended", "attended", "[unattended]", "{ kind: unattended }"]) {
      const text = FIRST.replace("MODE", written);
      const removed = applyEdit(text, { op: "setStepField", step: 1, key: "mode", value: null });
      expect(removed).toBe(expected(null));
      expect(parseWorkflowText(removed).ok).toBe(true);
      if (written !== "unattended") {
        const set = applyEdit(text, { op: "setStepField", step: 1, key: "mode", value: "unattended" });
        const parsed = parseWorkflowText(set);
        expect(parsed.ok).toBe(true);
        if (parsed.ok) expect(parsed.workflow.steps.map((s) => [s.id, s.mode])).toEqual([["one", undefined], ["two", "unattended"]]);
      }
    }
  });
});

describe("the mode in Compare", () => {
  const wf = (name: string, steps: string) => `version: 1\nname: ${name}\nsteps:\n${steps}`;
  const build = (mode: string | null, instruction = "Build it.") =>
    `  - id: build\n${mode === null ? "" : `    mode: ${mode}\n`}    instruction: ${instruction}\n`;
  const status = (a: string, b: string) => {
    const d = stepDiff(view(a)[0], view(b)[0]);
    return { changed: hasDifferences(d), mode: d.mode };
  };

  test("a step differs when its mode differs, and an absent mode is the same as attended", () => {
    expect(status(wf("a", build("unattended")), wf("b", build(null)))).toEqual({ changed: true, mode: true });
    expect(status(wf("a", build("unattended")), wf("b", build("attended")))).toEqual({ changed: true, mode: true });
    expect(status(wf("a", build("attended")), wf("b", build(null)))).toEqual({ changed: false, mode: false });
    // Whitespace makes a mode invalid, so it is a difference.
    expect(status(wf("a", build('"unattended "')), wf("b", build("unattended"))).mode).toBe(true);
    expect(status(wf("a", build('"attended "')), wf("b", build(null))).mode).toBe(true);
    expect(status(wf("a", build('"unattended\\n"')), wf("b", build("unattended"))).mode).toBe(true);
  });

  test("applying a mode difference sets the right's mode, or removes the key when the right has none", () => {
    for (const [left, right] of [
      [null, "unattended"],
      ["attended", "unattended"],
      ["unattended", null],
      ["unattended", "attended"],
    ] as const) {
      const [l, r] = [wf("a", build(left)), wf("b", build(right))];
      const diffs = differences(view(l)[0], view(r)[0], 0);
      expect(diffs.map((d) => d.label)).toEqual([`mode → ${right ?? "attended"}`]);
      const applied = diffs[0].edits.reduce((t, edit) => applyEdit(t, edit), l);
      expect(view(applied)[0].mode).toBe(right ?? undefined);
      expect(hasDifferences(stepDiff(view(applied)[0], view(r)[0]))).toBe(false);
    }
  });

  test("copying a step keeps its mode as written, when it replaces a step and when it is new", () => {
    const copy = (source: string, target: string) =>
      copyStepEdits(view(source), 0, view(target), 0).reduce((t, edit) => applyEdit(t, edit), target);
    const other = "  - id: other\n    instruction: Keep it.\n";
    for (const mode of ["unattended", "attended", null]) {
      const source = wf("source", build(mode));
      for (const target of [wf("target", build(null, "Old.") + other), wf("target", other)]) {
        const copied = view(copy(source, target)).find((s) => s.id === "build")!;
        expect(copied.mode).toBe(mode ?? undefined);
      }
    }
  });
});

describe("the mode badge on a step card", () => {
  test("no mode reads attended, unattended is marked, and an invalid mode is shown as written", () => {
    expect(modeBadge(undefined)).toEqual({ label: "attended", title: "attended (the default)", unattended: false });
    expect(modeBadge("attended")).toEqual({ label: "attended", title: "attended", unattended: false });
    expect(modeBadge("unattended")).toEqual({ label: "unattended", title: "unattended", unattended: true });
    expect(modeBadge("sometimes")).toEqual({ label: "sometimes", title: "sometimes", unattended: false });
  });
});

describe("the Mode select", () => {
  test("only no mode and attended select the default; an invalid mode, even an empty one, selects its own option", () => {
    expect(modeSelectValue(undefined)).toBe("");
    expect(modeSelectValue("attended")).toBe("");
    expect(modeSelectValue("unattended")).toBe("unattended");
    for (const invalid of ["", "sometimes", "[\"unattended\"]"]) expect(modeSelectValue(invalid)).toBe(INVALID_MODE);
  });

  test("an empty mode is invalid, and choosing attended removes it", () => {
    const bad = TEXT.replace("    mode: attended\n", '    mode: ""\n');
    expect(view(bad)[1].mode).toBe("");
    expect(problemsForText(bad)).toEqual([{ stepIndex: 1, field: "mode", message: "Mode is attended or unattended." }]);
    expect(applyEdit(bad, { op: "setStepField", step: 1, key: "mode", value: null })).toBe(TEXT.replace("    mode: attended\n", ""));
  });
});
