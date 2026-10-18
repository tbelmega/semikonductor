// SPDX-License-Identifier: Apache-2.0
// What the agent is told when it is not its turn, or when the workflow
// changed under a running workstream: a step that was never handed out is
// handed out rather than finished, refusals of the owner's decisions name a
// command that works, and the hand-over block offers only what the step
// allows.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

const ONE = `version: 1
name: w
steps:
  - id: a
    instruction: Do a.
`;

test("continue on a step that was never handed out hands it out and does not finish it", () => {
  repo.start("w", ONE);
  repo.ok("continue", "w");
  // The workflow gains a step after the workstream finished its only one.
  repo.write("workflow-source.yml", `${ONE}  - id: b\n    instruction: Do b.\n`);
  const out = repo.refused("continue", "w");
  expect(out).toContain('step "b" had not been handed out, so this command did not finish it; it is handed out now. Do the step, then run continue again.');
  expect(out).toContain("STEP b (2 of 2): Do b.");
  expect(repo.status("w", "b")).toBe("IN_PROGRESS");
  expect(repo.ok("continue", "w")).toContain("workflow complete");
});

test("--blocked on a step that was never handed out is refused the same way", () => {
  repo.start("w", ONE);
  repo.ok("continue", "w");
  repo.write("workflow-source.yml", `${ONE}  - id: b\n    instruction: Do b.\n`);
  expect(repo.refused("continue", "w", "--blocked", "cannot do it")).toContain('step "b" had not been handed out');
  expect(repo.status("w", "b")).toBe("IN_PROGRESS");
});

test("continue after a pending condition is bound to skip its step hands out the next step and does not finish it", () => {
  repo.start(
    "s",
    `version: 1
name: s
steps:
  - id: conditional
    instruction: Do it if it applies.
    condition: "check: applies"
  - id: mandatory
    instruction: Do the mandatory work.
  - id: last
    instruction: Do the last work.
`,
  );
  expect(repo.status("s", "conditional")).toBe("PENDING");
  repo.write(".konductor/policy-overrides.yml", 'checks:\n  applies: "false"\n');
  const out = repo.refused("continue", "s");
  expect(out).toContain('step "mandatory" had not been handed out, so this command did not finish it');
  expect(out).toContain("STEP mandatory (2 of 3): Do the mandatory work.");
  expect(repo.status("s", "conditional")).toBe("SKIPPED");
  expect(repo.status("s", "mandatory")).toBe("IN_PROGRESS");
});

test("a decision for a step that this command's hand-out skipped is not applied to the next step", () => {
  repo.start("w", `${ONE}  - id: b\n    instruction: Do b.\n`);
  repo.ok("continue", "w");
  // A step the condition skips is inserted before the step in progress.
  repo.write("workflow-source.yml", `${ONE.replace("steps:\n", 'steps:\n  - id: new\n    instruction: Do new.\n    condition: { script: "false" }\n')}  - id: b\n    instruction: Do b.\n`);
  const out = repo.refused("continue", "w", "--skip", "the owner skips the new step");
  expect(out).toContain('step "new" is SKIPPED now, so this command did not apply its decision to it, nor to step "b"');
  expect(out).toContain("STEP b (3 of 3): Do b.");
  expect(repo.status("w", "b")).toBe("IN_PROGRESS");
});

const OWNED = `version: 1
name: owned
steps:
  - id: design
    instruction: Design it.
    gates:
      - owner-action: approve the design
  - id: build
    instruction: Build it.
    gates:
      - script: "false"
      - owner-action: approve the build
`;

test("a plain continue on a step that waits for the owner names the owner's commands that work", () => {
  repo.start("o", OWNED);
  repo.ok("continue", "o");
  const awaiting = repo.refused("continue", "o");
  expect(awaiting).toContain(
    'step "design" is AWAITING_OWNER; only the owner can move it on, with --owner-approved, --back-to, --skip or --forward-to. ' +
      "Run `fuse-flow start o` to print the hand-over block for the owner.",
  );
  repo.ok("continue", "o", "--owner-approved");
  repo.ok("continue", "o", "--blocked", "the build script fails");
  // The build step has no review, so --more-rounds is not offered.
  const blocked = repo.refused("continue", "o");
  expect(blocked).toContain('step "build" is BLOCKED; only the owner can move it on, with --owner-approved, --back-to, --skip or --forward-to.');
  expect(blocked).not.toContain("--more-rounds");
});

test("--more-rounds on a step that awaits the owner says why there are no rounds to grant", () => {
  repo.start("o", OWNED.replace("      - owner-action: approve the design\n", "      - agent: review the design\n      - owner-action: approve the design\n"));
  repo.ok("continue", "o");
  const out = repo.refused("continue", "o", "--more-rounds", "1");
  expect(out).toContain(
    'step "design" is AWAITING_OWNER: its reviews are done and it waits for the owner, so there are no review rounds to grant.',
  );
  expect(out).not.toContain("run the command again");
});

test("the hand-over at the first step offers to redo it, not to go back to an earlier step", () => {
  repo.start("o", OWNED);
  const out = repo.ok("continue", "o");
  expect(out).toContain("NEXT STEP:\n  - Approve the design.\n  - Send the work back to redo this step, with what to change.\n");
  repo.ok("continue", "o", "--owner-approved");
  expect(repo.ok("continue", "o", "--blocked", "the build script fails")).toContain("  - Send the work back to an earlier step, with what to change.\n");
});

test("a step awaiting the owner whose owner gate was removed from the workflow still names what the owner decides", () => {
  repo.start("o", OWNED);
  repo.ok("continue", "o");
  repo.write("workflow-source.yml", OWNED.replace("    gates:\n      - owner-action: approve the design\n", ""));
  const out = repo.ok("start", "o");
  expect(out).toContain("STATUS: awaiting owner action. The owner is asked to approve the step's work.");
  expect(out).toContain("  - Approve the step's work.\n");
  expect(out).not.toContain("asked to .");
});
