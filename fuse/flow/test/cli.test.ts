// SPDX-License-Identifier: Apache-2.0
// Mistakes on the command line, and state that is missing, broken or locked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

const WORKFLOW = `version: 1
name: w
steps:
  - id: only
    instruction: x
`;

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

test("help prints the usage", () => {
  expect(repo.ok("help")).toContain("usage:");
});

test("usage errors exit 64 and print the usage", () => {
  expect(repo.usage()).toContain("error: no command");
  expect(repo.usage("launch", "feat")).toContain('error: unknown command "launch"');
  expect(repo.usage("constructor", "feat")).toContain('error: unknown command "constructor"');
  expect(repo.usage("continue")).toContain("error: continue takes <slug>");
  expect(repo.usage("continue", "feat", "only")).toContain("error: continue takes <slug>");
  expect(repo.usage("status", "My_Feature")).toContain('slug "My_Feature" must be lowercase letters, digits and hyphens');
  expect(repo.usage("status", "feat", "--verbose")).toContain("--verbose");
  expect(repo.usage("start", "feat", "--workflow")).toContain("--workflow");
  expect(repo.usage("start", "feat", "--workflow=")).toContain("--workflow needs a value");
  expect(repo.usage("continue", "feat", "--updated=")).toContain("--updated needs a value");
  expect(repo.usage("continue", "feat", "--unchanged", "code")).toContain("--unchanged takes an artifact and a reason");
});

test("a flag that takes one value is refused when it is given twice, rather than the last one winning", () => {
  repo.write("a.yml", WORKFLOW);
  repo.write("b.yml", WORKFLOW);
  expect(repo.usage("start", "feat", "--workflow", "a.yml", "--workflow", "b.yml")).toContain("error: --workflow is given twice");
  expect(repo.usage("start", "feat", "--workflow", "a.yml", "--after", "x", "--after", "y")).toContain("error: --after is given twice");
  expect(repo.usage("continue", "feat", "--skip", "one", "--skip", "two")).toContain("error: --skip is given twice");
  expect(repo.usage("continue", "feat", "--blocked", "one", "--blocked=two")).toContain("error: --blocked is given twice");
  // A flag meant to be repeated still is.
  repo.start("feat", WORKFLOW);
  repo.write("x.txt");
  repo.write("y.txt");
  repo.ok("continue", "feat", "--updated", "x.txt", "--updated", "y.txt");
});

test("--more-rounds out of range is a usage error, not a crash", () => {
  const out = repo.usage("continue", "feat", "--more-rounds", "99999999999999999999");
  expect(out).toContain("error: --more-rounds takes a whole number of rounds, 1 or more and at most 100");
  expect(out).not.toContain("ZodError");
  expect(repo.usage("continue", "feat", "--more-rounds", "101")).toContain("at most 100");
});

test("a repository-relative path, as the step block prints it, is found from a subdirectory too", () => {
  repo.start(
    "feat",
    `version: 1
name: w
steps:
  - id: build
    instruction: x
    updates:
      - artifact: code
        path: src/
      - artifact: docs
        path: docs/
`,
  );
  repo.write("src/a.ts");
  repo.write("docs/guide.md");
  mkdirSync(join(repo.root, "sub"));
  const r = repo.run(["continue", "feat", "--updated", "src/a.ts", "--unchanged", "docs/", "only code changed"], join(repo.root, "sub"));
  expect(r.code).toBe(0);
  const files = repo.state("feat").steps.build.files.map((f: { path: string }) => f.path);
  expect(files).toContain("src/a.ts");
  expect(repo.state("feat").steps.build.unchanged).toEqual({ docs: "only code changed" });
});

test("start reads a relative --workflow and --input path from the repository root when the current directory has none", () => {
  repo.write("flows/w.yml", "version: 1\nname: w\ninputs:\n  - artifact: brief\nsteps:\n  - id: read\n    instruction: x\n    consumes: [brief]\n");
  repo.write("docs/brief.md");
  mkdirSync(join(repo.root, "sub"));
  const r = repo.run(["start", "feat", "--workflow", "flows/w.yml", "--input", "brief=docs/brief.md"], join(repo.root, "sub"));
  expect(r.code).toBe(0);
  expect(r.out).toContain("READ docs/brief.md (input brief).");
  expect(r.out).not.toContain("does not exist");
  // A path that exists in the current directory is still read from there.
  repo.write("sub/docs/brief.md");
  const here = repo.run(["start", "other", "--workflow", "flows/w.yml", "--input", "brief=docs/brief.md"], join(repo.root, "sub"));
  expect(here.code).toBe(0);
  expect(here.out).toContain("READ sub/docs/brief.md (input brief).");
});

test("a command on a workstream that was never started says to start it", () => {
  repo.start("feat", WORKFLOW);
  expect(repo.refused("continue", "other")).toContain("run fuse-flow start other first");
});

test("a state file that fuse-flow did not write is refused, not overwritten", () => {
  repo.start("feat", WORKFLOW);
  const edited = "steps:\n  only:\n    status: finished\n";
  repo.write(".konductor/workstreams/feat.yml", edited);
  expect(repo.refused("continue", "feat")).toContain("is not a valid workstream file");
  expect(repo.read(".konductor/workstreams/feat.yml")).toBe(edited);
});

test("an invalid state file is refused with the field that is wrong", () => {
  repo.start("feat", WORKFLOW);
  repo.write(".konductor/workstreams/feat.yml", repo.read(".konductor/workstreams/feat.yml").replace("IN_PROGRESS", "finished"));
  const out = repo.refused("continue", "feat");
  expect(out).toContain("is not a valid workstream file; it is written by fuse-flow only:\n  steps.only.status: ");
});

test("an option where a reason belongs is a usage error, not the reason", () => {
  repo.start("feat", `version: 1\nname: w\nsteps:\n  - id: only\n    instruction: x\n    updates: { artifact: code, path: src/ }\n    gates:\n      - owner-action: approve\n`);
  expect(repo.usage("continue", "feat", "--unchanged", "code", "--owner-approved")).toContain("--unchanged takes an artifact and a reason");
  expect(repo.usage("continue", "feat", "--not-produced", "code", "--skip=x")).toContain("--not-produced takes an artifact and a reason");
  expect(repo.status("feat", "only")).toBe("IN_PROGRESS");
  // A reason may still start with two dashes when it is more than an option.
  repo.ok("continue", "feat", "--unchanged", "code", "--force was not needed");
  expect(repo.state("feat").steps.only.unchanged).toEqual({ code: "--force was not needed" });
});

test("two starts of one new slug at once: one mints it, the other is refused instead of adding its steps", async () => {
  repo.write("a.yml", "version: 1\nname: a\nsteps:\n  - id: alpha\n    instruction: x\n");
  repo.write("b.yml", "version: 1\nname: b\nsteps:\n  - id: beta\n    instruction: x\n");
  // Both commands find no state file, then wait for the lock held here.
  const lock = repo.write(".konductor/workstreams/feat.yml.lock", "12345\n");
  const runs = [repo.runInBackground(["start", "feat", "--workflow", "a.yml"]), repo.runInBackground(["start", "feat", "--workflow", "b.yml"])];
  await Bun.sleep(1200);
  rmSync(lock);
  const results = await Promise.all(runs);
  expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
  const winner = results.findIndex((r) => r.code === 0);
  expect(Object.keys(repo.state("feat").steps)).toEqual([winner === 0 ? "alpha" : "beta"]);
  expect(results[1 - winner].out).toContain("REFUSED: workstream feat");
});

test("a state directory fuse-flow cannot write to is reported, not a crash", () => {
  repo.start("feat", WORKFLOW);
  chmodSync(join(repo.root, ".konductor/workstreams"), 0o555);
  try {
    const out = repo.refused("continue", "feat");
    expect(out).toContain("error: EACCES");
    expect(out).toContain("feat.yml.lock");
  } finally {
    chmodSync(join(repo.root, ".konductor/workstreams"), 0o755);
  }
});

test("a command waits for another process's lock, and names the file if it never goes away", () => {
  repo.start("feat", WORKFLOW);
  repo.write(".konductor/workstreams/feat.yml.lock", "12345\n");
  const out = repo.refused("continue", "feat");
  expect(out).toContain("another fuse-flow process holds");
  expect(out).toContain("feat.yml.lock; if none is running, delete that file");
  expect(repo.status("feat", "only")).toBe("IN_PROGRESS");
});

test("from a subdirectory, a deleted file and an absent artifact path are read from the repository root, as the step block prints them", () => {
  repo.write("src/deleted.ts");
  repo.start(
    "feat",
    `version: 1
name: w
steps:
  - id: build
    instruction: x
    updates:
      - artifact: code
        path: src/
    produces:
      - artifact: report
        path: reports/
`,
  );
  rmSync(join(repo.root, "src/deleted.ts"));
  mkdirSync(join(repo.root, "sub"));
  const r = repo.run(["continue", "feat", "--updated", "src/deleted.ts", "--not-produced", "reports/", "Not needed."], join(repo.root, "sub"));
  expect(r.out).not.toContain("REFUSED");
  expect(r.code).toBe(0);
  const state = repo.state("feat").steps.build;
  expect(state.files.map((f: { path: string }) => f.path)).toContain("src/deleted.ts");
  expect(state.not_produced).toEqual({ report: "Not needed." });
});

test("from a subdirectory, a deleted root file and a file whose folder was removed are read from the root, where the step's paths hold them", () => {
  repo.write("package-lock.json");
  repo.write("src/deleted.ts");
  repo.start(
    "feat",
    `version: 1
name: w
steps:
  - id: build
    instruction: x
    updates:
      - artifact: lock
        path: package-lock.json
      - artifact: code
        path: src/
`,
  );
  rmSync(join(repo.root, "package-lock.json"));
  rmSync(join(repo.root, "src"), { recursive: true });
  mkdirSync(join(repo.root, "sub"));
  const r = repo.run(["continue", "feat", "--updated", "package-lock.json", "--updated", "code=src/deleted.ts"], join(repo.root, "sub"));
  expect(r.out).not.toContain("REFUSED");
  expect(r.code).toBe(0);
  const paths = repo.state("feat").steps.build.files.map((f: { path: string }) => f.path);
  expect(paths).toContain("package-lock.json");
  expect(paths).toContain("src/deleted.ts");
});

test("from a subdirectory, a deleted root file in a step that updates the whole repository is read from the root when git tracks it there", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo.root, ...args], { env: repo.env });
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  expect(git("init", "-q").exitCode).toBe(0);
  repo.write("package-lock.json");
  repo.write("sub/keep.md");
  expect(git("add", "package-lock.json").exitCode).toBe(0);
  repo.start("feat", "version: 1\nname: w\nsteps:\n  - id: build\n    instruction: x\n    updates:\n      - artifact: code\n        path: .\n");
  rmSync(join(repo.root, "package-lock.json"));
  const r = repo.run(["continue", "feat", "--updated", "package-lock.json"], join(repo.root, "sub"));
  expect(r.out).not.toContain("REFUSED");
  expect(r.code).toBe(0);
  const paths = repo.state("feat").steps.build.files.map((f: { path: string }) => f.path);
  expect(paths).toContain("package-lock.json");
  expect(paths).not.toContain("sub/package-lock.json");
});

test("from a subdirectory, a committed root file whose deletion is staged is read from the root in a step that updates the whole repository", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo.root, "-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { env: repo.env });
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  expect(git("init", "-q").exitCode).toBe(0);
  repo.write("package-lock.json");
  repo.write("sub/keep.md");
  expect(git("add", "package-lock.json", "sub/keep.md").exitCode).toBe(0);
  expect(git("commit", "-q", "-m", "init").exitCode).toBe(0);
  repo.start("feat", "version: 1\nname: w\nsteps:\n  - id: build\n    instruction: x\n    updates:\n      - artifact: code\n        path: .\n");
  expect(git("rm", "-q", "package-lock.json").exitCode).toBe(0);
  const r = repo.run(["continue", "feat", "--updated", "package-lock.json"], join(repo.root, "sub"));
  expect(r.code).toBe(0);
  const paths = repo.state("feat").steps.build.files.map((f: { path: string }) => f.path);
  expect(paths).toContain("package-lock.json");
  expect(paths).not.toContain("sub/package-lock.json");
});
