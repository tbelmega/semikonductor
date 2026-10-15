// SPDX-License-Identifier: Apache-2.0
// Writing a workstream records its project in ~/.konductor/projects.yml, so
// Komposer can show the runs of every project the user works in.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

const ONE_STEP = "version: 1\nname: one\nsteps:\n  - id: one\n    instruction: Do it.\n";

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

const projects = () => Bun.YAML.parse(repo.read("home/.konductor/projects.yml")) as { projects: string[] };

test("starting a workstream records its project once, by the repository root", () => {
  repo.write(".konductor/workflows/one.yml", ONE_STEP);
  mkdirSync(join(repo.root, "src", "deep"), { recursive: true });
  const r = repo.run(["start", "first", "--workflow", "one"], join(repo.root, "src", "deep"));
  expect(r.code).toBe(0);
  expect(projects().projects).toEqual([repo.root]);

  repo.ok("continue", "first");
  repo.ok("start", "second", "--workflow", "one");
  expect(projects().projects).toEqual([repo.root]);
  expect(repo.read("home/.konductor/projects.yml")).toStartWith("# Projects with fuse-flow workstreams");
});

test("a second repository is added after the first", () => {
  repo.write(".konductor/workflows/one.yml", ONE_STEP);
  repo.ok("start", "first", "--workflow", "one");
  const other = join(repo.root, "other");
  repo.write("other/.git/HEAD", "ref: refs/heads/main\n");
  repo.write("other/.konductor/workflows/one.yml", ONE_STEP);
  expect(repo.run(["start", "theirs", "--workflow", "one"], other).code).toBe(0);
  expect(projects().projects).toEqual([repo.root, realpathSync(other)]);
});

test("a broken projects file is reported and does not stop the workstream", () => {
  repo.write(".konductor/workflows/one.yml", ONE_STEP);
  repo.write("home/.konductor/projects.yml", "projects: {not: a list}\n");
  const r = repo.run(["start", "first", "--workflow", "one"]);
  expect(r.code).toBe(0);
  expect(r.out).toContain(`fuse-flow: could not add ${repo.root} to ${join(repo.root, "home/.konductor/projects.yml")}`);
  expect(repo.status("first", "one")).toBe("IN_PROGRESS");
  expect(repo.read("home/.konductor/projects.yml")).toBe("projects: {not: a list}\n");
});

test("commands that only read do not record the project", () => {
  repo.ok("list");
  expect(() => repo.read("home/.konductor/projects.yml")).toThrow();
});
