// SPDX-License-Identifier: Apache-2.0
// A check passes when its command exits 0, whatever it prints. A test runner
// behind a pipe or a wrapper script can report failing tests and still exit
// 0, so when the end of the output reads as failing tests, fuse-flow still
// passes the check but warns the agent and the owner.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Repo } from "./helpers";

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
      - owner-action: approve the build
`;

const bind = (command: string) => repo.write(".konductor/policy-overrides.yml", `checks:\n  default: ${JSON.stringify(command)}\n`);

test("a check that exits 0 but prints failing tests passes with a warning to the agent and the owner, and the owner can still approve", () => {
  const command = "echo 'Tests: 3 failed'; true";
  bind(command);
  repo.start("w", FLOW);
  const out = repo.ok("continue", "w");
  const label = `check default (\`${command}\`)`;
  const lines = out.split("\n");
  // The agent's warning comes right after the line that says what was recorded.
  expect(lines[0]).toBe("build: work recorded; the step awaits the owner's action");
  expect(lines[1]).toBe(
    `WARNING: ${label} exited 0, so fuse-flow took it as a pass, but its output reports failures: "Tests: 3 failed". ` +
      "Check that the command exits non-zero when a test fails, fix it or the tests, and tell the owner.",
  );
  // The verification entry stays the canonical one, so the owner's approval matches it.
  expect(lines).toContain(`- VERIFICATION: ${label}: passed`);
  expect(lines).toContain(`- WARNING: ${label} exited 0, but its output reports failures: "Tests: 3 failed"`);
  expect(repo.state("w").steps.build.verification).toEqual([`${label}: passed`, `WARNING: ${label} exited 0, but its output reports failures: "Tests: 3 failed"`]);
  // A resumed session sees the warning in the hand-over too.
  expect(repo.ok("start", "w").split("\n")).toContain(`- WARNING: ${label} exited 0, but its output reports failures: "Tests: 3 failed"`);
  expect(repo.ok("continue", "w", "--owner-approved", "--note", "approved")).toContain("build: owner approved; COMPLETED");
});

test("a check whose output reports no failure passes without a warning", () => {
  bind("echo 'Tests: 0 failed, 12 passed'");
  repo.start("w", FLOW);
  const out = repo.ok("continue", "w");
  expect(out).not.toContain("WARNING");
  expect(repo.state("w").steps.build.verification).toEqual(["check default (`echo 'Tests: 0 failed, 12 passed'`): passed"]);
});

test("an explicit zero count of failures in capitals is no failure", () => {
  for (const line of ["Tests: 0 FAILED, 12 PASSED", "0 FAIL, 3 PASS"]) {
    const r = new Repo();
    try {
      r.write(".konductor/policy-overrides.yml", `checks:\n  default: ${JSON.stringify(`echo '${line}'`)}\n`);
      r.start("w", FLOW);
      expect(r.ok("continue", "w")).not.toContain("WARNING");
    } finally {
      r.cleanup();
    }
  }
});

test("a FAIL marker of a test, and a non-zero count in capitals, still warn", () => {
  for (const line of ["FAIL test/a.test.ts > adds", "Tests: 2 FAILED, 10 PASSED"]) {
    const r = new Repo();
    try {
      r.write(".konductor/policy-overrides.yml", `checks:\n  default: ${JSON.stringify(`echo '${line}'`)}\n`);
      r.start("w", FLOW);
      expect(r.ok("continue", "w")).toContain(`its output reports failures: "${line}"`);
    } finally {
      r.cleanup();
    }
  }
});

test("a warning from a passing check is shown when a later gate refuses the step", () => {
  bind("echo 'Tests: 3 failed'; true");
  repo.start("w", FLOW.replace("      - check: default\n", "      - check: default\n      - script: \"false\"\n"));
  const out = repo.refused("continue", "w");
  expect(out).toContain("script `false` failed (exit 1)");
  expect(out).toContain(`WARNING: check default (\`echo 'Tests: 3 failed'; true\`) exited 0, so fuse-flow took it as a pass, but its output reports failures: "Tests: 3 failed".`);
});
