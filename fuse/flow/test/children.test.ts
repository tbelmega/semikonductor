// SPDX-License-Identifier: Apache-2.0
// A child workstream and the parent step that delegated to it, once the two
// drift apart: the owner skipped, completed or sent back the parent step, or
// the child cannot be created at all.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write(
    ".konductor/workflows/child.yml",
    `version: 1
name: child
inputs:
  - artifact: given-diff
    required: true
steps:
  - id: review
    instruction: Review the diff.
    consumes: [given-diff]
`,
  );
});
afterEach(() => repo.cleanup());

const PARENT = `version: 1
name: parent
steps:
  - id: intake
    instruction: Write the diff.
    produces: { artifact: diff, path: "diffs/{slug}.diff" }
  - id: adversarial
    instruction: Merge the findings.
    gates:
      - workflow: child
        slug: "{slug}-adv"
        inputs: { given-diff: diff }
  - id: summary
    instruction: Summarize.
`;

function toDelegation(): void {
  repo.start("pr", PARENT);
  repo.write("diffs/pr.diff");
  repo.ok("continue", "pr");
}

test("a child whose parent step was skipped is not told that the step still waits for it", () => {
  toDelegation();
  repo.ok("start", "pr-adv");
  repo.ok("continue", "pr", "--skip", "the owner reviewed it by hand");
  const why = "step adversarial was skipped (the owner reviewed it by hand)";
  const done = repo.ok("continue", "pr-adv");
  expect(done).toContain(`  - Step adversarial of workstream pr no longer waits for this workstream: ${why}.`);
  expect(done).not.toContain("Go on there");
  expect(repo.ok("start", "pr-adv")).toContain(`parent:   step adversarial of workstream pr, which no longer waits for this one: ${why}\n`);
  expect(repo.ok("status", "pr-adv")).toContain(`  child of: step adversarial of workstream pr, which no longer waits for it: ${why}\n`);
});

test("a child whose parent step was sent back is told which workstream the new pass waits for", () => {
  toDelegation();
  repo.ok("start", "pr-adv");
  repo.ok("continue", "pr", "--back-to", "intake", "--note", "redo the diff");
  const done = repo.ok("continue", "pr-adv");
  expect(done).toContain(
    "  - Step adversarial of workstream pr no longer waits for this workstream: the owner sent the work back, and the step's new pass waits for workstream pr-adv-2.",
  );
});

test("while the parent step waits for it, the child is still sent back there", () => {
  toDelegation();
  repo.ok("start", "pr-adv");
  expect(repo.ok("continue", "pr-adv")).toContain("  - Step adversarial of workstream pr waits for this workstream. Go on there:");
});

test("continue on a step whose child cannot be created says so, and does not tell the agent to start the child", () => {
  repo.start("pr", PARENT);
  const created = repo.ok("continue", "pr", "--not-produced", "diff", "no change to diff");
  expect(created).toContain("STEP adversarial (2 of 3) waits for a child workstream that cannot be created");
  const out = repo.refused("continue", "pr");
  expect(out).toContain(
    "workstream pr-adv, which this step waits for, cannot be created: step adversarial cannot create its child workstream pr-adv: child requires given-diff",
  );
  expect(out).toContain('If you cannot resolve this, report the step blocked: run `fuse-flow continue pr --blocked "<the reason above>"`, so the owner decides.');
  expect(out).not.toContain("Run it to its end with `fuse-flow start pr-adv`");
});

test("status names the child of the step's current pass, also when it cannot be created", () => {
  toDelegation();
  repo.ok("start", "pr-adv");
  repo.ok("continue", "pr", "--back-to", "intake");
  repo.ok("continue", "pr", "--not-produced", "diff", "nothing left to diff");
  const status = repo.ok("status", "pr");
  expect(status).toContain("waits for workstream pr-adv-2, which does not exist; earlier child workstream pr-adv");
});

test("the owner's approval of a delegating step is refused while its child has become unfinished", () => {
  const helper = "version: 1\nname: helper\nsteps:\n  - id: work\n    instruction: Do the child's work.\n";
  repo.write(".konductor/workflows/helper.yml", helper);
  repo.start(
    "p",
    "version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Use the child's work.\n    gates:\n      - workflow: helper\n      - owner-action: approve the work\n  - id: next\n    instruction: Do the next work.\n",
  );
  repo.ok("start", "p-delegate");
  repo.ok("continue", "p-delegate");
  repo.ok("continue", "p");
  expect(repo.status("p", "delegate")).toBe("AWAITING_OWNER");
  // The child's workflow gains a step, so the child is no longer complete.
  repo.write(".konductor/workflows/helper.yml", `${helper}  - id: required\n    instruction: Verify the work.\n`);
  const out = repo.refused("continue", "p", "--owner-approved");
  expect(out).toContain("step delegate cannot complete yet: workstream p-delegate");
  expect(out).toContain('To go on without it, the owner skips the step: `fuse-flow continue p --skip "<the owner\'s reason>"`');
  expect(repo.status("p", "delegate")).toBe("AWAITING_OWNER");
});

test("the hand-over of a step awaiting the owner does not offer approval while its child has become unfinished", () => {
  const helper = "version: 1\nname: helper\nsteps:\n  - id: work\n    instruction: Do the child's work.\n";
  repo.write(".konductor/workflows/helper.yml", helper);
  repo.start(
    "p",
    "version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Use the child's work.\n    gates:\n      - workflow: helper\n      - owner-action: approve the work\n  - id: next\n    instruction: Do the next work.\n",
  );
  repo.ok("start", "p-delegate");
  repo.ok("continue", "p-delegate");
  repo.ok("continue", "p");
  repo.write(".konductor/workflows/helper.yml", `${helper}  - id: required\n    instruction: Verify the work.\n`);
  const out = repo.ok("start", "p");
  const why = "workstream p-delegate, which this step waits for, is at step required (2 of 2), not handed out yet";
  expect(out).toContain(`STATUS: awaiting owner action. The owner is asked to approve the work. It cannot be approved yet: ${why}.\n`);
  expect(out).toContain(`VERIFICATION: workstream p-delegate (helper): complete when the step's work was recorded; now ${why}\n`);
  expect(out).toContain(
    "NEXT STEP:\n  - Finish workstream p-delegate first, then approve the work.\n  - Skip this step, without what workstream p-delegate would return.\n" +
      "  - Send the work back to redo this step, with what to change.\n",
  );
  expect(out).not.toContain("--owner-approved");
  expect(out).toContain(
    "  - The owner has workstream p-delegate finished first: run `fuse-flow start p-delegate`, which prints its current step, and run it to its end; " +
      "then run `fuse-flow start p` for the owner's approval.\n",
  );
  expect(out).toContain('  - The owner skips the step: run `fuse-flow continue p --skip "<the owner\'s reason>"`.\n');
  // Once the child is complete again, the owner can approve.
  repo.ok("start", "p-delegate");
  repo.ok("continue", "p-delegate");
  expect(repo.ok("start", "p")).toContain("--owner-approved");
  repo.ok("continue", "p", "--owner-approved");
});

test("a child resumed after the owner reviewed its parent does not ask for its decisions again", () => {
  repo.write(".konductor/workflows/helper.yml", "version: 1\nname: helper\nsteps:\n  - id: work\n    instruction: Do the child's work.\n");
  repo.start("p", "version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Use the child's work.\n    gates:\n      - workflow: helper\n      - owner-action: approve the work\n");
  repo.ok("start", "p-delegate");
  expect(repo.ok("continue", "p-delegate")).toContain("DECISIONS: ");
  expect(repo.ok("continue", "p")).toContain("workstream p-delegate, delegated by step delegate");
  expect(repo.ok("continue", "p", "--owner-approved", "--note", "both sets of decisions reviewed")).not.toContain("DECISIONS: ");
  expect(repo.ok("start", "p-delegate")).not.toContain("DECISIONS: ");
});

test("a recorded child that follows another workflow than the edited gate is replaced by sending the step back", () => {
  repo.write(".konductor/workflows/child-a.yml", "version: 1\nname: child-a\nsteps:\n  - id: a\n    instruction: Original child.\n");
  repo.write(".konductor/workflows/child-b.yml", "version: 1\nname: child-b\nsteps:\n  - id: b\n    instruction: Replacement child.\n");
  const P = "version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Run the child.\n    gates:\n      - workflow: child-a\n";
  repo.start("p", P);
  repo.write("workflow-source.yml", P.replace("child-a", "child-b"));
  const out = repo.ok("start", "p");
  expect(out).toContain(
    "step delegate waits for a child workstream p-delegate that follows child-b, but workstream p-delegate was created for this pass of the step " +
      "and follows child-a. To give the step a new child that follows child-b, the owner sends the work back to it: " +
      "`fuse-flow continue p --back-to delegate`; or change the gate back to child-a",
  );
  expect(out).not.toContain("give the gate a slug of its own");
  const refused = repo.refused("continue", "p");
  // The DELEGATE line agrees with the refusal above it, without repeating it.
  expect(refused).toContain("DELEGATE: this step waits for workstream p-delegate, which cannot be used, for the reason above.");
  expect(refused).not.toContain("follows workflow child-b and was created for it");
  const back = repo.ok("continue", "p", "--back-to", "delegate");
  expect(back).toContain("DELEGATE: this step waits for workstream p-delegate-2, which follows workflow child-b and was created for it.");
});

test("a step whose child cannot be created does not say fuse-flow creates it when start prints the step", () => {
  repo.start("pr", PARENT);
  repo.ok("continue", "pr", "--not-produced", "diff", "no change to diff");
  const out = repo.refused("continue", "pr");
  expect(out).toContain("DELEGATE: this step waits for workstream pr-adv, which follows workflow child. It does not exist, and fuse-flow cannot create it");
  expect(out).not.toContain("fuse-flow creates it when it prints this step");
  // The refusal above already gives the reason, and the child cannot be
  // completed while it cannot be created.
  expect(out.split("child requires given-diff").length - 1).toBe(1);
  expect(out).toContain("DELEGATE: this step waits for workstream pr-adv, which follows workflow child. It does not exist, and fuse-flow cannot create it, for the reason above.\n");
  expect(out).not.toContain("Make sure workstream pr-adv is complete");
  expect(out).toContain(
    "  1. Workstream pr-adv cannot be created, so this step cannot complete until that is resolved. If you cannot resolve it, " +
      'report the step blocked: run `fuse-flow continue pr --blocked "<the reason>"`, so the owner decides.\n',
  );
});

test("a refusal because the recorded child cannot be used gives the reason once", () => {
  repo.write(".konductor/workflows/child-a.yml", "version: 1\nname: child-a\nsteps:\n  - id: a\n    instruction: Original child.\n");
  repo.write(".konductor/workflows/child-b.yml", "version: 1\nname: child-b\nsteps:\n  - id: b\n    instruction: Replacement child.\n");
  const P = "version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Run the child.\n    gates:\n      - workflow: child-a\n";
  repo.start("p", P);
  repo.write("workflow-source.yml", P.replace("child-a", "child-b"));
  const out = repo.refused("continue", "p");
  expect(out.split("created for this pass of the step and follows child-a").length - 1).toBe(1);
  expect(out).toContain("DELEGATE: this step waits for workstream p-delegate, which cannot be used, for the reason above.\n");
  expect(out).toContain("  1. Workstream p-delegate cannot be used, so this step cannot complete until that is resolved.");
  expect(repo.ok("start", "p")).toContain("STEP delegate (1 of 1) waits for a child workstream that cannot be used: step delegate waits for");
});

const AWAITING_P = (gate: string) =>
  `version: 1\nname: p\nsteps:\n  - id: delegate\n    instruction: Use the child's work.\n    gates:\n      - workflow: ${gate}\n      - owner-action: approve the work\n  - id: next\n    instruction: Do the next work.\n`;

function toAwaitingApproval(): void {
  repo.write(".konductor/workflows/child-a.yml", "version: 1\nname: child-a\nsteps:\n  - id: a\n    instruction: Original child.\n");
  repo.write(".konductor/workflows/child-b.yml", "version: 1\nname: child-b\nsteps:\n  - id: b\n    instruction: Replacement child.\n");
  repo.start("p", AWAITING_P("child-a"));
  repo.ok("start", "p-delegate");
  repo.ok("continue", "p-delegate");
  repo.ok("continue", "p");
  expect(repo.status("p", "delegate")).toBe("AWAITING_OWNER");
}

test("the hand-over of a step awaiting the owner does not offer finishing a child that follows another workflow than the gate", () => {
  toAwaitingApproval();
  repo.write("workflow-source.yml", AWAITING_P("child-b"));
  const out = repo.ok("start", "p");
  expect(out).toContain("It cannot be approved yet: step delegate waits for a child workstream p-delegate that follows child-b");
  expect(out).not.toContain("Finish workstream p-delegate first");
  expect(out).not.toContain("run `fuse-flow start p-delegate`");
  expect(out).toContain(
    "NEXT STEP:\n  - Correct what holds the approval back, as the status says, then approve the work.\n" +
      "  - Skip this step, without what workstream p-delegate would return.\n" +
      "  - Send the work back to redo this step, with what to change.\n",
  );
  expect(out).toContain(
    "  - The owner has what holds the approval back corrected: do what the status above says, then run `fuse-flow start p` for the owner's approval.\n",
  );
  // The recovery the status names works.
  expect(repo.ok("continue", "p", "--back-to", "delegate")).toContain("DELEGATE: this step waits for workstream p-delegate-2, which follows workflow child-b");
});

test("the hand-over of a step awaiting the owner does not offer finishing a recorded child whose state file is gone", () => {
  toAwaitingApproval();
  repo.cleanupPath(".konductor/workstreams/p-delegate.yml");
  const out = repo.ok("start", "p");
  expect(out).toContain("It cannot be approved yet: workstream p-delegate, which this step waits for, does not exist.");
  expect(out).not.toContain("Finish workstream p-delegate first");
  expect(out).not.toContain("run `fuse-flow start p-delegate`");
  expect(out).toContain(
    "NEXT STEP:\n  - Restore workstream p-delegate, or send the work back to this step for a new child workstream, then approve the work.\n" +
      "  - Skip this step, without what workstream p-delegate would return.\n",
  );
  expect(out).toContain(
    "  - The owner has workstream p-delegate restored: restore `.konductor/workstreams/p-delegate.yml` from version control or a backup, " +
      "then run `fuse-flow start p` for the owner's approval.\n",
  );
  // The other recovery, a new pass, creates a new child.
  expect(repo.ok("continue", "p", "--back-to", "delegate")).toContain("DELEGATE: this step waits for workstream p-delegate-2");
});
