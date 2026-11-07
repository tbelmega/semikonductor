// SPDX-License-Identifier: Apache-2.0
// Every step block is resent with each later model call of the session, so
// its size is a cost on every call. This budget makes growth a decision: a
// change that pushes the design step's block of the feature workflow past it
// fails here, and either trims text elsewhere or raises the budget on purpose.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { FLOW_DIR, Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

// About 10% above the block's size when the budget was last raised (7,602 bytes), when the
// design step took on the research of each system the feature calls.
const DESIGN_BLOCK_BUDGET = 8_400;

test("the design step block of the feature workflow, with one review gate, stays within its byte budget", () => {
  repo.write(".konductor/policy-overrides.local.yml", 'checks:\n  default: "true"\n');
  const intake = repo.ok("start", "feat", "--workflow", "fuse-feature-development");
  const spec = /PRODUCE (docs\/specs\/\S+\.md) \(feature-spec\)/.exec(intake)![1];
  repo.write(spec, "draft\n");
  const out = repo.ok("continue", "feat");
  // The block alone, with the paths that depend on where the checkout and the test run are cut short.
  const block = out
    .slice(out.indexOf("STEP design"))
    .replaceAll(FLOW_DIR, "<flow>")
    .replaceAll(repo.root, "<root>");
  expect(block).toContain("WHEN THE WORK IS DONE:");
  expect(Buffer.byteLength(block)).toBeLessThanOrEqual(DESIGN_BLOCK_BUDGET);
});
