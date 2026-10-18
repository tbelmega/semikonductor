// SPDX-License-Identifier: Apache-2.0
// `fuse-flow validate`: checking workflow files without starting a workstream,
// one at a time or every file below a directory.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

const VALID = `version: 1
name: ok
steps:
  - id: only
    instruction: x
`;

const INVALID = `version: 1
name: broken
steps:
  - id: Only
    instruction: x
`;

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

test("validate . checks every workflow below the current directory, in nested and symlinked folders", () => {
  repo.write("flows/a.yml", VALID);
  repo.write("flows/personal/b.yaml", VALID);
  repo.write("shared/c.yml", VALID);
  symlinkSync(join(repo.root, "shared"), join(repo.root, "flows/team"));
  repo.write("flows/notes.md", "not a workflow\n");

  const r = repo.run(["validate", "."], join(repo.root, "flows"));
  expect(r.code).toBe(0);
  expect(r.out).toContain(`valid:   ${join(repo.root, "flows/a.yml")}`);
  expect(r.out).toContain(`valid:   ${join(repo.root, "flows/personal/b.yaml")}`);
  expect(r.out).toContain(`valid:   ${join(repo.root, "flows/team/c.yml")}`);
  expect(r.out).toContain("3 workflows valid");
  expect(r.out).not.toContain("notes.md");
});

test("one invalid workflow fails the run, names its problem, and every other file is still reported", () => {
  repo.write("flows/a.yml", VALID);
  repo.write("flows/z.yml", INVALID);

  const out = repo.refused("validate", "flows");
  expect(out).toContain("1 of 2 workflows are invalid");
  expect(out).toContain(`valid:   ${join(repo.root, "flows/a.yml")}`);
  expect(out).toContain(`invalid: ${join(repo.root, "flows/z.yml")} is not a valid workflow`);
  expect(out).toContain("steps.0.id: must be lowercase letters, digits and hyphens");
});

test("specific workflows are checked by path or by name, and an unknown one is reported", () => {
  repo.write("flows/a.yml", VALID);
  repo.write(".konductor/workflows/named.yml", VALID);

  const out = repo.ok("validate", "flows/a.yml", "named");
  expect(out).toContain(`valid:   ${join(repo.root, "flows/a.yml")}`);
  expect(out).toContain(`valid:   ${join(repo.root, ".konductor/workflows/named.yml")}`);
  expect(out).toContain("2 workflows valid");

  const missing = repo.refused("validate", "named", "nowhere", "flows/gone.yml");
  expect(missing).toContain("2 of 3 workflows are invalid");
  expect(missing).toContain('no workflow named "nowhere"');
  expect(missing).toContain(`no workflow at ${join(repo.root, "flows/gone.yml")}`);
});

test("validate at the repository root skips the workstream state files", () => {
  repo.write(".konductor/workflows/named.yml", VALID);
  repo.start("feat", VALID);
  expect(repo.read(".konductor/workstreams/feat.yml")).toContain("status:");

  const out = repo.ok("validate", ".");
  expect(out).not.toContain("workstreams");
  expect(out).toContain(`valid:   ${join(repo.root, ".konductor/workflows/named.yml")}`);
});

test("validate at the repository root skips fuse-flow's own files that are not workflows", () => {
  repo.write(".konductor/workflows/named.yml", VALID);
  repo.write(".konductor/policy-overrides.yml", "checks:\n  default: none\n");
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  max_rounds: 3\n");
  repo.write(".konductor/library/artifacts/spec/entry.yml", "description: A spec.\n");
  repo.write("home/.konductor/policy-overrides.yml", "checks:\n  default: none\n");

  const out = repo.ok("validate", ".");
  expect(out).toContain(`valid:   ${join(repo.root, ".konductor/workflows/named.yml")}`);
  expect(out).toContain("1 workflow valid");
});

test("validate needs at least one reference, and a directory without workflows is reported", () => {
  expect(repo.usage("validate")).toContain("validate takes workflow names, files or directories");
  mkdirSync(join(repo.root, "empty"));
  expect(repo.refused("validate", "empty")).toContain(`no .yml or .yaml files in ${join(repo.root, "empty")}`);
});

test("a workflow whose name differs from its file name is valid, with a warning that names the name start takes", () => {
  repo.write("flows/review.yml", VALID.replace("name: ok", "name: code-review"));
  const out = repo.ok("validate", "flows/review.yml");
  expect(out).toContain(`valid:   ${join(repo.root, "flows/review.yml")}`);
  // flows/ is not a folder fuse-flow looks names up in, so start takes this one by its path.
  expect(out).toContain(`  warning: name "code-review" differs from the file name; start this workflow by its path, ${join(repo.root, "flows/review.yml")}`);
});

test("the name warning names the reference start takes: the file name in a workflows folder, else the path", () => {
  repo.write(".konductor/workflows/review.yml", VALID.replace("name: ok", "name: code-review"));
  const named = repo.ok("validate", ".konductor/workflows/review.yml");
  expect(named).toContain('  warning: name "code-review" differs from the file name; fuse-flow finds the workflow by its file name, review');
  repo.ok("start", "s", "--workflow", "review");

  // Only .yml files are found by name.
  repo.write(".konductor/workflows/actual.yaml", VALID.replace("name: ok", "name: different"));
  const yaml = repo.ok("validate", ".konductor/workflows/actual.yaml");
  const path = join(repo.root, ".konductor/workflows/actual.yaml");
  expect(yaml).toContain(`  warning: name "different" differs from the file name; start this workflow by its path, ${path}; only .yml files are found by name`);
  repo.ok("start", "t", "--workflow", path);
});
