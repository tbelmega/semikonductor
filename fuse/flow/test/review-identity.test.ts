// SPDX-License-Identifier: Apache-2.0
// What an owner's acceptance of a review, a block at a review and the work
// handed to the owner mean after the workflow, a guide or the policy is edited
// under a running workstream. Each is bound to the review's whole identity as
// it was recorded: its number, its text, and each guide with the artifact it
// applies to and the guide's content.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

// One step with one review of notes.md, then the owner's approval. `guide`
// adds a guide line to the review.
const ONE_REVIEW = (review: string, guide?: string) => `version: 1
name: w
steps:
  - id: s
    instruction: Write the notes.
    produces:
      - artifact: notes
        path: notes.md
    gates:
      - agent: ${JSON.stringify(review)}
${guide ? `        guide: ${guide}\n` : ""}      - owner-action: approve the notes
  - id: release
    instruction: Release it.
`;

let r: Repo;
beforeEach(() => (r = new Repo()));
afterEach(() => r.cleanup());

// Start `yaml`, write the notes, block at review 1 and have the owner accept it.
function acceptReview(yaml: string, note?: string): void {
  r.start("feat", yaml);
  r.write("notes.md");
  r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
  r.ok("continue", "feat", "--owner-approved", "--gate", "1", ...(note ? ["--note", note] : []));
}

test("an acceptance is taken back when an edit shortens a review's text to a prefix that looks like the acceptance line", () => {
  acceptReview(ONE_REVIEW("review security) as it is: check privacy"), "approved");
  r.write("workflow-source.yml", ONE_REVIEW("review security"));
  const resumed = r.ok("start", "feat");
  expect(resumed).not.toContain("The owner accepted this review");
  expect(resumed).toContain("TAKEN BACK: the owner accepted review 1 (review security) as it is: check privacy) as it was");
  expect(resumed).toContain("  1. Have an independent agent review security.");
});

test("an acceptance is taken back when an edit removes the review's guide", () => {
  r.write("old.md", "# Check only the spelling\n");
  acceptReview(ONE_REVIEW("inspect the notes", "old.md"));
  r.write("workflow-source.yml", ONE_REVIEW("inspect the notes"));
  const resumed = r.ok("start", "feat");
  expect(resumed).not.toContain("The owner accepted this review");
  expect(resumed).toContain("TAKEN BACK: the owner accepted review 1 (inspect the notes) following old.md for notes as it was");
  expect(resumed).toContain("  1. Have an independent agent inspect the notes. It reviews notes.md.");
});

test("an acceptance is taken back when an edit swaps which guide applies to which artifact", () => {
  const TWO = `version: 1
name: w
steps:
  - id: s
    instruction: Write both documents.
    produces:
      - artifact: one
        path: one.md
      - artifact: two
        path: two.md
    gates:
      - agent: inspect the documents
      - owner-action: approve the documents
`;
  r.write("one-guide.md", "# Check the spelling\n");
  r.write("two-guide.md", "# Check the authorization boundaries\n");
  r.write(".konductor/library/artifacts/one/guide.md", "# one\n");
  r.write(".konductor/library/artifacts/two/guide.md", "# two\n");
  const link = (id: string, guide: string) => {
    const at = join(r.root, `.konductor/library/artifacts/${id}/review.md`);
    rmSync(at, { force: true });
    symlinkSync(`../../../../${guide}`, at);
  };
  link("one", "one-guide.md");
  link("two", "two-guide.md");
  r.start("feat", TWO);
  r.write("one.md");
  r.write("two.md");
  r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
  r.ok("continue", "feat", "--owner-approved", "--gate", "1");
  link("one", "two-guide.md");
  link("two", "one-guide.md");
  const resumed = r.ok("start", "feat");
  expect(resumed).not.toContain("The owner accepted this review");
  expect(resumed).toContain("TAKEN BACK: the owner accepted review 1 (inspect the documents) following one-guide.md for one, two-guide.md for two as it was");
  expect(resumed).toContain("It reviews one.md against two-guide.md; two.md against one-guide.md.");
});

test("the owner's note on an accepted review is read whole after an edit changes the review's text", () => {
  const text = "review the patch (security) as it is: check input validation";
  acceptReview(ONE_REVIEW(text), "approved");
  r.write("workflow-source.yml", ONE_REVIEW(`${text} and data retention`));
  const resumed = r.ok("start", "feat");
  expect(resumed).toContain('OWNER SAID: "approved"\n');
  expect(resumed).not.toContain('OWNER SAID: "check input validation');
});

test("an acceptance without a note gives no owner's note, after an edit or a removal of the review", () => {
  const text = "review the patch (security) as it is: check input validation";
  acceptReview(ONE_REVIEW(text));
  r.write("workflow-source.yml", ONE_REVIEW(`${text} and data retention`));
  expect(r.ok("start", "feat")).not.toContain("OWNER SAID");
  r.write("workflow-source.yml", ONE_REVIEW(text).replace(/ {6}- agent: .*\n/, ""));
  expect(r.ok("start", "feat")).not.toContain("OWNER SAID");
});

test("a review whose acceptance was taken back counts its rounds afresh, in findings files of its own", () => {
  r.write("old.md", "# Check only the spelling\n");
  acceptReview(ONE_REVIEW("inspect the notes", "old.md"));
  expect(r.ok("start", "feat")).not.toContain("redo");
  r.write("old.md", "# Check the authorization boundaries\n");
  const resumed = r.ok("start", "feat");
  expect(resumed).toContain("its rounds count afresh");
  expect(resumed).toContain("The reviewer writes its findings to .konductor/reviews/feat/s-redo-round-<n>.json");
  expect(resumed).not.toContain("s-round-<n>.json");
  // The hand-over asks for the rounds of the review that ran.
  expect(r.ok("continue", "feat")).toContain("review (inspect the notes): <rounds used> of 2 rounds, ");
});

test("removing an accepted review says it is gone, and the hand-over still says the acceptance was taken back", () => {
  r.write("old.md", "# Check only the spelling\n");
  acceptReview(ONE_REVIEW("inspect the notes", "old.md"));
  r.write("workflow-source.yml", ONE_REVIEW("inspect the notes").replace(/ {6}- agent: .*\n/, ""));
  const resumed = r.ok("start", "feat");
  expect(resumed).toContain(
    "TAKEN BACK: the owner accepted review 1 (inspect the notes) following old.md for notes as it was, but an edit has " +
      "removed that review or moved it to another number, so the acceptance no longer holds.",
  );
  expect(resumed).not.toContain("runs again");
  const handOver = r.ok("continue", "feat");
  expect(handOver).toContain(
    "VERIFICATION: review 1 (inspect the notes) following old.md for notes: the owner's acceptance was taken back, since an " +
      "edit removed that review or moved it to another number",
  );
});

// A step that waits only for the owner.
const OWNER_ONLY = (gates = "") => `version: 1
name: w
steps:
  - id: work
    instruction: Do the work.
    gates:
${gates}      - owner-action: approve the work
  - id: finish
    instruction: Finish.
`;

test("a gate added while the step awaits the owner holds the approval back until the step runs it", () => {
  r.start("feat", OWNER_ONLY());
  r.ok("continue", "feat");
  r.write("workflow-source.yml", OWNER_ONLY("      - agent: review authorization boundaries\n"));
  const handOver = r.ok("start", "feat");
  expect(handOver).toContain(
    "An edit of the workflow added or changed gates after the work was recorded, and they have not run on it: " +
      "review (review authorization boundaries). It cannot be approved until they have run.",
  );
  expect(handOver).toContain("  - Redo this step, so that the gates that have not run on its work run: review (review authorization boundaries).\n");
  expect(handOver).not.toContain("--owner-approved");
  expect(handOver).toContain('run `fuse-flow continue feat --back-to work --note "<the owner\'s decision>"`');
  expect(r.refused("continue", "feat", "--owner-approved")).toContain(
    "step work cannot be approved yet: gates an edit added or changed have not run on its recorded work: review " +
      '(review authorization boundaries). To run them, the owner sends the work back to the step: `fuse-flow continue feat --back-to work --note "<the owner\'s decision>"`',
  );
  expect(r.status("feat", "work")).toBe("AWAITING_OWNER");
  r.ok("continue", "feat", "--back-to", "work");
  expect(r.ok("start", "feat")).toContain("  1. Have an independent agent review authorization boundaries.");
});

// A state file an earlier fuse-flow wrote, without the reviews' identities.
function writeOld(edit: (s: any) => void): void {
  const old = r.state("feat");
  edit(old.steps);
  r.write(join(".konductor", "workstreams", "feat.yml"), Bun.YAML.stringify(old, null, 2));
}

test("work handed to the owner by an earlier fuse-flow counts its reviews as they are when this one first reads it", () => {
  r.start("feat", OWNER_ONLY("      - agent: review the work\n"));
  r.ok("continue", "feat");
  writeOld((s) => delete s.work.reviews_passed);
  expect(r.ok("start", "feat")).not.toContain("have not run on it");
  expect(r.state("feat").steps.work.reviews_passed).toEqual(["review 1 (review the work)"]);
  r.write("workflow-source.yml", OWNER_ONLY("      - agent: review the work\n      - agent: review authorization boundaries\n"));
  expect(r.ok("start", "feat")).toContain("they have not run on it: review (review authorization boundaries).");
  expect(r.refused("continue", "feat", "--owner-approved")).toContain("step work cannot be approved yet");
});

test("an acceptance or block an earlier fuse-flow recorded by number holds while the review is unchanged since it was first read", () => {
  r.start("feat", ONE_REVIEW("review the notes"));
  r.write("notes.md");
  r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
  writeOld((s) => delete s.s.blocked_review);
  expect(r.ok("start", "feat")).toContain("--owner-approved --gate 1");
  r.ok("continue", "feat", "--owner-approved", "--gate", "1");
  writeOld((s) => delete s.s.accepted_reviews);
  expect(r.ok("start", "feat")).toContain("  1. The owner accepted this review (review the notes) as it was; do not run it again.\n");
  r.write("workflow-source.yml", ONE_REVIEW("review the notes and their risks"));
  const resumed = r.ok("start", "feat");
  expect(resumed).toContain("TAKEN BACK: the owner accepted review 1 (review the notes) as it was");
  expect(resumed).toContain("  1. Have an independent agent review the notes and their risks.");
});
