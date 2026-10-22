// SPDX-License-Identifier: Apache-2.0
// Amendments: a later step changes a document an earlier step produced,
// with the owner's agreement. The step block says how, and status shows the
// document as amended by that step.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { AMENDING, Repo } from "./helpers";

const AMEND = `version: 1
name: amend
steps:
  - id: spec
    instruction: Write the spec.
    produces:
      - artifact: spec
        path: spec.md
    gates:
      - owner-action: approve the spec
  - id: build
    instruction: Build it.
    updates:
      - artifact: code
        path: src/
  - id: revise
    instruction: Revise the spec.
    updates:
      - artifact: spec
        path: spec.md
`;

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write("src/a.ts");
});
afterEach(() => repo.cleanup());

test("a later step that changes an earlier step's document is told how, and status shows the amendment", () => {
  const first = repo.start("feat", AMEND);
  expect(first).not.toContain("AMENDING EARLIER WORK");
  repo.write("spec.md");
  repo.ok("continue", "feat");
  const build = repo.ok("continue", "feat", "--owner-approved");
  expect(build).toContain(`${AMENDING}\n`);

  // The build step changes the approved spec, which it does not declare.
  const revise = repo.ok("continue", "feat", "--updated", "src/a.ts", "--updated", "spec.md");
  expect(revise).toContain("STEP revise");
  expect(repo.ok("status", "feat")).toContain("spec.md (approved; amended by build)");

  // A step that declares the document updates it; that is not an amendment.
  repo.ok("continue", "feat", "--updated", "spec.md");
  const status = repo.ok("status", "feat");
  expect(status).toContain("spec.md (done; also recorded by spec; amended by build)");
  expect(status).not.toContain("amended by build, revise");
});

test("a folder an earlier step recorded whole shows that a later step changed files in it, new or not", () => {
  repo.start(
    "feat",
    `version: 1
name: notes
steps:
  - id: research
    instruction: Write notes.
    produces:
      - artifact: notes
        path: notes/
  - id: build
    instruction: Build it.
    updates:
      - artifact: code
        path: src/
`,
  );
  repo.write("notes/one.md");
  repo.ok("continue", "feat");
  repo.write("notes/two.md");
  repo.ok("continue", "feat", "--updated", "src/a.ts", "--updated", "notes/two.md");
  const status = repo.ok("status", "feat");
  expect(status).toContain("notes/ (done; build changed files in it)");
  expect(status).not.toContain("amended by");
});

test("a change to an existing file in a folder an earlier step recorded whole shows the same folder notice", () => {
  repo.start(
    "feat",
    `version: 1
name: notes
steps:
  - id: research
    instruction: Write notes.
    produces:
      - artifact: notes
        path: notes/
  - id: build
    instruction: Build it.
    updates:
      - artifact: code
        path: src/
`,
  );
  repo.write("notes/one.md");
  repo.ok("continue", "feat");
  repo.write("notes/one.md", "changed\n");
  repo.ok("continue", "feat", "--updated", "src/a.ts", "--updated", "notes/one.md");
  const status = repo.ok("status", "feat");
  expect(status).toContain("notes/ (done; build changed files in it)");
  expect(status).not.toContain("amended by");
});

test("a later step that declares a file inside an earlier step's folder updates it, which is no amendment", () => {
  repo.start(
    "feat",
    `version: 1
name: notes
steps:
  - id: research
    instruction: Write notes.
    produces:
      - artifact: notes
        path: notes/
  - id: revise
    instruction: Revise the first note.
    updates:
      - artifact: notes
        path: notes/one.md
`,
  );
  repo.write("notes/one.md");
  repo.ok("continue", "feat");
  repo.write("notes/one.md", "changed\n");
  repo.ok("continue", "feat", "--updated", "notes/one.md");
  expect(repo.ok("status", "feat")).not.toContain("changed files in it");
});

test("a document is declared by its path: the same id elsewhere is an amendment, the same path under another id is not", () => {
  repo.start(
    "feat",
    `version: 1
name: paths
steps:
  - id: report
    instruction: Write the report.
    produces:
      - artifact: report
        path: old.md
  - id: replace
    instruction: Write the new report.
    optional_produces:
      - artifact: report
        path: new.md
  - id: fold
    instruction: Fold the report in.
    updates:
      - artifact: summary
        path: old.md
`,
  );
  repo.write("old.md");
  repo.ok("continue", "feat");
  // The replacement step declares the same id at another path, so changing old.md amends it.
  repo.write("old.md", "changed\n");
  repo.ok("continue", "feat", "--updated", "old.md");
  expect(repo.ok("status", "feat")).toContain("old.md (done; amended by replace)");
  // The last step declares old.md itself, under another id: an ordinary update.
  repo.ok("continue", "feat", "--updated", "old.md");
  const status = repo.ok("status", "feat");
  expect(status).toContain("amended by replace)");
  expect(status).not.toContain("amended by replace, fold");
});

test("a record of the whole repository is not shown as amended", () => {
  repo.start(
    "feat",
    `version: 1
name: code
steps:
  - id: build
    instruction: Build it.
    updates:
      - artifact: code
        path: .
  - id: report
    instruction: Report.
    produces:
      - artifact: report
        path: report.md
`,
  );
  repo.ok("continue", "feat", "--updated", "src/a.ts");
  repo.write("report.md");
  repo.write("src/a.ts", "changed\n");
  repo.ok("continue", "feat", "--updated", "src/a.ts");
  expect(repo.ok("status", "feat")).not.toContain("amended by");
});

// A workstream that finished a step before an edit gave it an owner gate:
// that gate never ran, so the next owner approval covers the step, and the
// hand-over says so.
test("an owner gate an edit added to a finished step is covered by the next owner approval, which says so", () => {
  const before = `version: 1
name: design
steps:
  - id: design
    instruction: Design it.
    produces:
      - artifact: design
        path: design.md
  - id: split
    instruction: Split it.
    produces:
      - artifact: order
        path: order.md
    gates:
      - owner-action: approve the build order
`;
  repo.start("feat", before);
  repo.write("design.md");
  repo.ok("continue", "feat");
  repo.write(
    "workflow-source.yml",
    before.replace("        path: design.md\n", "        path: design.md\n    gates:\n      - owner-action: approve the design\n"),
  );
  repo.write("order.md");
  const handOver = repo.ok("continue", "feat");
  expect(handOver).toContain(
    "The owner is asked to approve the build order. Approving it also approves the work of step design, whose owner gate " +
      "(approve the design) an edit of the workflow added after that step had finished, so it never ran.",
  );
  repo.ok("continue", "feat", "--owner-approved");
  expect(repo.ok("status", "feat")).toContain("design.md (approved)");
});

test("accepting a blocked step whose earlier step's owner gate an edit added says that it approves that step too", () => {
  const before = `version: 1
name: design
steps:
  - id: design
    instruction: Design it.
    produces:
      - artifact: design
        path: design.md
  - id: split
    instruction: Split it.
    produces:
      - artifact: order
        path: order.md
    gates:
      - agent: review the build order
      - owner-action: approve the build order
`;
  repo.start("feat", before);
  repo.write("design.md");
  repo.ok("continue", "feat");
  repo.write(
    "workflow-source.yml",
    before.replace("        path: design.md\n", "        path: design.md\n    gates:\n      - owner-action: approve the design\n"),
  );
  repo.write("order.md");
  const blocked = repo.ok("continue", "feat", "--blocked", "the review keeps finding gaps", "--gate", "1");
  expect(blocked).toContain(
    "STATUS: blocked. blocked by the agent: the review keeps finding gaps. Accepting the whole step also approves the work of step " +
      "design, whose owner gate (approve the design) an edit of the workflow added after that step had finished, so it never ran.",
  );
  repo.ok("continue", "feat", "--owner-approved");
  expect(repo.ok("status", "feat")).toContain("design.md (approved)");
});
