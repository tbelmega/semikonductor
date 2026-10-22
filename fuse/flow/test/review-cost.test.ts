// SPDX-License-Identifier: Apache-2.0
// What a review has cost: the reviewer launches over every pass of a step,
// several reviewers in one round, and rounds the owner grants to one review.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

const ONE_REVIEW = `version: 1
name: one
steps:
  - id: spec
    instruction: Write the spec.
    produces:
      - artifact: paper
        path: spec.md
    gates:
      - agent: review the spec
      - owner-action: approve the spec
`;

const TWO_REVIEWS = `version: 1
name: two
steps:
  - id: build
    instruction: Build it.
    produces:
      - artifact: paper
        path: build.md
    gates:
      - agent: review the build
      - agent: review the docs
`;

test("the launches of a review are counted over every pass, with several reviewers in one round counted as one round", () => {
  repo.start("feat", ONE_REVIEW);
  repo.write("spec.md");
  // Before any reviewer ran, nothing is counted.
  expect(repo.ok("status", "feat")).toContain("agent(review the spec) [cap 2], owner-action");

  // Round 1 had two reviewers, each with its own file; round 2 one.
  repo.write(".konductor/reviews/feat/spec-round-1.gpt-6.1-sol.json", '{"findings": []}\n');
  repo.write(".konductor/reviews/feat/spec-round-1.claude-opus-5.5.json", '{"findings": []}\n');
  repo.reviewed("feat", "spec", 2);
  expect(repo.ok("status", "feat")).toContain("agent(review the spec) [cap 2; 3 reviewer launches in 2 rounds]");
  const waiting = repo.ok("continue", "feat");
  expect(waiting).toContain("so far 3 reviewer launches in 2 rounds\n");

  // The owner sends the work back: the new pass counts its rounds afresh
  // against the cap, and the total still shows the earlier pass.
  const back = repo.ok("continue", "feat", "--back-to", "spec", "--note", "cover the error cases");
  expect(back).toContain("So far this review has had 3 reviewer launches in 2 rounds, counted from the findings files in .konductor/reviews/feat/.");
  repo.reviewed("feat", "spec-pass-2");
  expect(repo.ok("status", "feat")).toContain("[cap 2; 4 reviewer launches in 3 rounds over 2 passes]");
  expect(repo.ok("continue", "feat")).toContain("of 2 rounds, <any required fix still open, and any fix made after the last review, which no reviewer has seen>; so far 4 reviewer launches in 3 rounds over 2 passes");
});

test("a findings file with a reviewer's name counts as the review having run, whatever the name", () => {
  repo.start("feat", ONE_REVIEW);
  repo.write("spec.md");
  expect(repo.refused("continue", "feat")).toContain("reviewer has written");
  // A name joined by a hyphen is not a reviewer's name, and an empty one is none.
  repo.write(".konductor/reviews/feat/spec-round-1-sol.json", "{}\n");
  repo.write(".konductor/reviews/feat/spec-round-1..json", "{}\n");
  expect(repo.refused("continue", "feat")).toContain("reviewer has written");
  repo.write(".konductor/reviews/feat/spec-round-1.6.1-Sol--x.json", "{}\n");
  expect(repo.ok("continue", "feat")).toContain("STATUS: awaiting owner action");
});

test("files carry their review by name: a redo counts for its review, and a name no review has now is shown apart", () => {
  const wf = repo.write("wf.yml", ONE_REVIEW);
  repo.ok("start", "feat", "--workflow", wf);
  repo.write("spec.md");
  repo.reviewed("feat", "spec");
  // A review run again after the owner's acceptance was taken back writes under -redo.
  repo.reviewed("feat", "spec-redo");
  expect(repo.ok("status", "feat")).toContain("agent(review the spec) [cap 2; 2 reviewer launches in 2 rounds]");

  // An edit that adds a review renames the files: the earlier ones carry no review's name now.
  const two = ONE_REVIEW.replace("      - agent: review the spec\n", "      - agent: review the spec\n      - agent: review the wording\n");
  repo.write("wf.yml", two);
  const apart =
    "2 launches of this step that cannot be given to one of its reviews as the workflow names them now, since an edit added or removed a review";
  expect(repo.ok("status", "feat")).toContain(`agent(review the spec) [cap 2; ${apart}], agent(review the wording) [cap 2; ${apart}]`);
  repo.reviewed("feat", "spec-gate1");
  expect(repo.ok("status", "feat")).toContain(`agent(review the spec) [cap 2; 1 reviewer launch in 1 round, and ${apart}]`);

  // Back to one review, the files without a number are the review's again.
  repo.write("wf.yml", ONE_REVIEW);
  expect(repo.ok("status", "feat")).toContain(
    "agent(review the spec) [cap 2; 2 reviewer launches in 2 rounds, and 1 launch of this step that cannot be given",
  );
});

test("a step whose id ends in -redo counts its own files and its redo files for its review", () => {
  repo.start("feat", ONE_REVIEW.replace("  - id: spec\n", "  - id: spec-redo\n"));
  repo.write("spec.md");
  repo.reviewed("feat", "spec-redo");
  repo.reviewed("feat", "spec-redo-redo");
  expect(repo.ok("status", "feat")).toContain("agent(review the spec) [cap 2; 2 reviewer launches in 2 rounds]");
});

test("a workflow whose step id is another's followed by part of a findings name is refused", () => {
  for (const suffix of ["gate1", "redo", "pass-2", "round-1", "gate12-x"]) {
    const wf = `version: 1\nname: lookalike\nsteps:\n  - id: spec\n    instruction: One.\n  - id: spec-${suffix}\n    instruction: Two.\n`;
    expect(repo.refused("validate", repo.write("wf.yml", wf))).toContain(
      `step id "spec-${suffix}" is "spec" followed by a part of a findings file's name, so the two steps' review findings would share names`,
    );
  }
  // Ids that only look alike are fine.
  const fine = "version: 1\nname: alike\nsteps:\n  - id: spec\n    instruction: One.\n  - id: spec-gate1x\n    instruction: Two.\n  - id: spec-review\n    instruction: Three.\n";
  repo.ok("validate", repo.write("wf.yml", fine));
});

test("an accepted or waived review still shows what it cost, in the step block and the hand-over", () => {
  repo.start("feat", TWO_REVIEWS);
  repo.write("build.md");
  repo.reviewed("feat", "build-gate1");
  repo.reviewed("feat", "build-gate1", 2);
  repo.ok("continue", "feat", "--blocked", "the build review does not converge", "--gate", "1");
  const accepted = repo.ok("continue", "feat", "--owner-approved", "--gate", "1", "--note", "good enough");
  expect(accepted).toContain("1. The owner accepted this review (review the build) as it was; do not run it again. So far it has had 2 reviewer launches in 2 rounds.");
  const done = repo.ok("continue", "feat", "--waived", "the docs were reviewed by hand");
  expect(done).toContain(
    "build: review (review the build): accepted by the owner as it was; so far 2 reviewer launches in 2 rounds; build: review (review the docs): waived by the owner: the docs were reviewed by hand",
  );
});

test("the owner can grant rounds to one review alone; without --gate every review gets them, and the output says so", () => {
  repo.start("feat", TWO_REVIEWS);
  repo.write("build.md");

  const one = repo.ok("continue", "feat", "--more-rounds", "2", "--gate", "2", "--note", "the docs are long");
  expect(one).toStartWith("build: owner granted 2 more review rounds to review 2 (review the docs); the step is IN_PROGRESS\n");
  expect(one).toContain("After 2 such rounds");
  expect(one).toContain("After 4 (2 plus 2 granted by the owner) such rounds");
  expect(repo.ok("status", "feat")).toContain("agent(review the build) [cap 2], agent(review the docs) [cap 4, 2 plus 2 granted]");
  expect(repo.state("feat").steps.build.history.at(-1)).toEndWith("owner granted 2 more review rounds to review 2: the docs are long");

  const all = repo.ok("continue", "feat", "--more-rounds", "1");
  expect(all).toStartWith("build: owner granted 1 more review round to each of its 2 reviews; --gate <n> grants them to one review only; the step is IN_PROGRESS\n");
  expect(repo.ok("status", "feat")).toContain("agent(review the build) [cap 3, 2 plus 1 granted], agent(review the docs) [cap 5, 2 plus 3 granted]");

  // A gate that is not a review, or does not exist, is refused.
  expect(repo.refused("continue", "feat", "--more-rounds", "1", "--gate", "3")).toContain(
    'gate 3 of step "build" is not a review; --more-rounds --gate takes a review\'s number: 1, 2',
  );

  // A send-back starts the next pass without the grants.
  repo.ok("continue", "feat", "--back-to", "build");
  expect(repo.ok("status", "feat")).toContain("agent(review the build) [cap 2], agent(review the docs) [cap 2]");
});

test("a step blocked at one review takes rounds for that review, and the hand-over names it", () => {
  repo.start("feat", TWO_REVIEWS);
  repo.write("build.md");
  const blocked = repo.ok("continue", "feat", "--blocked", "the docs review keeps finding gaps", "--gate", "2");
  expect(blocked).toContain("  - Allow more review rounds for review 2, and how many; answer the review's open questions in your note.");
  expect(blocked).toContain('  - The owner grants more review rounds: run `fuse-flow continue feat --more-rounds <n> --gate 2 --note "<the owner\'s decision>"`.');

  expect(repo.refused("continue", "feat", "--more-rounds", "1", "--gate", "1")).toContain(
    'step "build" is blocked at review 2, so rounds granted to review 1 alone would not unblock it; grant them with --gate 2, or without --gate to every review of the step',
  );
  expect(repo.status("feat", "build")).toBe("BLOCKED");
  repo.ok("continue", "feat", "--more-rounds", "1", "--gate", "2");
  expect(repo.status("feat", "build")).toBe("IN_PROGRESS");
  expect(repo.ok("status", "feat")).toContain("agent(review the build) [cap 2], agent(review the docs) [cap 3, 2 plus 1 granted]");
});

test("a step with one review names no gate in its grant, and --gate goes with --more-rounds", () => {
  repo.start("feat", ONE_REVIEW);
  repo.write("spec.md");
  const blocked = repo.ok("continue", "feat", "--blocked", "stuck", "--gate", "1");
  expect(blocked).toContain("  - Allow more review rounds, and how many; answer the review's open questions in your note.");
  expect(blocked).toContain('run `fuse-flow continue feat --more-rounds <n> --note "<the owner\'s decision>"`');
  expect(repo.ok("continue", "feat", "--more-rounds", "1")).toStartWith("spec: owner granted 1 more review round; the step is IN_PROGRESS\n");
  expect(repo.usage("continue", "feat", "--gate", "1")).toContain("--gate goes with --blocked, --owner-approved or --more-rounds");
});
