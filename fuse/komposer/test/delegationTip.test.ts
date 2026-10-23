// SPDX-License-Identifier: Apache-2.0
// What a workflow gate's tooltip says about how its children are accepted and re-run.

import { describe, expect, test } from "bun:test";
import type { Gate } from "../../flow/src/schemas/gate.ts";
import { delegationTip } from "../src/delegationTip.ts";
import type { WorkflowLink } from "../src/workflowView.ts";

const link = { ok: true, path: "unit.yml" } as WorkflowLink;
const tip = (extra: Partial<Gate>) => delegationTip({ kind: "workflow", text: "unit", route_back_to: [], for_each: "units", ...extra } as Gate, link);

describe("delegationTip", () => {
  test("a gate without the settings gets none of their lines", () => {
    expect(tip({})).not.toMatch(/acceptance criteria|re-run|cannot choose/);
    expect(tip({ retries: 0, rerun_override: true })).not.toMatch(/re-runs failed|cannot choose/);
  });

  test("accept says what passes the gate", () => {
    expect(tip({ accept: "succeeded" })).toContain("acceptance criteria: all children are successful");
    expect(tip({ accept: "finished" })).toContain("acceptance criteria: all children are completed");
  });

  test("rerun says what a send-back re-runs", () => {
    expect(tip({ rerun: "failed" })).toContain("a send-back re-runs: failed items only; the others are carried over");
    expect(tip({ rerun: "all" })).toContain("a send-back re-runs: all items");
  });

  test("rerun_override: false and retries each get their line, retries counted in the singular and the plural", () => {
    expect(tip({ rerun_override: false })).toContain("the owner cannot choose the items to re-run");
    expect(tip({ rerun: "failed", retries: 1 })).toContain("re-runs failed items by itself: up to 1 time");
    expect(tip({ rerun: "failed", retries: 1 })).not.toContain("1 times");
    expect(tip({ rerun: "failed", retries: 3 })).toContain("re-runs failed items by itself: up to 3 times");
  });
});
