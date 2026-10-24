// SPDX-License-Identifier: Apache-2.0
// The decisions behind a workflow gate's marker and its inspector fields, as
// pure functions over the gate, the step list and the inputs draft.

import { describe, expect, test } from "bun:test";
import type { Gate } from "../../flow/src/schemas/gate.ts";
import {
  addRow,
  childInputsOf,
  compareGateExtra,
  defaultChildSlug,
  delegationView,
  draftOwner,
  draftFor,
  forEachChip,
  gateArtifacts,
  isPerItem,
  iteratedArtifact,
  oneChildFields,
  perItemFields,
  rebindRow,
  removeRow,
  renameRow,
  rerunFields,
  type InputsDraft,
} from "../src/model/delegation.ts";
import type { OpenWorkflow, StepView, WorkflowLink } from "../src/workflowView.ts";

const wf = (extra: Partial<Gate> = {}): Gate => ({ kind: "workflow", text: "child", route_back_to: [], ...extra });
const perItem = (extra: Partial<Gate> = {}) => wf({ for_each: "units", inputs: { spec: "units" }, ...extra });
const step = (id: string, extra: Partial<StepView> = {}): StepView => ({ id, consumes: [], artifacts: [], gates: [], ...extra });
const produces = (id: string) => ({ artifact: id, path: `${id}.md`, role: "produces" as const });
const ok: WorkflowLink = { ok: true, key: "/w/child.yml", name: "child", path: "/w/child.yml" };
const missing: WorkflowLink = { ok: false, reason: "not found" };
const draft = (gate: Gate): InputsDraft => draftFor(gate, undefined);

describe("the per-item marker", () => {
  test("a per-item gate gets the for-each chip", () => {
    expect(isPerItem(perItem())).toBe(true);
    expect(forEachChip(perItem())).toBe("for-each units");
  });

  test("a single-child gate has no chip", () => {
    expect(isPerItem(wf())).toBe(false);
    expect(forEachChip(wf())).toBeNull();
  });

  test("the consumes chip marked is the step's for_each, and only on a step that iterates", () => {
    expect(iteratedArtifact(step("s", { consumes: ["units", "run"], gates: [perItem()] }))).toBe("units");
    expect(iteratedArtifact(step("s", { consumes: ["units"], gates: [wf()] }))).toBeNull();
    expect(iteratedArtifact(step("s", { consumes: ["units"] }))).toBeNull();
  });

  test("the slug placeholder follows the kind of gate", () => {
    expect(defaultChildSlug(perItem())).toBe("{slug}-{step}-{item}");
    expect(defaultChildSlug(wf())).toBe("{slug}-{step}");
  });
});

describe("Compare's gate extra", () => {
  test("a per-item gate shows for-each, its slug and its routes", () => {
    expect(compareGateExtra(perItem({ route_back_to: ["a"] }), "p")).toBe("for-each units · ↳ {slug}-p-{item} · ↩ a");
    expect(compareGateExtra(perItem(), "p")).toBe("for-each units · ↳ {slug}-p-{item}");
  });

  test("a single-child gate shows its slug and its routes", () => {
    expect(compareGateExtra(wf({ route_back_to: ["a", "b"] }), "p")).toBe("↳ {slug}-p · ↩ a, b");
    expect(compareGateExtra(wf(), "p")).toBe("↳ {slug}-p");
  });

  test("the rerun settings show with their values, so gates differing only in them read differently", () => {
    expect(compareGateExtra(perItem({ accept: "succeeded", rerun: "failed", rerun_override: false, retries: 2 }), "p")).toBe(
      "for-each units · ↳ {slug}-p-{item} · accept succeeded · rerun failed · rerun_override false · retries 2",
    );
    expect(compareGateExtra(wf({ accept: "succeeded" }), "p")).toBe("↳ {slug}-p · accept succeeded");
  });

  test("a non-workflow gate shows only its routes", () => {
    expect(compareGateExtra({ kind: "agent", text: "x", route_back_to: ["a"] }, "p")).toBe("↩ a");
    expect(compareGateExtra({ kind: "agent", text: "x", route_back_to: [] }, "p")).toBe("");
  });
});

describe("switching to one for-each item", () => {
  test("a binding to the folder already there is kept", () => {
    const r = perItemFields(wf({ inputs: { spec: "units" } }), "units", ["spec", "other"]);
    expect(r.fields).toEqual({ for_each: "units" });
    expect(r.needsBinding).toBe(false);
  });

  test("the child's one unbound input is bound to the folder", () => {
    const r = perItemFields(wf({ inputs: { brief: "brief" } }), "units", ["brief", "spec"]);
    expect(r.fields).toEqual({ for_each: "units", inputs: [["brief", "brief"], ["spec", "units"]] });
    expect(r.needsBinding).toBe(false);
  });

  test("with no unbound child input, two of them, or an unknown child, no binding is added", () => {
    for (const childInputs of [["brief"], ["a", "b"], null]) {
      const r = perItemFields(wf({ inputs: { brief: "brief" } }), "units", childInputs);
      expect(r.fields).toEqual({ for_each: "units" });
      expect(r.needsBinding).toBe(true);
    }
  });

  test("an explicit slug gains {item} when it lacks it, and is kept when it has it", () => {
    expect(perItemFields(wf({ slug: "{slug}-unit" }), "units", null).fields.slug).toBe("{slug}-unit-{item}");
    expect(perItemFields(wf({ slug: "{slug}-u-{item}" }), "units", null).fields).not.toHaveProperty("slug");
    expect(perItemFields(wf(), "units", null).fields).not.toHaveProperty("slug");
  });
});

describe("switching to one child", () => {
  test("removes for_each and the per-item settings, and keeps the inputs", () => {
    const fields = oneChildFields(perItem({ rerun: "failed", rerun_override: false, retries: 2 }));
    expect(fields).toEqual({ for_each: null, rerun: null, rerun_override: null, retries: null });
  });

  test("clears every per-item key, also one the gate does not show because its value is malformed", () => {
    expect(oneChildFields(wf())).toEqual({ for_each: null, rerun: null, rerun_override: null, retries: null });
  });

  test("removes a slug that contains {item}, whatever its shape, and keeps one without it", () => {
    for (const slug of ["{slug}-{step}-{item}", "{slug}-{item}", "{item}-{slug}", "{slug}x{item}", "{slug}-{item}-{item}"]) {
      expect(oneChildFields(perItem({ slug })).slug).toBeNull();
    }
    expect(oneChildFields(perItem({ slug: "{slug}-unit" }))).not.toHaveProperty("slug");
  });
});

describe("re-run on send-back", () => {
  test("failed items only keeps retries", () => {
    expect(rerunFields("failed", perItem({ retries: 2 }))).toEqual({ rerun: "failed" });
    expect(rerunFields("failed", perItem())).toEqual({ rerun: "failed" });
  });

  test("every item also removes retries, whose control it disables", () => {
    expect(rerunFields("all", perItem({ rerun: "failed", retries: 2 }))).toEqual({ rerun: "all", retries: null });
    expect(rerunFields("all", perItem({ rerun: "failed" }))).toEqual({ rerun: "all" });
  });
});

describe("the artifacts a gate may name", () => {
  const at = (steps: StepView[], workflowInputs: string[] = []) => gateArtifacts(workflowInputs, steps, steps.length - 1);

  test("an earlier step's artifact and a single-child gate's return are offered to both pickers", () => {
    const r = at([step("a", { artifacts: [produces("doc")] }), step("b", { gates: [wf({ returns: { rep: "rep" } })] }), step("c")]);
    expect(r.forEach).toEqual(["doc", "rep"]);
    expect(r.inputs).toEqual(["doc", "rep"]);
  });

  test("an earlier for_each gate's return is offered to neither", () => {
    const r = at([step("a", { gates: [perItem({ returns: { verdicts: "v" } })] }), step("c")]);
    expect(r.forEach).toEqual([]);
    expect(r.inputs).toEqual([]);
  });

  test("this gate's own return is a retry binding for inputs only, unless an earlier document has its id", () => {
    const own = at([step("a", { artifacts: [produces("doc")] }), step("c", { gates: [perItem({ returns: { v: "v", doc: "d" } })] })]);
    expect(own.forEach).toEqual(["doc"]);
    expect(own.inputs).toEqual(["doc", "v"]);
  });

  test("a single-child gate's own return is no retry binding, so it is not offered", () => {
    const own = at([step("a", { artifacts: [produces("doc")] }), step("c", { gates: [wf({ returns: { v: "v" } })] })]);
    expect(own.inputs).toEqual(["doc"]);
  });

  test("the nearest writer decides: single-child then for_each is per-item, for_each then a plain writer is not", () => {
    const perItemLast = at([step("a", { gates: [wf({ returns: { x: "x" } })] }), step("b", { gates: [perItem({ returns: { x: "x" } })] }), step("c")]);
    expect(perItemLast.forEach).toEqual([]);
    expect(perItemLast.inputs).toEqual([]);
    const plainLast = at([step("a", { gates: [perItem({ returns: { x: "x" } })] }), step("b", { artifacts: [produces("x")] }), step("c")]);
    expect(plainLast.forEach).toEqual(["x"]);
    const gateLast = at([step("a", { gates: [perItem({ returns: { x: "x" } })] }), step("b", { gates: [wf({ returns: { x: "x" } })] }), step("c")]);
    expect(gateLast.inputs).toEqual(["x"]);
  });

  test("the workflow's inputs are offered to both", () => {
    const r = at([step("c")], ["seed-folder"]);
    expect(r.forEach).toEqual(["seed-folder"]);
    expect(r.inputs).toEqual(["seed-folder"]);
  });

  test("a value in the file that is not an option is kept and marked", () => {
    const steps = [step("a", { artifacts: [produces("doc")] }), step("c", { gates: [perItem({ for_each: "gone", inputs: { spec: "lost" } })] })];
    const view = delegationView(steps[1].gates[0], draft(steps[1].gates[0]), null, gateArtifacts([], steps, 1));
    expect(view.forEachOptions).toContainEqual({ id: "gone", available: false });
    expect(view.forEachOptions).toContainEqual({ id: "doc", available: true });
    expect(view.rows[0].options).toContainEqual({ id: "lost", available: false });
  });

  test("a row's unavailable value is offered to that row only", () => {
    const steps = [step("a", { artifacts: [produces("doc")] }), step("c", { gates: [wf({ inputs: { spec: "lost", ctx: "doc" } })] })];
    const g = steps[1].gates[0];
    const view = delegationView(g, draft(g), null, gateArtifacts([], steps, 1));
    expect(view.rows[0].options.map((o) => o.id)).toEqual(["doc", "lost"]);
    expect(view.rows[1].options.map((o) => o.id)).toEqual(["doc"]);
  });
});

describe("the child's declared inputs", () => {
  const child = (parsed: unknown) => ({ path: "/w/child.yml", parsed }) as unknown as OpenWorkflow;

  test("a resolved, parsed child gives its input ids", () => {
    expect(childInputsOf(ok, [child({ inputs: [{ artifact: "spec" }, { artifact: "prev" }] })])).toEqual(["spec", "prev"]);
  });

  test("a child that is not parsed, not listed or not resolved gives none", () => {
    expect(childInputsOf(ok, [child(null)])).toBeNull();
    expect(childInputsOf(ok, [])).toBeNull();
    expect(childInputsOf(missing, [child({ inputs: [] })])).toBeNull();
  });
});

describe("what the inspector shows", () => {
  const options = { forEach: ["units", "run"], inputs: ["units", "run"] };

  test("per-item controls show for a per-item gate, or once the switch is pending", () => {
    expect(delegationView(perItem(), draft(perItem()), null, options).perItem).toBe(true);
    expect(delegationView(wf(), draft(wf()), null, options).perItem).toBe(false);
    expect(delegationView(wf(), { ...draft(wf()), pendingPerItem: true }, null, options).perItem).toBe(true);
  });

  test("retries is enabled only when failed items are re-run", () => {
    expect(delegationView(perItem({ rerun: "failed" }), draft(perItem()), null, options).retriesEnabled).toBe(true);
    expect(delegationView(perItem({ rerun: "all" }), draft(perItem()), null, options).retriesEnabled).toBe(false);
    expect(delegationView(perItem(), draft(perItem()), null, options).retriesEnabled).toBe(false);
  });

  test("the row bound to the folder carries the item-file marker; others do not; a single-child gate marks none", () => {
    const g = perItem({ inputs: { spec: "units", ctx: "run" } });
    const rows = delegationView(g, draft(g), null, options).rows;
    expect(rows.map((r) => r.itemFile)).toEqual([true, false]);
    const one = wf({ inputs: { spec: "units" } });
    expect(delegationView(one, draft(one), null, options).rows.map((r) => r.itemFile)).toEqual([false]);
  });

  test("child-input suggestions come from the resolved child, or there are none", () => {
    expect(delegationView(perItem(), draft(perItem()), ["spec", "prev"], options).suggestions).toEqual(["spec", "prev"]);
    expect(delegationView(perItem(), draft(perItem()), null, options).suggestions).toEqual([]);
    expect(delegationView(wf(), draft(wf()), ["spec"], options).suggestions).toEqual(["spec"]);
  });

  test("with no folder to choose, the switch to per-item is disabled", () => {
    expect(delegationView(wf(), draft(wf()), null, { forEach: [], inputs: [] }).perItemDisabled).toBe(true);
    expect(delegationView(wf(), draft(wf()), null, options).perItemDisabled).toBe(false);
  });
});

describe("editing the inputs rows", () => {
  const g = wf({ inputs: { spec: "units", ctx: "run" } });

  test("a rename to an unused name renames the entry in place", () => {
    const r = renameRow(draft(g), 1, "context");
    expect(r.fields).toEqual({ inputs: [["spec", "units"], ["context", "run"]] });
  });

  test("a rename to a name another row uses is refused on the row and writes nothing", () => {
    const r = renameRow(draft(g), 1, "spec");
    expect(r.fields).toBeNull();
    expect(r.draft.rows[1]).toMatchObject({ name: "spec", error: "already bound in another row" });
  });

  test("a rename to an empty name writes nothing until it is filled", () => {
    expect(renameRow(draft(g), 1, "").fields).toBeNull();
  });

  test("an added row is shown and written only once it has a name and an artifact", () => {
    const added = addRow(draft(g));
    expect(added.draft.rows).toHaveLength(3);
    expect(added.fields).toBeNull();
    const named = renameRow(added.draft, 2, "extra");
    expect(named.fields).toBeNull();
    const bound = rebindRow(named.draft, 2, "run");
    expect(bound.fields).toEqual({ inputs: [["spec", "units"], ["ctx", "run"], ["extra", "run"]] });
    expect(renameRow(added.draft, 2, "spec").draft.rows[2].error).toBe("already bound in another row");
  });

  test("rebinding changes only that entry's artifact", () => {
    expect(rebindRow(draft(g), 0, "run").fields).toEqual({ inputs: [["spec", "run"], ["ctx", "run"]] });
  });

  test("removing the last entry removes the key; removing an unwritten row writes nothing", () => {
    const one = wf({ inputs: { spec: "units" } });
    expect(removeRow(draft(one), 0).fields).toEqual({ inputs: null });
    const added = addRow(draft(one));
    expect(removeRow(added.draft, 1).fields).toBeNull();
  });
});

describe("the inputs draft against the file", () => {
  const g = wf({ inputs: { spec: "units" } });

  test("a draft with an unwritten row is rebuilt when the file's inputs change, dropping that row", () => {
    const pending = addRow(draft(g)).draft;
    const changed = wf({ inputs: { spec: "run" } });
    expect(draftFor(changed, pending).rows).toEqual([{ name: "spec", artifact: "run", saved: ["spec", "run"] }]);
  });

  test("it is kept, row and error included, while the file's inputs are unchanged", () => {
    const refused = renameRow(addRow(draft(g)).draft, 1, "spec").draft;
    expect(draftFor(g, refused)).toBe(refused);
  });

  test("a draft of written rows only follows the file", () => {
    expect(draftFor(wf({ inputs: { spec: "run" } }), draft(g)).rows).toEqual([{ name: "spec", artifact: "run", saved: ["spec", "run"] }]);
    const same = draft(g);
    expect(draftFor(g, same)).toBe(same);
  });

  test("a pending switch to per-item is dropped when the gate changes", () => {
    const pending = { ...draft(g), pendingPerItem: true };
    expect(draftFor(wf({ inputs: { spec: "units" }, slug: "{slug}-x" }), pending).pendingPerItem).toBe(false);
  });

  test("a draft belongs to one gate: another gate with the same inputs starts from its own file", () => {
    const pending = addRow(draftFor(g, undefined, "step-a/0")).draft;
    expect(draftFor(g, pending, "step-b/0").rows).toEqual([{ name: "spec", artifact: "units", saved: ["spec", "units"] }]);
    expect(draftFor(g, pending, "step-a/0")).toBe(pending);
  });

  test("two steps written with the same id, or none, still own different drafts", () => {
    expect(draftOwner(1, "dup", 0)).not.toBe(draftOwner(2, "dup", 0));
    expect(draftOwner(1, "", 0)).not.toBe(draftOwner(2, "", 0));
    const pending = addRow(draftFor(g, undefined, draftOwner(1, "dup", 0))).draft;
    expect(draftFor(g, pending, draftOwner(2, "dup", 0)).rows).toHaveLength(1);
  });
});

describe("a row from the file keeps its binding while it is being edited", () => {
  const g = wf({ inputs: { spec: "units", ctx: "run" } });

  test("removing a file row renamed to an empty or duplicate name removes its binding", () => {
    for (const name of ["", "spec"]) {
      const bad = renameRow(draft(g), 1, name).draft;
      expect(removeRow(bad, 1).fields).toEqual({ inputs: [["spec", "units"]] });
    }
  });

  test("editing a sibling while a file row is invalid keeps that row's binding as written", () => {
    for (const name of ["", "spec"]) {
      const bad = renameRow(draft(g), 1, name).draft;
      expect(rebindRow(bad, 0, "other").fields).toEqual({ inputs: [["spec", "other"], ["ctx", "run"]] });
    }
  });

  test("a name an invalid file row still holds in the file counts as taken", () => {
    const emptied = renameRow(draft(g), 0, "").draft;
    const r = renameRow(emptied, 1, "spec");
    expect(r.fields).toBeNull();
    expect(r.draft.rows[1].error).toBe("already bound in another row");
  });
});

describe("an empty for_each", () => {
  test("is not treated as per-item", () => {
    expect(isPerItem(wf({ for_each: "" }))).toBe(false);
    expect(forEachChip(wf({ for_each: "" }))).toBeNull();
  });
});
