// SPDX-License-Identifier: Apache-2.0
// The workstream's base: the commit a code review starts from. fuse-flow
// records it when a workstream starts and finds it again on a best-effort
// basis after a rebase or squash; it never refuses for want of one.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

const WORKFLOW = `version: 1
name: w
steps:
  - id: build
    instruction: Build the change.
    updates:
      - artifact: code
        path: src/
    gates:
      - agent: review the diff against the spec
`;

// Run git in the test repository. `date` sets both commit dates, so a commit
// can predate the workstream.
function git(args: string[], date?: string): string {
  const env: Record<string, string> = { ...repo.env, GIT_CONFIG_NOSYSTEM: "1" };
  if (date) Object.assign(env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  const r = spawnSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo.root,
    env,
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function initGit(): void {
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  git(["init", "-q"]);
}

function commit(subject: string, file: string, date?: string): string {
  repo.write(file, `${subject}\n`);
  git(["add", file], date);
  git(["commit", "-q", "-m", subject], date);
  return git(["rev-parse", "HEAD"]);
}

const short = (sha: string) => sha.slice(0, 12);

describe("base", () => {
  test("a new workstream records HEAD as its base, and the review and status name it", () => {
    initGit();
    const head = commit("Add the parser", "src/parser.ts");
    const out = repo.start("feat", WORKFLOW);

    expect(repo.state("feat").base).toEqual({ sha: head, subject: "Add the parser" });
    expect(out).toContain(`base:     ${short(head)} (Add the parser)\n`);
    expect(out).toContain(
      `When the review covers code, the workstream's changes are everything since its base commit ${short(head)} ` +
        "(Add the parser): the commits from there to HEAD, and any changes not committed yet. The base was recorded " +
        "when the workstream started. Use it as it is, even if the range is a little wider or narrower than the " +
        "work; do not ask the owner about it.",
    );
    // The workstream's own commits do not move the base.
    commit("Build the change", "src/change.ts");
    expect(repo.ok("status", "feat")).toContain(`  base: ${short(head)} (Add the parser)\n`);
  });

  test("after a rebase rewrites the base, it is found again by its commit message", () => {
    initGit();
    commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    commit("Add the parser", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    // Rewrite the base commit, keeping its message.
    repo.write("src/parser.ts", "changed\n");
    git(["commit", "-q", "-a", "--amend", "--no-edit"]);
    const rewritten = git(["rev-parse", "HEAD"]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(rewritten)} (Add the parser), found by its commit message; the history was rewritten since the workstream started\n`);
    expect(out).toContain(`everything since its base commit ${short(rewritten)} (Add the parser)`);
  });

  test("when the base is gone by sha and by message, the newest commit before the workstream started stands in", () => {
    initGit();
    const older = commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    commit("Add the parser", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    // A squash that gives the base a new message, and a commit date after the start.
    repo.write("src/parser.ts", "squashed\n");
    git(["commit", "-q", "-a", "--amend", "-m", "Parser and change"]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(
      `base:     ${short(older)} (Start), the newest commit made before the workstream started, because the recorded base is no longer in the history\n`,
    );
    expect(out).toContain(`everything since its base commit ${short(older)} (Start)`);
  });

  test("when no commit predates the workstream, the first commit of the history stands in", () => {
    initGit();
    commit("Add the parser", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    repo.write("src/parser.ts", "squashed\n");
    git(["commit", "-q", "-a", "--amend", "-m", "Everything"]);
    const root = git(["rev-parse", "HEAD"]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(root)} (Everything), the first commit of the history`);
  });

  test("after a rebase, a base found by its message is never one of the workstream's own commits with the same message", () => {
    initGit();
    const start = commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    commit("wip", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    // The workstream's own commit, with the same message as its base.
    commit("wip", "src/change.ts");
    // Rewrite both commits: a cherry-pick keeps each one's message and author date.
    const [base, own] = git(["rev-list", "--reverse", `${start}..HEAD`]).split("\n");
    git(["reset", "-q", "--hard", start]);
    git(["cherry-pick", base]);
    const rewritten = git(["rev-parse", "HEAD"]);
    git(["cherry-pick", own]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(rewritten)} (wip), found by its commit message`);
  });

  test("after a rebase, an older commit with the base's message, cherry-picked during the workstream, is not taken for the base", () => {
    initGit();
    const start = commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    // A topic commit, written before the workstream, on a branch of its own.
    git(["checkout", "-q", "-b", "topic"]);
    const topic = commit("wip", "src/imported.ts", "2020-01-01T12:00:00Z");
    git(["checkout", "-q", "-"]);
    const base = commit("wip", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    // The base is replayed onto a changed upstream, then the topic commit is
    // brought in as the workstream's work; a cherry-pick keeps its old author date.
    git(["reset", "-q", "--hard", start]);
    commit("Upstream", "b.txt", "2020-01-01T06:00:00Z");
    git(["cherry-pick", base]);
    const rewritten = git(["rev-parse", "HEAD"]);
    git(["cherry-pick", topic]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(rewritten)} (wip), found by its commit message`);
  });

  test("a cherry-picked commit with the base's message, author and author time is not taken for the base", () => {
    initGit();
    const start = commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    // Both commits carry the same author, email and second: git cannot tell
    // them apart by their metadata.
    git(["checkout", "-q", "-b", "topic"]);
    const topic = commit("wip", "src/imported.ts", "2020-01-02T00:00:00Z");
    git(["checkout", "-q", "-"]);
    const base = commit("wip", "src/parser.ts", "2020-01-02T00:00:00Z");
    repo.start("feat", WORKFLOW);
    git(["reset", "-q", "--hard", start]);
    commit("Upstream", "b.txt", "2020-01-01T06:00:00Z");
    git(["cherry-pick", base]);
    const rewritten = git(["rev-parse", "HEAD"]);
    git(["cherry-pick", topic]);

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(rewritten)} (wip), found by its commit message`);
  });

  test("a workstream started before the repository's first commit reviews that first commit too", () => {
    initGit();
    repo.start("feat", WORKFLOW);
    expect(repo.state("feat").base).toBeUndefined();
    const first = commit("Scaffold the project", "src/main.ts");
    commit("Build the change", "src/change.ts");

    const out = repo.ok("start", "feat");
    expect(out).toContain(`base:     ${short(first)} (Scaffold the project), the first commit of the history`);
    expect(out).toContain("so the review covers that first commit too");
  });

  test("a state file without a base, from an earlier fuse-flow, falls back the same way", () => {
    initGit();
    const older = commit("Start", "a.txt", "2020-01-01T00:00:00Z");
    repo.start("feat", WORKFLOW);
    const file = ".konductor/workstreams/feat.yml";
    repo.write(file, repo.read(file).replace(/^base:\n(  .*\n)+/m, ""));
    expect(repo.state("feat").base).toBeUndefined();
    commit("Build the change", "src/change.ts");

    expect(repo.ok("start", "feat")).toContain(`base:     ${short(older)} (Start), the newest commit made before the workstream started, because no base was recorded\n`);
  });

  test("a child workstream records HEAD when fuse-flow creates it, and keeps it when it is resumed later", () => {
    initGit();
    repo.write(
      ".konductor/workflows/child.yml",
      "version: 1\nname: child\nsteps:\n  - id: review\n    instruction: Review.\n    gates:\n      - agent: review the change\n",
    );
    const parentWorkflow = `version: 1
name: parent
steps:
  - id: build
    instruction: Build it.
  - id: delegate
    instruction: Wait for the review.
    gates:
      - workflow: child
        slug: "{slug}-child"
`;
    const a = commit("Start the work", "a.txt");
    repo.start("feat", parentWorkflow);
    const b = commit("Build it", "src/build.ts");
    // Finishing the first step hands out the delegating step, which creates the child.
    repo.ok("continue", "feat");
    expect(repo.state("feat").base.sha).toBe(a);
    expect(repo.state("feat-child").base).toEqual({ sha: b, subject: "Build it" });

    commit("Unrelated later work", "c.txt");
    const resumed = repo.ok("start", "feat-child");
    expect(repo.state("feat-child").base.sha).toBe(b);
    expect(resumed).toContain(`base:     ${short(b)} (Build it)\n`);
  });

  test("outside a git repository, or before the first commit, there is no base and nothing is refused", () => {
    // The test repository's .git is an empty folder, not a repository.
    const out = repo.start("plain", WORKFLOW);
    expect(repo.state("plain").base).toBeUndefined();
    expect(out).not.toContain("base:");
    expect(out).not.toContain("base commit");

    initGit();
    const empty = repo.start("empty", WORKFLOW);
    expect(repo.state("empty").base).toBeUndefined();
    expect(empty).not.toContain("base commit");
  });
});
