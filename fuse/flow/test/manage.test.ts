// SPDX-License-Identifier: Apache-2.0
// Managing workstreams: start warns about a checkout that is not a clean
// branch of its own, a workstream can be renamed, moved to another checkout
// and closed by the owner.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

// Two steps; the first writes a document whose path holds the slug.
const W = `version: 1
name: w
steps:
  - id: draft
    instruction: Write the draft.
    produces:
      - artifact: spec
        path: docs/{slug}.md
  - id: build
    instruction: Build it.
`;

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write(".konductor/workflows/w.yml", W);
});
afterEach(() => repo.cleanup());

// Make the test repository a real git repository on main, with origin/HEAD
// pointing at main and everything committed. HOME lives inside the
// repository, so git ignores it.
function realGit(r: Repo) {
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(["git", "-C", r.root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { env: r.env });
    if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
    return p.stdout.toString().trim();
  };
  rmSync(join(r.root, ".git"), { recursive: true, force: true });
  git("init", "-q", "-b", "main");
  r.write(".gitignore", "/home/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  return git;
}

// ----------------------------------------------------------------- checkout

test("start warns once, when it mints the workstream, on the branch origin/HEAD points to", () => {
  const git = realGit(repo);
  const out = repo.ok("start", "feat", "--workflow", "w");
  expect(out).toContain("WARNING: this checkout is a poor place for a new workstream: it is on branch main, which origin/HEAD points to.");
  expect(out).toContain('as the fuse-flow README describes under "Moving a workstream"');
  expect(out).toContain("STEP draft");
  // Resuming does not warn again.
  expect(repo.ok("start", "feat")).not.toContain("WARNING");
  // A branch of its own, with nothing uncommitted, gets no warning.
  git("switch", "-q", "-c", "feat-branch");
  expect(repo.ok("start", "other", "--workflow", "w")).not.toContain("WARNING");
});

test("start warns about uncommitted changes outside .konductor/, and names them", () => {
  const git = realGit(repo);
  git("switch", "-q", "-c", "feat-branch");
  repo.write("src/a.ts");
  repo.write(".gitignore", "/home/\n/build/\n");
  const out = repo.ok("start", "feat", "--workflow", "w");
  expect(out).toContain("it has uncommitted changes outside .konductor/, in .gitignore, src/");
  expect(out).not.toContain("origin/HEAD");
  // The workstream's own files under .konductor/ do not count.
  git("add", "-A");
  git("commit", "-q", "-m", "work");
  expect(repo.ok("start", "next", "--workflow", "w")).not.toContain("WARNING");
});

test("a project policy with checkout: refuse turns the warning into a refusal, and the local file can relax it", () => {
  const git = realGit(repo);
  repo.write(".konductor/policy-overrides.yml", "checkout: refuse\n");
  git("add", "-A");
  git("commit", "-q", "-m", "policy");
  expect(repo.refused("start", "feat", "--workflow", "w")).toContain(
    "REFUSED: workstream feat does not start in this checkout: it is on branch main, which origin/HEAD points to. The project's policy sets checkout: refuse.",
  );
  expect(existsSync(join(repo.root, ".konductor/workstreams/feat.yml"))).toBe(false);
  repo.write(".konductor/policy-overrides.local.yml", "checkout: warn\n");
  expect(repo.ok("start", "feat", "--workflow", "w")).toContain("WARNING: this checkout is a poor place");
});

test("outside a git repository, start does not warn", () => {
  expect(repo.ok("start", "feat", "--workflow", "w")).not.toContain("WARNING");
});

test("a rename into .konductor/ still counts the path it came from, in either status column", () => {
  const git = realGit(repo);
  git("switch", "-q", "-c", "feat-branch");
  repo.write("src/a.ts", "export const a = 1;\n");
  git("add", "-A");
  git("commit", "-q", "-m", "a");
  git("mv", "src/a.ts", ".konductor/a.ts");
  expect(repo.ok("start", "staged", "--workflow", "w")).toContain("it has uncommitted changes outside .konductor/, in src/a.ts");
  git("reset", "-q", "--hard");
  // A rename git only sees in the worktree column: an intent-to-add file
  // with the content of a deleted one.
  rmSync(join(repo.root, "src/a.ts"));
  repo.write(".konductor/b.ts", "export const a = 1;\n");
  git("add", "-N", ".konductor/b.ts");
  expect(repo.ok("start", "worktree", "--workflow", "w")).toContain("it has uncommitted changes outside .konductor/, in src/a.ts");
});

test("a checkout git cannot report on counts as a problem, so checkout: refuse does not pass it", () => {
  realGit(repo);
  repo.write(".konductor/policy-overrides.yml", "checkout: refuse\n");
  repo.write(".git/index", "not an index\n");
  expect(repo.refused("start", "feat", "--workflow", "w")).toContain("fuse-flow could not check it for uncommitted changes:");
  // A .git that git cannot read as a repository at all, such as a broken
  // worktree pointer, is not taken for a folder outside git either.
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  repo.write(".git", "gitdir: /nonexistent/worktree\n");
  expect(repo.refused("start", "feat", "--workflow", "w")).toContain("does not start in this checkout: fuse-flow could not check it for uncommitted changes:");
  // Nor a repository folder that lost its HEAD.
  rmSync(join(repo.root, ".git"));
  realGit(repo);
  rmSync(join(repo.root, ".git/HEAD"));
  expect(repo.refused("start", "feat", "--workflow", "w")).toContain("does not start in this checkout: fuse-flow could not check it for uncommitted changes:");
});

// ------------------------------------------------------------------- rename

test("rename moves the state, reviews, decisions and debug log, keeps the documents' paths, and the workstream resumes", () => {
  repo.ok("start", "first-name", "--workflow", "w");
  repo.write("docs/first-name.md", "# spec\n");
  repo.write(".konductor/reviews/first-name/draft-round-1.json", '{"findings": []}\n');
  repo.write(".konductor/decisions/first-name.md", "- a decision\n");
  repo.write(".konductor/debug/first-name.md", "a log line\n");

  const out = repo.ok("rename", "first-name", "better-name");
  expect(out).toContain("renamed workstream first-name to better-name\n");
  expect(out).toContain("  moved .konductor/workstreams/first-name.yml -> .konductor/workstreams/better-name.yml\n");
  expect(out).toContain("  moved .konductor/reviews/first-name -> .konductor/reviews/better-name\n");
  expect(out).toContain("  moved .konductor/decisions/first-name.md -> .konductor/decisions/better-name.md\n");
  expect(out).toContain("  moved .konductor/debug/first-name.md -> .konductor/debug/better-name.md\n");
  expect(out).toContain("Its documents keep their paths: {slug} in its artifact paths stands for first-name.");
  for (const gone of ["workstreams/first-name.yml", "reviews/first-name", "decisions/first-name.md", "debug/first-name.md"]) {
    expect(existsSync(join(repo.root, ".konductor", gone))).toBe(false);
  }
  expect(repo.read(".konductor/reviews/better-name/draft-round-1.json")).toContain("findings");

  // The step block still names the document where it is, and continue finds it.
  expect(repo.ok("start", "better-name")).toContain("docs/first-name.md");
  const done = repo.ok("continue", "better-name");
  expect(done).toContain("STEP build");
  expect(repo.state("better-name").steps.draft.artifacts).toEqual([{ artifact: "spec", path: "docs/first-name.md", status: "done" }]);

  // A second rename keeps the first slug for the paths.
  expect(repo.ok("rename", "better-name", "best-name")).toContain("{slug} in its artifact paths stands for first-name.");
  expect(repo.refused("status", "better-name")).toContain('no workstream "better-name"');
});

test("rename updates the workstreams that name it: started after it, its parent and its child", () => {
  const PARENT = `version: 1
name: parent
steps:
  - id: delegate
    instruction: Wait for the child.
    gates:
      - workflow: w
`;
  repo.write(".konductor/workflows/parent.yml", PARENT);
  repo.ok("start", "first", "--workflow", "w");
  repo.ok("start", "second", "--workflow", "w", "--after", "first");
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;

  const out = repo.ok("rename", "first", "renamed");
  expect(out).toContain("  now named renamed in workstream second\n");
  expect(repo.state("second").after).toBe("renamed");

  repo.ok("rename", "top", "top2");
  expect(repo.state(child).parent.slug).toBe("top2");
  repo.ok("rename", child, "kid");
  expect(repo.state("top2").steps.delegate.children[0].slug).toBe("kid");
  expect(repo.ok("status", "top2")).toContain("waits for workstream kid, which has not been started");
});

test("rename refuses a slug that is taken, by any of the files it would move, and an unknown workstream", () => {
  repo.ok("start", "a", "--workflow", "w");
  repo.ok("start", "b", "--workflow", "w");
  expect(repo.refused("rename", "a", "b")).toContain("REFUSED: the slug b is taken: .konductor/workstreams/b.yml exists");
  repo.write(".konductor/debug/c.md", "someone else's log\n");
  expect(repo.refused("rename", "a", "c")).toContain("REFUSED: the slug c is taken: .konductor/debug/c.md exists");
  expect(repo.refused("rename", "nope", "d")).toContain('REFUSED: no workstream "nope"');
  expect(repo.usage("rename", "a")).toContain("error: rename takes <old slug> <new slug>");
  expect(repo.usage("rename", "a", "Bad_Slug")).toContain('slug "Bad_Slug" must be lowercase');
  expect(repo.state("a").paths_slug).toBeUndefined();
});

test("a rename that fails is undone, so it changes nothing", () => {
  repo.ok("start", "first", "--workflow", "w");
  repo.ok("start", "second", "--workflow", "w", "--after", "first");
  repo.write(".konductor/decisions/first.md", "- a decision\n");
  // A lock file left behind by a killed process, on a workstream that names it.
  repo.write(".konductor/workstreams/second.yml.lock", "1\n");
  const out = repo.refused("rename", "first", "renamed");
  expect(out).toContain("another fuse-flow process holds");
  rmSync(join(repo.root, ".konductor/workstreams/second.yml.lock"));
  // The same, failing halfway: the referring state file cannot be written.
  const before = repo.read(".konductor/workstreams/second.yml");
  mkdirSync(join(repo.root, ".konductor/workstreams/second.yml.tmp"));
  const halfway = repo.refused("rename", "first", "renamed");
  expect(halfway).toContain("the rename of first to renamed failed:");
  expect(halfway).toContain("It was undone, so nothing changed");
  rmSync(join(repo.root, ".konductor/workstreams/second.yml.tmp"), { recursive: true });
  expect(existsSync(join(repo.root, ".konductor/workstreams/first.yml"))).toBe(true);
  expect(existsSync(join(repo.root, ".konductor/decisions/first.md"))).toBe(true);
  expect(existsSync(join(repo.root, ".konductor/workstreams/renamed.yml"))).toBe(false);
  expect(existsSync(join(repo.root, ".konductor/decisions/renamed.md"))).toBe(false);
  expect(repo.read(".konductor/workstreams/second.yml")).toBe(before);
  // Once the cause is gone, the rename works; an unknown slug with leftover
  // files of it is still refused, and never merged into another workstream.
  repo.ok("rename", "first", "renamed");
  expect(repo.state("second").after).toBe("renamed");
  repo.write(".konductor/debug/ghost.md", "a leftover log\n");
  expect(repo.refused("rename", "ghost", "second")).toContain('no workstream "ghost"');
  expect(existsSync(join(repo.root, ".konductor/debug/second.md"))).toBe(false);
});

test("a renamed workstream's checks get the slug its documents' paths use", () => {
  repo.write(
    ".konductor/workflows/paths.yml",
    "version: 1\nname: paths\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - script: test -f \".konductor/$FUSE_FLOW_PATH_SLUG/params.md\" && test \"$FUSE_FLOW_SLUG\" = after-rename\n",
  );
  repo.ok("start", "before-rename", "--workflow", "paths");
  repo.write(".konductor/before-rename/params.md");
  repo.ok("rename", "before-rename", "after-rename");
  const block = repo.ok("start", "after-rename");
  expect(block).toContain("FUSE_FLOW_SLUG=after-rename FUSE_FLOW_PATH_SLUG=before-rename FUSE_FLOW_STEP=build sh -c");
  expect(repo.ok("continue", "after-rename")).toContain("workflow complete");
});

// --------------------------------------------------------------------- move

test("a workstream copied to another checkout, as the README describes, resumes there at the same step", () => {
  repo.ok("start", "feat", "--workflow", "w");
  repo.write("docs/feat.md", "# spec\n");
  repo.write(".konductor/reviews/feat/draft-round-1.json", '{"findings": []}\n');
  repo.ok("continue", "feat");

  const other = new Repo();
  try {
    other.write(".konductor/workflows/w.yml", W);
    other.write("docs/feat.md", "# spec\n");
    mkdirSync(join(other.root, ".konductor/workstreams"), { recursive: true });
    cpSync(join(repo.root, ".konductor/workstreams/feat.yml"), join(other.root, ".konductor/workstreams/feat.yml"));
    cpSync(join(repo.root, ".konductor/reviews/feat"), join(other.root, ".konductor/reviews/feat"), { recursive: true });
    const out = other.ok("start", "feat");
    expect(out).toContain("resumed workstream feat");
    expect(out).toContain("STEP build");
    expect(other.ok("status", "feat")).toContain("docs/feat.md (done)");
    expect(other.ok("continue", "feat")).toContain("workflow complete");
  } finally {
    other.cleanup();
  }
});

test("a parent moved with its child, as the README describes, resumes with the child's progress", () => {
  repo.write(".konductor/workflows/parent.yml", PARENT);
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;
  repo.ok("start", child);
  repo.write(`docs/${child}.md`, "# spec\n");
  repo.ok("continue", child);

  const other = new Repo();
  try {
    other.write(".konductor/workflows/w.yml", W);
    other.write(".konductor/workflows/parent.yml", PARENT);
    other.write(`docs/${child}.md`, "# spec\n");
    mkdirSync(join(other.root, ".konductor/workstreams"), { recursive: true });
    for (const slug of ["top", child]) cpSync(join(repo.root, `.konductor/workstreams/${slug}.yml`), join(other.root, `.konductor/workstreams/${slug}.yml`));
    expect(other.ok("status", "top")).toContain(`waits for workstream ${child}, which is at step build (2 of 2)`);
    expect(other.ok("start", child)).toContain("STEP build");
  } finally {
    other.cleanup();
  }
});

// -------------------------------------------------------------------- close

test("the owner closes a workstream: start and continue refuse it with the reason, list and status show it", () => {
  repo.ok("start", "abandoned", "--workflow", "w");
  repo.ok("start", "alive", "--workflow", "w");
  const out = repo.ok("close", "abandoned", "--note", "the customer cancelled the feature");
  expect(out).toContain("closed workstream abandoned: the customer cancelled the feature\n");

  const reason = /closed by the owner on \d{4}-\d{2}-\d{2}: the customer cancelled the feature/;
  expect(repo.refused("start", "abandoned")).toMatch(reason);
  expect(repo.refused("start", "abandoned")).toContain("To work on it again, start a new workstream under another slug");
  expect(repo.refused("continue", "abandoned")).toMatch(reason);
  expect(repo.refused("continue", "abandoned", "--owner-approved")).toMatch(reason);
  expect(repo.ok("list")).toMatch(/\n {2}abandoned \(w, started \d{4}-\d{2}-\d{2}\): closed by the owner on \d{4}-\d{2}-\d{2}: the customer cancelled the feature\n/);
  expect(repo.ok("list")).toMatch(/\n {2}alive \(w, started [^)]*\): step draft, 1 of 2, IN_PROGRESS\n/);
  const status = repo.ok("status", "abandoned");
  expect(status).toMatch(reason);
  expect(status).toContain("workstream closed; start and continue refuse it");

  expect(repo.refused("close", "abandoned", "--note", "again")).toContain("was already closed on");
  expect(repo.usage("close", "alive")).toContain("error: close needs the owner's reason");
  expect(repo.refused("close", "nope", "--note", "x")).toContain('no workstream "nope"');
});

test("a parent step that waits for a closed child says so", () => {
  repo.write(".konductor/workflows/parent.yml", "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: x\n    gates:\n      - workflow: w\n");
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;
  repo.ok("close", child, "--note", "not needed after all");
  expect(repo.ok("status", "top")).toMatch(new RegExp(`waits for workstream ${child}, which was closed by the owner on [0-9-]+: not needed after all`));
});

const PARENT = "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: x\n    gates:\n      - workflow: w\n  - id: after\n    instruction: y\n";

test("a closed child that did not finish cannot satisfy its parent step; the parent offers the owner's ways on, and skipping keeps the child", () => {
  repo.write(".konductor/workflows/parent.yml", PARENT);
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;
  repo.ok("start", child);
  repo.ok("close", child, "--note", "not needed after all");

  const ways = `It cannot satisfy the step. The owner decides: skip this step with \`fuse-flow continue top --skip "<the owner's reason>"\`, or send the work back to it`;
  const start = repo.ok("start", "top");
  expect(start).toContain(`which the owner closed on`);
  expect(start).toContain(ways);
  expect(start).not.toContain(`First run it to its end`);
  const refusal = repo.refused("continue", "top");
  expect(refusal).toContain(ways);
  expect(refusal).not.toContain("Run it to its end");

  const skipped = repo.ok("continue", "top", "--skip", "the owner dropped the child's part");
  expect(skipped).toContain(`The child workstream ${child} stays as it is, closed by the owner, for the record.`);
  expect(repo.state(child).closed.reason).toBe("not needed after all");
});

test("an unstarted child that the owner closed is kept when the parent jumps past its step", () => {
  repo.write(".konductor/workflows/parent.yml", PARENT);
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;
  repo.ok("close", child, "--note", "never needed");
  repo.ok("continue", "top", "--forward-to", "after", "--note", "the owner jumped past it");
  expect(repo.state(child).closed.reason).toBe("never needed");
});

test("a child of a closed parent is told that the parent no longer waits for it", () => {
  repo.write(".konductor/workflows/parent.yml", PARENT);
  repo.ok("start", "top", "--workflow", "parent");
  const child = repo.state("top").steps.delegate.children[0].slug;
  repo.ok("close", "top", "--note", "the whole feature is cancelled");
  expect(repo.ok("status", child)).toMatch(/which no longer waits for it: workstream top was closed by the owner on [0-9-]+: the whole feature is cancelled/);
  repo.write(`docs/${child}.md`, "# spec\n");
  repo.ok("start", child);
  repo.ok("continue", child);
  const done = repo.ok("continue", child);
  expect(done).toContain("Step delegate of workstream top no longer waits for this workstream: workstream top was closed by the owner");
  expect(done).not.toContain("Go on there");
});

test("a closed workstream whose workflow is gone still shows its closure in list and status", () => {
  repo.write(".konductor/workflows/gone.yml", W.replace("name: w", "name: gone"));
  repo.ok("start", "old", "--workflow", "gone");
  repo.ok("close", "old", "--note", "superseded by the new design");
  rmSync(join(repo.root, ".konductor/workflows/gone.yml"));
  expect(repo.ok("list")).toMatch(/\n {2}old \(gone\): closed by the owner on [0-9-]+: superseded by the new design; its workflow cannot be read: /);
  const status = repo.ok("status", "old");
  expect(status).toMatch(/closed by the owner on [0-9-]+: superseded by the new design/);
  expect(status).toContain("workstream closed; start and continue refuse it");
});

test("a continue already running when the owner closes the workstream records nothing more", () => {
  // The step's check closes the workstream while continue runs it, as a
  // close from another session would.
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  repo.write(
    ".konductor/workflows/slow.yml",
    `version: 1\nname: slow\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - script: ${JSON.stringify(`"${process.execPath}" run "${cli}" close "$FUSE_FLOW_SLUG" --note "closed meanwhile"`)}\n  - id: next\n    instruction: y\n`,
  );
  repo.ok("start", "feat", "--workflow", "slow");
  const out = repo.refused("continue", "feat");
  expect(out).toMatch(/workstream feat was closed by the owner on [0-9-]+: closed meanwhile/);
  expect(out).not.toContain("STEP next");
  expect(repo.status("feat", "build")).toBe("IN_PROGRESS");
  expect(repo.status("feat", "next")).toBe("PENDING");
});

test("a check after the one that closed the workstream does not run", () => {
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  repo.write(
    ".konductor/workflows/two.yml",
    `version: 1\nname: two\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - script: ${JSON.stringify(`"${process.execPath}" run "${cli}" close "$FUSE_FLOW_SLUG" --note "closed meanwhile"`)}\n      - script: touch second-ran\n`,
  );
  repo.ok("start", "feat", "--workflow", "two");
  expect(repo.refused("continue", "feat")).toContain("closed meanwhile");
  expect(existsSync(join(repo.root, "second-ran"))).toBe(false);
});

test("a parent closed while its delegating step is handed out creates no child", () => {
  // The step's condition closes the parent, as a close from another session
  // would between handing out the step and creating its child.
  const cli = join(import.meta.dir, "..", "src", "cli.ts");
  repo.write(
    ".konductor/workflows/parent.yml",
    `version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: x\n    condition:\n      script: ${JSON.stringify(`"${process.execPath}" run "${cli}" close "$FUSE_FLOW_SLUG" --note "closed meanwhile"`)}\n    gates:\n      - workflow: w\n`,
  );
  expect(repo.refused("start", "top", "--workflow", "parent")).toContain("closed meanwhile");
  expect(repo.ok("list")).not.toContain("top-delegate");
});

// ------------------------------------------------------------ folder record

test("a produced folder recorded whole is listed by name and not counted among the files", () => {
  const F = `version: 1
name: f
steps:
  - id: build
    instruction: x
    produces:
      - artifact: notes
        path: research/
    updates:
      - artifact: code
        path: src/
`;
  repo.start("feat", F);
  repo.write("research/one.md");
  const files = ["a", "b", "c", "d", "e"].map((n) => `src/${n}.ts`);
  for (const f of files) repo.write(f);
  const out = repo.ok("continue", "feat", ...files.flatMap((f) => ["--updated", f]));
  expect(out).toContain("PRODUCED: build: research/ (new); 5 files under src/; summarize them");
});
