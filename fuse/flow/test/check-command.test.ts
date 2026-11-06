// SPDX-License-Identifier: Apache-2.0
// `fuse-flow check <slug>` runs the current step's checks the way continue
// does, so the agent sees only their result, the end of their output and the
// lines that read as failing tests, not the whole test output. It changes
// nothing in the workstream.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

const FLOW = `version: 1
name: w
steps:
  - id: build
    instruction: Build it.
    gates:
      - check: default
      - script: echo lint ok
`;

const bind = (command: string) => repo.write(".konductor/policy-overrides.yml", `checks:\n  default: ${JSON.stringify(command)}\n`);

test("a failing check is reported with its exit status, its tail and its failing lines, and the command exits non-zero", () => {
  const command = "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25; do echo noise $i; done; echo 'FAIL test/a.test.ts > adds'; echo 'Tests: 1 failed, 4 passed'; exit 1";
  bind(command);
  repo.start("w", FLOW);
  const before = repo.read(".konductor/workstreams/w.yml");
  const r = repo.run(["check", "w"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain(`CHECK check default (\`${command}\`): failed (exit 1)\n`);
  // Only the tail of the output, as continue keeps it.
  expect(r.out).not.toContain("noise 1\n");
  expect(r.out).toContain("    noise 25\n    FAIL test/a.test.ts > adds\n    Tests: 1 failed, 4 passed\n");
  expect(r.out).toContain("  failing: FAIL test/a.test.ts > adds; Tests: 1 failed, 4 passed\n");
  expect(r.out).toContain("CHECK script `echo lint ok`: passed (exit 0)\n");
  expect(r.out).toContain("1 of 2 checks of step build failed.");
  expect(repo.read(".konductor/workstreams/w.yml")).toBe(before);
});

test("passing checks exit 0, and a passing check that prints failures is flagged", () => {
  bind("echo 'Tests: 2 failed'; true");
  repo.start("w", FLOW);
  const r = repo.run(["check", "w"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain("CHECK check default (`echo 'Tests: 2 failed'; true`): passed (exit 0), but its output reports failures\n");
  expect(r.out).toContain("All 2 checks of step build passed.");
});

test("a passing check shows the end of its output, such as the test summary", () => {
  bind("echo 'Tests: 12 passed'");
  repo.start("w", FLOW);
  const out = repo.ok("check", "w");
  expect(out).toContain("CHECK check default (`echo 'Tests: 12 passed'`): passed (exit 0)\n    Tests: 12 passed\n");
  expect(out).toContain("CHECK script `echo lint ok`: passed (exit 0)\n    lint ok\n");
  expect(out).not.toContain("failing:");
});

test("check leaves a state file in an earlier fuse-flow's format exactly as it was", () => {
  bind("true");
  repo.start("w", FLOW);
  repo.write("a.txt");
  // As an earlier fuse-flow left it: a bare `updated` list, and work handed
  // to the owner without the reviews it passed.
  const old = repo.state("w");
  old.steps.build = {
    status: "IN_PROGRESS",
    artifacts: [{ artifact: "code", path: "a.txt", status: "draft" }],
    updated: ["a.txt"],
    history: ["2026-10-16T10:00:00.000Z handed out"],
  };
  repo.write(".konductor/workstreams/w.yml", JSON.stringify(old));
  const before = repo.read(".konductor/workstreams/w.yml");
  expect(repo.ok("check", "w")).toContain("All 2 checks of step build passed.");
  expect(repo.read(".konductor/workstreams/w.yml")).toBe(before);
});

test("a workstream closed while a check runs runs no further check", () => {
  const cli = join(FLOW_DIR, "src", "cli.ts");
  repo.start(
    "w",
    `version: 1
name: w
steps:
  - id: build
    instruction: Build it.
    gates:
      - script: ${JSON.stringify(`${process.execPath} run ${cli} close w --note "given up"`)}
      - script: touch second-ran
`,
  );
  const r = repo.run(["check", "w"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("closed");
  expect(existsSync(join(repo.root, "second-ran"))).toBe(false);
});

test("an unbound check is not run and counts as failed; a step without checks has nothing to run", () => {
  repo.start("w", FLOW);
  const r = repo.run(["check", "w"]);
  expect(r.code).toBe(1);
  expect(r.out).toContain("CHECK check default: not run, no command is bound. This project has no command for the default check yet.");
  const plain = new Repo();
  try {
    plain.start("p", "version: 1\nname: p\nsteps:\n  - id: a\n    instruction: Do a.\n");
    expect(plain.ok("check", "p")).toContain("Step a has no checks to run.");
  } finally {
    plain.cleanup();
  }
});
