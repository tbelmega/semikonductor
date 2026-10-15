// SPDX-License-Identifier: Apache-2.0
// The user's list of projects that hold fuse-flow workstreams,
// ~/.konductor/projects.yml, so Komposer can show the runs of every project
// and not only of the one it was started on. fuse-flow adds a project each
// time it writes a workstream there; Komposer can add and remove projects.
// The list holds paths only: each run stays in its own project.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { FlowError } from "./errors.ts";
import { withLock } from "./lock.ts";
import { projectsFile } from "./project.ts";

const ProjectsSchema = z.object({ projects: z.array(z.string()).default([]) });

const HEADER =
  "# Projects with fuse-flow workstreams, so Komposer can show their runs.\n" +
  "# fuse-flow adds a project when it writes a workstream there.\n";

// The registered project roots, in the order they were added. No file means
// no projects.
export function readProjects(): string[] {
  const file = projectsFile();
  if (!existsSync(file)) return [];
  let yaml: unknown;
  try {
    yaml = YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new FlowError(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = ProjectsSchema.safeParse(yaml);
  if (!parsed.success) throw new FlowError(`${file} must hold a list of project paths under "projects:"`);
  return parsed.data.projects;
}

// Add a project root; true when it was not listed yet.
export function registerProject(root: string): boolean {
  const path = realpathSync(resolve(root));
  let added = false;
  change((projects) => {
    if (projects.includes(path)) return projects;
    added = true;
    return [...projects, path];
  });
  return added;
}

// Remove a project root; true when it was listed.
export function unregisterProject(root: string): boolean {
  const path = resolve(root);
  let removed = false;
  change((projects) => {
    const rest = projects.filter((p) => p !== path);
    removed = rest.length !== projects.length;
    return rest;
  });
  return removed;
}

function change(fn: (projects: string[]) => string[]): void {
  const file = projectsFile();
  mkdirSync(dirname(file), { recursive: true });
  withLock(`${file}.lock`, () => {
    const before = readProjects();
    const after = fn(before);
    if (after === before) return;
    writeFileSync(`${file}.tmp`, HEADER + YAML.stringify({ projects: after }));
    renameSync(`${file}.tmp`, file);
  });
}
