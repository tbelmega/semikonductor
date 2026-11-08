// SPDX-License-Identifier: Apache-2.0
// fuse-pull-request as a loop over a set of pull requests: it validates, it
// takes the documents of the workflows that hand off to it, it names no
// particular review system, and a whole run goes through the command line:
// the given pull requests, the autonomy agreement, two cycles of the loop and
// the report.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

const WORKFLOW = join(FLOW_DIR, "workflows", "fuse", "fuse-pull-request.yml");
const LEDGER = ".konductor/pull-requests/prs.md";

test("fuse-pull-request validates", () => {
  const out = repo.ok("validate", WORKFLOW);
  expect(out).toContain("1 workflow valid");
});

// A stand-in for the workflow that hands off: it writes the documents under
// the ids fuse-pull-request takes, as fuse-feature-development and
// fuse-dependency-migration do.
const EARLIER = (ids: string[]) => `version: 1
name: earlier
steps:
  - id: work
    instruction: Write the documents.
    produces:
${ids.map((id) => `      - artifact: ${id}\n        path: docs/${id}.md`).join("\n")}
`;

test("started after a feature or a migration, it binds the same documents as before", () => {
  for (const [slug, ids] of [
    ["feature", ["feature-spec"]],
    ["migration", ["migration-spec", "check-catalogue", "migration-report"]],
  ] as const) {
    repo.start(slug, EARLIER([...ids]));
    for (const id of ids) repo.write(`docs/${id}.md`, `# ${id}\n`);
    repo.ok("continue", slug);
    repo.ok("start", `${slug}-prs`, "--workflow", "fuse-pull-request", "--after", slug);
    expect(repo.state(`${slug}-prs`).inputs).toEqual(Object.fromEntries(ids.map((id) => [id, `docs/${id}.md`])));
  }
  // Both still hand off here.
  for (const file of ["fuse-feature-development.yml", "fuse-dependency-migration.yml"]) {
    const wf = Bun.YAML.parse(readFileSync(join(FLOW_DIR, "workflows", "fuse", file), "utf8")) as { hands_off_to: { workflow: string }[] };
    expect(wf.hands_off_to.map((h) => h.workflow)).toContain("fuse-pull-request");
  }
});

test("the workflow and its guides name no particular review system", () => {
  const files = [
    WORKFLOW,
    join(FLOW_DIR, "workflows", "fuse", "babysit-exit.md"),
    join(FLOW_DIR, "library", "artifacts", "pull-request-ledger", "guide.md"),
    join(FLOW_DIR, "library", "artifacts", "pull-request-ledger", "template.md"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/\b(amazon|crux|brazil|code\.amazon|cr-\d+|gerrit|phabricator)\b/i);
  }
});

test("a run with given pull requests goes through the autonomy agreement, two cycles and the report", () => {
  repo.ok("start", "prs", "--workflow", "fuse-pull-request");
  // The owner named the pull requests, so none is opened.
  const autonomy = repo.ok("continue", "prs", "--skip", "the owner named two pull requests to babysit");
  expect(autonomy).toContain("STEP autonomy (2 of 6)");
  repo.write(LEDGER, "# Pull request ledger\n\n| PR1 | https://example.com/pr/1 | open |\n| PR2 | https://example.com/pr/2 | open |\n");
  expect(repo.ok("continue", "prs", "--updated", LEDGER)).toContain("awaits the owner's action");
  const poll = repo.ok("continue", "prs", "--owner-approved", "--note", "level 2; fixes in this checkout; no merging");
  expect(poll).toContain("STEP poll (3 of 6)");
  expect(poll).toContain("LOOP: cycle 1 of the loop at respond, which repeats from poll, at most 300 cycles.");
  expect(poll).not.toContain("WAIT:");

  // Cycle 1: no feedback asks for code, so fix is skipped; PR1 is still open.
  repo.write(LEDGER, `${repo.read(LEDGER)}\nPolled cycle 1.\n`);
  expect(repo.ok("continue", "prs", "--updated", LEDGER)).toContain("STEP fix (4 of 6)");
  const respond = repo.ok("continue", "prs", "--skip", "no open item calls for a code change");
  expect(respond).toContain("STEP respond (5 of 6)");
  expect(respond).toContain("Judge yourself whether every pull request is merged or blocked");
  expect(respond).not.toContain("Start the reviewer");
  repo.write(".konductor/reviews/prs/respond-round-1.json", '{"findings": [{"title": "PR1 waits for a first review"}]}\n');
  const cycle2 = repo.ok("continue", "prs", "--updated", LEDGER, "--again", "PR1 waits for a first review");
  expect(cycle2).toContain("cycle 2 of the loop at respond starts at poll");
  expect(cycle2).toContain("WAIT: before this step's work, wait about 15m");

  // Cycle 2: both pull requests merged.
  repo.write(LEDGER, `${repo.read(LEDGER)}\nPolled cycle 2: PR1 merged, PR2 merged.\n`);
  repo.ok("continue", "prs", "--updated", LEDGER);
  repo.ok("continue", "prs", "--skip", "nothing to fix");
  repo.write(".konductor/reviews/prs/respond-pass-2-round-1.json", '{"findings": []}\n');
  const report = repo.ok("continue", "prs", "--updated", LEDGER);
  expect(report).toContain("respond: COMPLETED");
  expect(report).toContain("STEP report (6 of 6)");
  repo.write(LEDGER, `${repo.read(LEDGER)}\n## Report\n\nPR1 and PR2 merged.\n`);
  expect(repo.ok("continue", "prs", "--updated", LEDGER)).toContain("STATUS: workflow complete");
  expect(repo.state("prs").steps.respond.cycle).toBe(2);
});

test("the ledger's folder is kept out of git, as fuse-flow's other working folders are", () => {
  repo.ok("start", "prs", "--workflow", "fuse-pull-request");
  expect(repo.read(".konductor/pull-requests/.gitignore")).toBe("*\n");
});

test("the fix step names the ledger it reads", () => {
  repo.ok("start", "prs", "--workflow", "fuse-pull-request");
  repo.ok("continue", "prs", "--skip", "given pull requests");
  repo.write(LEDGER, "# Ledger\n");
  repo.ok("continue", "prs", "--updated", LEDGER);
  repo.ok("continue", "prs", "--owner-approved");
  const fix = repo.ok("continue", "prs", "--updated", LEDGER);
  expect(fix).toContain("STEP fix (4 of 6)");
  expect(fix).toContain(`READ ${LEDGER}`);
});
