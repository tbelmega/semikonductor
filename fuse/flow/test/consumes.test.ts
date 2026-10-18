// SPDX-License-Identifier: Apache-2.0
// Where a consumed document comes from when the nearest earlier step that
// would write it wrote nothing: skipped as not needed, reported not produced,
// or a delegating step the owner jumped past.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

const install = (name: string, yaml: string) => repo.write(`.konductor/workflows/${name}.yml`, yaml);

describe("a consumed document whose nearest writer wrote nothing", () => {
  const MIGRATION = `version: 1
name: migration
steps:
  - id: catalogue
    instruction: Write the check catalogue.
    produces:
      - artifact: catalogue
        path: catalogue.md
  - id: guardrails
    instruction: Add guardrails and update the catalogue.
    condition:
      agent: the catalogue has gaps
    updates:
      - artifact: catalogue
        path: catalogue.md
  - id: baseline
    instruction: Record the baseline.
    consumes: [catalogue]
`;

  test("a step skipped as not needed passes the reader on to the earlier step that wrote the document", () => {
    repo.start("m", MIGRATION);
    repo.write("catalogue.md");
    repo.ok("continue", "m");
    const out = repo.ok("continue", "m", "--skip", "the catalogue has no gaps");
    expect(out).toContain("STEP baseline (3 of 3)");
    expect(out).toContain("READ catalogue.md (from step catalogue).");
    expect(out).not.toContain("so there is nothing from it to read");
  });

  test("a step that reports the document not produced passes the reader on to the earlier step that wrote it", () => {
    const again = MIGRATION.replace(
      "    updates:\n      - artifact: catalogue\n        path: catalogue.md\n",
      "    produces:\n      - artifact: catalogue\n        path: catalogue.md\n",
    ).replace("    condition:\n      agent: the catalogue has gaps\n", "");
    repo.start("m", again);
    repo.write("catalogue.md");
    repo.ok("continue", "m");
    const out = repo.ok("continue", "m", "--not-produced", "catalogue", "no gaps found");
    expect(out).toContain("READ catalogue.md (from step catalogue).");
    expect(out).not.toContain("did not produce it");
  });

  test("with no earlier writer, the skipped step is still reported as leaving nothing to read", () => {
    const only = MIGRATION.replace(/  - id: catalogue\n[\s\S]*?path: catalogue.md\n/, "");
    repo.start("m", only);
    const out = repo.ok("continue", "m", "--skip", "the catalogue has no gaps");
    expect(out).toContain("READ catalogue: step guardrails was skipped (the catalogue has no gaps), so there is nothing from it to read.");
  });
});

test("a document returned by a delegating step the owner jumped past is to be restored, not 'nothing to read'", () => {
  install(
    "child",
    `version: 1\nname: child\nsteps:\n  - id: review\n    instruction: Review.\n    produces: { artifact: report, path: "reports/{slug}.md" }\n`,
  );
  repo.start(
    "pr",
    `version: 1
name: parent
steps:
  - id: adversarial
    instruction: Merge the findings.
    gates:
      - workflow: child
        returns: { findings: report }
  - id: fix
    instruction: Fix what the findings say.
  - id: summary
    instruction: Summarize.
    consumes: [findings]
`,
  );
  const out = repo.ok("continue", "pr", "--forward-to", "summary", "--note", "the findings came by mail");
  expect(out).toContain("READ findings: step adversarial was skipped (owner jumped forward to summary: the findings came by mail), so no child workstream returned it.");
  expect(out).toContain("Restore what this step needs");
});

test("after an edit moves an artifact's path, the reader and a later workstream read the document the step recorded", () => {
  const SOURCE = `version: 1
name: source
steps:
  - id: write
    instruction: Write the report.
    produces: { artifact: report, path: old.md }
  - id: read
    instruction: Read the report.
    consumes: [report]
`;
  install("source", SOURCE);
  install("target", "version: 1\nname: target\ninputs:\n  - artifact: report\nsteps:\n  - id: read\n    instruction: Read the report.\n    consumes: [report]\n");
  repo.ok("start", "s", "--workflow", "source");
  repo.write("old.md");
  repo.ok("continue", "s");
  install("source", SOURCE.replace("path: old.md", "path: new.md"));
  const local = repo.ok("start", "s");
  expect(local).toContain("READ old.md (from step write).");
  expect(local).not.toContain("Restore what this step needs");
  repo.ok("continue", "s");
  expect(repo.ok("start", "t", "--workflow", "target", "--after", "s")).toContain("READ old.md (input report).");
});

test("an optional producer that wrote nothing passes the reader on to the earlier step that wrote the document", () => {
  const SOURCE = `version: 1
name: source
steps:
  - id: old
    instruction: Write the report.
    produces: { artifact: report, path: old.md }
  - id: maybe
    instruction: Replace the report if needed.
    optional_produces: { artifact: report, path: new.md }
  - id: read
    instruction: Read the report.
    consumes: [report]
`;
  install("source", SOURCE);
  install("target", "version: 1\nname: target\ninputs:\n  - artifact: report\nsteps:\n  - id: read\n    instruction: Read the report.\n    consumes: [report]\n");
  repo.ok("start", "s", "--workflow", "source");
  repo.write("old.md");
  repo.ok("continue", "s");
  const local = repo.ok("continue", "s");
  expect(local).toContain("READ old.md (from step old).");
  expect(local).not.toContain("new.md");
  repo.ok("continue", "s");
  expect(repo.ok("start", "t", "--workflow", "target", "--after", "s")).toContain("READ old.md (input report).");
});

test("an optional producer that wrote nothing, with no earlier writer, leaves nothing to read and nothing to restore", () => {
  repo.start(
    "s",
    "version: 1\nname: w\nsteps:\n  - id: maybe\n    instruction: Write the report if needed.\n    optional_produces: { artifact: report, path: new.md }\n" +
      "  - id: read\n    instruction: Read.\n    consumes: [report]\n",
  );
  const out = repo.ok("continue", "s");
  expect(out).toContain("READ report: step maybe wrote none, so there is nothing from it to read.");
  expect(out).not.toContain("Restore what this step needs");
});

test("after an edit moves a folder artifact's path, the reader and a later workstream read the files the step recorded", () => {
  const SOURCE = `version: 1
name: source
steps:
  - id: write
    instruction: Write the reports.
    produces: { artifact: report, path: reports/ }
  - id: read
    instruction: Read the reports.
    consumes: [report]
`;
  install("source", SOURCE);
  install("target", "version: 1\nname: target\ninputs:\n  - artifact: report\nsteps:\n  - id: read\n    instruction: Read the reports.\n    consumes: [report]\n");
  repo.write("reports/unrelated.md");
  repo.ok("start", "s", "--workflow", "source");
  repo.write("reports/a.md");
  repo.write("reports/b.md");
  repo.ok("continue", "s", "--updated", "reports/a.md", "--updated", "reports/b.md");
  expect(repo.ok("start", "s")).toContain("READ reports/a.md, reports/b.md (from step write).");
  install("source", SOURCE.replace("path: reports/", "path: relocated/"));
  const local = repo.ok("start", "s");
  expect(local).toContain("READ reports/a.md, reports/b.md (from step write).");
  expect(local).not.toContain("Restore what this step needs");
  repo.ok("continue", "s");
  expect(repo.ok("start", "t", "--workflow", "target", "--after", "s")).toContain("READ reports/ (input report).");
});

test("after an edit moves a folder artifact declared at the repository root, the reader and a later workstream still find the recorded files", () => {
  const SOURCE = `version: 1
name: source
steps:
  - id: write
    instruction: Write the reports.
    produces: { artifact: report, path: "." }
  - id: read
    instruction: Read the reports.
    consumes: [report]
`;
  install("source", SOURCE);
  install("target", "version: 1\nname: target\ninputs:\n  - artifact: report\nsteps:\n  - id: read\n    instruction: Read the reports.\n    consumes: [report]\n");
  repo.ok("start", "s", "--workflow", "source");
  repo.write("a.md");
  repo.write("b.md");
  repo.ok("continue", "s", "--updated", "a.md", "--updated", "b.md");
  expect(repo.ok("start", "s")).toContain("READ a.md, b.md (from step write).");
  install("source", SOURCE.replace('path: "."', "path: relocated/"));
  const local = repo.ok("start", "s");
  expect(local).toContain("READ a.md, b.md (from step write).");
  expect(local).not.toContain("relocated/");
  repo.ok("continue", "s");
  const after = repo.ok("start", "t", "--workflow", "target", "--after", "s");
  expect(after).toContain("READ . (input report).");
  expect(after).not.toContain("relocated/");
});

describe("a consumed document that was recorded and is gone from disk", () => {
  test("a file recorded in a folder that existed before the step is reported missing", () => {
    repo.write("reports/unrelated.md");
    repo.start(
      "s",
      "version: 1\nname: w\nsteps:\n  - id: write\n    instruction: Write.\n    produces: { artifact: report, path: reports/ }\n  - id: read\n    instruction: Read.\n    consumes: [report]\n",
    );
    repo.write("reports/new.md");
    repo.write("reports/second.md");
    repo.ok("continue", "s", "--updated", "reports/new.md", "--updated", "reports/second.md");
    repo.cleanupPath("reports/new.md");
    const out = repo.ok("start", "s");
    expect(out).toContain(
      "READ reports/new.md, reports/second.md (from step write). Of these, reports/new.md does not exist, for example because earlier steps were skipped. Restore what this step needs",
    );
  });

  test("a document the step's own child returned is reported missing", () => {
    install("child", "version: 1\nname: child\nsteps:\n  - id: write\n    instruction: Write.\n    produces: { artifact: report, path: \"reports/{slug}.md\" }\n");
    repo.start(
      "p",
      "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: Run the child.\n    gates:\n      - workflow: child\n        returns: { report: report }\n",
    );
    repo.ok("start", "p-delegate");
    repo.write("reports/p-delegate.md");
    repo.ok("continue", "p-delegate");
    repo.cleanupPath("reports/p-delegate.md");
    const out = repo.ok("start", "p");
    expect(out).toContain("READ reports/p-delegate.md (report, returned by workstream p-delegate). It does not exist, for example because earlier steps were skipped.");
  });
});
