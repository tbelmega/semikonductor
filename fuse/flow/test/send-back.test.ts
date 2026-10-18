// SPDX-License-Identifier: Apache-2.0
// Sending work back to an earlier step, end to end, for example from a
// prototype step to a requirements step. Each test covers one rule for what
// a send-back keeps, records or reopens, so that the owner and the agent see
// the state they expect on the next pass.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Repo } from "./helpers.ts";

const SYSTEM = `version: 1
name: system
steps:
  - id: intake
    instruction: Write down what the owner wants.
    produces:
      - artifact: wishlist
        path: requirements.md
  - id: requirements
    instruction: Turn the draft into requirements.
    updates:
      - artifact: wishlist
        path: requirements.md
    gates:
      - agent: review the requirements
        max_rounds: 2
      - owner-action: approve the requirements
  - id: prototype
    condition:
      agent: an assumption needs an experiment
    instruction: Run the experiments the owner agrees to, one research note each.
    consumes: [wishlist]
    produces:
      - artifact: notes
        path: research/
  - id: design
    instruction: Design it, citing the research notes.
    consumes: [wishlist, notes]
    produces:
      - artifact: design
        path: design.md
`;

let r: Repo;

beforeEach(() => {
  r = new Repo();
  // The research folder is shared with other work, so it exists before the workstream.
  r.write("research/someone-elses.md");
  r.start("ds", SYSTEM);
  r.write("requirements.md", "Status: draft\n");
  r.ok("continue", "ds"); // intake
  r.ok("continue", "ds", "--updated", "requirements.md"); // requirements, awaits the owner
  r.ok("continue", "ds", "--owner-approved");
  expect(r.status("ds", "prototype")).toBe("IN_PROGRESS");
});

afterEach(() => r.cleanup());

const history = (step: string): string[] => r.state("ds").steps[step].history;

test("the owner sends work back from a step in progress, with no false block", () => {
  r.write("research/harness.md");
  const out = r.ok("continue", "ds", "--back-to", "requirements", "--updated", "research/harness.md", "--note", "the experiments changed the requirements");
  expect(out).toStartWith("prototype: owner sent the work back to requirements");
  expect(history("prototype").some((h) => h.includes("blocked"))).toBe(false);
  expect(r.status("ds", "requirements")).toBe("IN_PROGRESS");
  expect(r.status("ds", "prototype")).toBe("PENDING");
});

test("work a step had written is kept through a send-back and offered to its next pass", () => {
  r.write("research/harness.md");
  r.write("research/chat.md");
  r.ok("continue", "ds", "--back-to", "requirements", "--updated", "research/harness.md", "--updated", "research/chat.md");
  expect(r.state("ds").steps.prototype.artifacts).toEqual([
    { artifact: "notes", path: "research/harness.md", status: "draft" },
    { artifact: "notes", path: "research/chat.md", status: "draft" },
  ]);

  r.ok("continue", "ds", "--updated", "requirements.md");
  const again = r.ok("continue", "ds", "--owner-approved");
  expect(again).toContain(
    "EARLIER PASS: this step ran before the owner sent the work back, and wrote research/harness.md, research/chat.md. " +
      "Check each against what changed since: keep it, update it, or redo it, and propose to the owner which.",
  );
  // The folder existed before the workstream, but the workstream did write in it.
  expect(again).not.toContain("this workstream did not write it");
  expect(again).toContain("research/ existed before this workstream; the files this workstream wrote in it are listed under EARLIER PASS.");

  // Finishing again keeps the earlier notes that are still on disk, beside the new one.
  r.write("research/independent-check.md");
  const design = r.ok("continue", "ds", "--updated", "research/independent-check.md");
  expect(r.state("ds").steps.prototype.artifacts.map((a: { path: string }) => a.path)).toEqual([
    "research/independent-check.md",
    "research/harness.md",
    "research/chat.md",
  ]);
  // The next step reads the notes themselves, not the shared folder.
  expect(design).toContain("READ research/independent-check.md, research/harness.md, research/chat.md (from step prototype).");
  expect(design).not.toContain("READ research/ ");
});

test("earlier-pass files count only while they exist, and never override --not-produced", () => {
  r.write("research/harness.md");
  r.ok("continue", "ds", "--back-to", "requirements", "--updated", "research/harness.md");
  r.ok("continue", "ds", "--updated", "requirements.md");
  r.ok("continue", "ds", "--owner-approved");

  // The earlier note is gone, so the shared folder alone does not finish the step.
  r.cleanupPath("research/harness.md");
  expect(r.refused("continue", "ds")).toContain("research/ (notes) existed before the step");

  // Notes that no longer apply are not recorded once the agent reports the artifact not produced.
  r.write("research/harness.md");
  const design = r.ok("continue", "ds", "--not-produced", "notes", "the new requirements leave nothing to test");
  expect(r.state("ds").steps.prototype.artifacts).toEqual([]);
  expect(design).not.toContain("READ research/");
  expect(design).toContain("READ notes: step prototype did not produce it (the new requirements leave nothing to test)");
});

test("a step that ran and was then skipped starts a new pass when the work is sent back to it", () => {
  r.ok("continue", "ds", "--skip", "no experiment needed after all");
  r.ok("continue", "ds", "--back-to", "prototype");
  expect(r.state("ds").steps.prototype.pass).toBe(2);
});

test("an optional folder that existed before the step is recorded only by the files the step wrote in it", () => {
  const o = new Repo();
  try {
    o.write("notes/old.md");
    const out = o.start(
      "opt",
      `version: 1
name: opt
steps:
  - id: explore
    instruction: Explore.
    optional_produces:
      - artifact: notes
        path: notes/
  - id: use
    instruction: Use the notes.
    consumes: [notes]
`,
    );
    expect(out).toContain("notes/ existed before the step; name each file you write in it with --updated <file>.");
    const next = o.ok("continue", "opt");
    expect(o.state("opt").steps.explore.artifacts).toEqual([]);
    expect(next).toContain("READ notes: step explore wrote nothing in notes/, so there is nothing from it to read.");
    expect(next).not.toContain("READ notes/");
  } finally {
    o.cleanup();
  }
});

test("a produced folder that existed before the step needs the files the step wrote in it", () => {
  const out = r.refused("continue", "ds");
  expect(out).toContain(
    "research/ (notes) existed before the step: name each file the step wrote in it with --updated <file>, or report " +
      'it with --not-produced notes "<reason>".',
  );
  expect(r.ok("continue", "ds", "--not-produced", "notes", "no experiment was needed")).toContain("STEP design");
});

// A step that writes a design and a folder of notes the next step reads.
const NOTES = `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
      - artifact: notes
        path: notes/
    gates:
      - agent: review the design
      - owner-action: approve the design
  - id: release
    instruction: Release it.
    consumes: [notes]
`;

test("a folder recorded whole stays whole when a send-back names a file in it", () => {
  const o = new Repo();
  try {
    o.start("feat", NOTES);
    o.write("design.md");
    o.write("notes/a.md");
    o.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    o.write("notes/b.md");
    const back = o.ok("continue", "feat", "--back-to", "design", "--updated", "notes/b.md");
    expect(back).toContain("EARLIER PASS: this step ran before the owner sent the work back, and wrote design.md, notes/. ");
    expect(o.state("feat").steps.design.files.filter((f: { pass: string }) => f.pass === "earlier").map((f: { path: string }) => f.path)).toEqual([
      "design.md",
      "notes/",
    ]);
  } finally {
    o.cleanup();
  }
});

test("a folder an earlier pass recorded whole stays whole when the next pass names a new file in it", () => {
  const o = new Repo();
  try {
    o.start("feat", NOTES);
    o.write("design.md");
    o.write("notes/a.md");
    o.ok("continue", "feat");
    o.ok("continue", "feat", "--back-to", "design");
    o.write("notes/c.md");
    o.ok("continue", "feat", "--updated", "notes/c.md");
    expect(o.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/", status: "draft" },
    ]);
    const next = o.ok("continue", "feat", "--owner-approved");
    expect(next).toContain("READ notes/ (from step design).");
    expect(next).not.toContain("READ notes/c.md");
  } finally {
    o.cleanup();
  }
});

test("a send-back from a step in progress records a produced file that existed before the step, as a finished step does", () => {
  const o = new Repo();
  try {
    o.write("design.md", "someone else's\n");
    o.start("feat", NOTES);
    o.write("design.md", "the step's own design\n");
    o.ok("continue", "feat", "--back-to", "design");
    const again = o.ok("start", "feat");
    expect(again).toContain("EARLIER PASS: this step ran before the owner sent the work back, and wrote design.md. ");
    expect(again).not.toContain("this workstream did not write it");
  } finally {
    o.cleanup();
  }
});

test("the status view lists each file once, under the latest step that records it", () => {
  r.write("research/harness.md");
  r.ok("continue", "ds", "--back-to", "requirements", "--updated", "research/harness.md");
  const rows = r.ok("status", "ds").split("\n");
  expect(rows.find((l) => l.includes(" intake "))).not.toContain("requirements.md");
  expect(rows.find((l) => l.includes(" requirements "))).toContain("requirements.md (draft; also recorded by intake)");
  expect(rows.find((l) => l.includes(" prototype "))).toContain("research/harness.md (draft)");
});

test("a review after a send-back is a new pass with its own findings files and cap", () => {
  const out = r.ok("continue", "ds", "--back-to", "requirements");
  expect(out).toContain(
    "This is pass 2 of this step, because the owner sent the work back: count only this pass's rounds against the cap.",
  );
  expect(out).toContain(".konductor/reviews/ds/requirements-pass-2-round-<n>.json");
  expect(out).toContain(
    "The review covers the whole artifact. Give the reviewer the findings files of the earlier passes of this step, " +
      "in .konductor/reviews/ds/, with how each finding was handled.",
  );
  expect(out).toContain("After 2 such rounds");
});

test("a status message mentions an artifact's guide only when it has one", () => {
  const back = r.ok("continue", "ds", "--back-to", "requirements");
  expect(back).toContain(
    "If any of requirements.md records a status of its own, such as a 'Status: approved' line, set it back to draft.",
  );
  expect(back).not.toContain("as its guide says");

  r.write(".konductor/library/artifacts/wishlist/guide.md", "# guide\n\nSet `status: approved` once the owner approves.\n");
  r.ok("continue", "ds", "--updated", "requirements.md");
  const approved = r.ok("continue", "ds", "--owner-approved");
  expect(approved).toContain("If any of requirements.md keeps a status of its own, as its guide says, set it to approved.");
});

test("an input from a step whose condition did not hold is reported as nothing to read", () => {
  const out = r.ok("continue", "ds", "--skip", "the requirements leave no assumption open");
  expect(out).toContain(
    "READ notes: step prototype was skipped (the requirements leave no assumption open), so there is nothing from it to read.",
  );
  expect(out).not.toContain("Restore what this step needs");
});

test("the owner's notes since the pass began reach the step block, its review and its earlier-pass advice", () => {
  r.write("research/harness.md");
  const note = "drop the offline mode; keep the harness note";
  const back = r.ok("continue", "ds", "--back-to", "requirements", "--updated", "research/harness.md", "--note", note);
  expect(back).toContain(`\nOWNER SAID: "${note}"\n`);
  expect(back).toContain(
    "EARLIER PASS: this step ran before the owner sent the work back, and wrote requirements.md. Check each against " +
      "what changed since. Follow the owner's notes where they decide what happens to a file; for the files they do " +
      "not mention, keep it, update it, or redo it, and propose to the owner which.",
  );
  expect(back).toContain("Give the reviewer the owner's notes as well.");

  const granted = r.ok("continue", "ds", "--more-rounds", "1", "--note", "one more round for the API section");
  expect(granted).toContain(`\nOWNER SAID: "${note}"\nOWNER SAID: "one more round for the API section"\n`);

  r.ok("continue", "ds", "--updated", "requirements.md");
  const prototype = r.ok("continue", "ds", "--owner-approved", "--note", "approved without offline mode");
  // The send-back reopened the prototype step too, so it carries the same note; the other notes are the requirements step's.
  expect(prototype).toContain("STEP prototype");
  expect(prototype).toContain(`\nOWNER SAID: "${note}"\n`);
  expect(prototype).not.toContain("one more round for the API section");
  expect(prototype).not.toContain("approved without offline mode");
});

test("the help says what done and approved mean", () => {
  expect(r.ok("help")).toContain("done means the step's gates passed and it has no owner gate;");
  expect(r.ok("help")).toContain("approved means an owner gate approved it");
});

// A step that revises code a later step reads.
const PATCH = `version: 1
name: w
steps:
  - id: fix
    instruction: Fix the code.
    updates:
      - artifact: patch
        path: src/
    gates:
      - agent: review the fix
  - id: release
    instruction: Release it.
    consumes: [patch]
`;

test("a file named for an updates artifact when a blocked step is sent back keeps the artifact recorded through a later block and the owner's acceptance", () => {
  const o = new Repo();
  try {
    o.start("feat", PATCH);
    o.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    o.write("src/a.ts");
    o.ok("continue", "feat", "--back-to", "fix", "--updated", "patch=src/a.ts");
    expect(o.state("feat").steps.fix.artifacts).toEqual([{ artifact: "patch", path: "src/", status: "draft" }]);
    o.ok("start", "feat");
    o.ok("continue", "feat", "--blocked", "still not converging", "--gate", "1");
    expect(o.state("feat").steps.fix.artifacts).toEqual([{ artifact: "patch", path: "src/", status: "draft" }]);
    const next = o.ok("continue", "feat", "--owner-approved");
    expect(o.state("feat").steps.fix.artifacts).toEqual([{ artifact: "patch", path: "src/", status: "approved" }]);
    expect(next).toContain("READ src/ (from step fix).");
  } finally {
    o.cleanup();
  }
});
