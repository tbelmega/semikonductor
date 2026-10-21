// SPDX-License-Identifier: Apache-2.0
// The state of one workstream, .konductor/workstreams/<slug>.yml: where each
// step stands. Only fuse-flow writes it, and git ignores it.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { FlowError } from "./errors.ts";
import { withLock } from "./lock.ts";
import { decisionsDir, findWorkflow, isWorkflowPath, projectsFile, workstreamFile, workstreamsDir } from "./project.ts";
import { registerProject } from "./registry.ts";
import { type StepState, type Workstream, WorkstreamSchema } from "./schemas/workstream.ts";

export type { RecordedArtifact, StepState, StepStatus, Workstream, Written } from "./schemas/workstream.ts";

// A step the state file does not mention yet (for example one added to the
// workflow after `start`) is simply PENDING.
export function stateOf(ws: Workstream, stepId: string): StepState {
  // Object.hasOwn, not ??=: a step may be called "constructor".
  if (!Object.hasOwn(ws.steps, stepId)) {
    ws.steps[stepId] = { status: "PENDING", artifacts: [], history: [] };
  }
  return ws.steps[stepId];
}

export function workstreamExists(root: string, slug: string): boolean {
  return existsSync(workstreamFile(root, slug));
}

// The local date, YYYY-MM-DD.
export function localDate(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The day the workstream started. A state file written before `started`
// existed falls back to its earliest history line.
export function startedOn(ws: Workstream): string {
  if (ws.started) return ws.started;
  const stamps = Object.values(ws.steps)
    .flatMap((s) => s.history.map((h) => h.split(" ")[0]))
    .filter((t) => !Number.isNaN(Date.parse(t)))
    .sort();
  return localDate(stamps.length ? new Date(stamps[0]) : new Date());
}

export function readWorkstream(root: string, slug: string): Workstream {
  const path = workstreamFile(root, slug);
  if (!existsSync(path)) throw new FlowError(`no workstream "${slug}" in ${root}; run fuse-flow start ${slug} first`);
  let yaml: unknown;
  try {
    yaml = YAML.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new FlowError(`${path} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = WorkstreamSchema.safeParse(yaml);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(top level)"}: ${i.message}`);
    throw new FlowError(`${path} is not a valid workstream file; it is written by fuse-flow only:\n${issues.join("\n")}`);
  }
  // A workflow file inside the repository is recorded relative to its root,
  // so the workstream survives a move of the checkout; in memory it is
  // absolute, as start and the workflow gates name it.
  const ws = parsed.data;
  if (isWorkflowPath(ws.workflow) && !isAbsolute(ws.workflow)) ws.workflow = resolve(root, ws.workflow);
  return ws;
}

// The workflow as the state file records it: relative to the repository root
// when it is a file inside it, else as it is.
function recordedWorkflow(root: string, workflow: string): string {
  if (!isWorkflowPath(workflow) || !isAbsolute(workflow)) return workflow;
  const rel = relative(root, workflow);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) && isWorkflowPath(rel) ? rel : workflow;
}

// Read the state file, let `change` modify it, write it back. The lock makes
// the read and the write one step, so two fuse-flow processes working on the
// same workstream never overwrite each other's change. `initial` is the
// workstream to start from when the file does not exist yet.
//
// A closed workstream is refused, read under the lock, so a command that was
// already running when the owner closed it records nothing more and hands out
// no further work. Only `close` and `rename`, which keep the record, pass
// `evenClosed`.
export function updateWorkstream(
  root: string,
  slug: string,
  change: (ws: Workstream) => void,
  initial?: Workstream,
  evenClosed = false,
): void {
  prepareWorkstreamsDir(root);
  withLock(lockOf(root, slug), () => {
    const ws = initial && !workstreamExists(root, slug) ? initial : readWorkstream(root, slug);
    if (ws.closed && !evenClosed) throw closedError(slug, ws.closed);
    change(ws);
    writeState(root, slug, ws);
  });
  // Komposer finds the project's runs through this list. Recording it is not
  // part of the workstream's state, so a failure is reported, not fatal.
  try {
    registerProject(root);
  } catch (e) {
    process.stderr.write(`fuse-flow: could not add ${root} to ${projectsFile()}: ${(e as Error).message}\n`);
  }
}

export const lockOf = (root: string, slug: string) => `${workstreamFile(root, slug)}.lock`;

// Writes the state file. Callers hold its lock. A temporary file is renamed
// over the old one, so an interrupted write never leaves a half-written state
// file.
export function writeState(root: string, slug: string, ws: Workstream): void {
  const path = workstreamFile(root, slug);
  writeFileSync(`${path}.tmp`, YAML.stringify(WorkstreamSchema.parse({ ...ws, workflow: recordedWorkflow(root, ws.workflow) })));
  renameSync(`${path}.tmp`, path);
}

export function closedError(slug: string, closed: { date: string; reason: string }): FlowError {
  return new FlowError(
    `workstream ${slug} was closed by the owner on ${closed.date}: ${closed.reason}. To work on it again, start a new workstream under another slug`,
  );
}

// Workstream state, the reviewers' findings files and the decisions files are
// private to the engineer's checkout, so each directory carries its own
// .gitignore.
function prepareWorkstreamsDir(root: string): void {
  for (const dir of [workstreamsDir(root), join(root, ".konductor", "reviews"), decisionsDir(root)]) {
    mkdirSync(dir, { recursive: true });
    const gitignore = join(dir, ".gitignore");
    if (!existsSync(gitignore)) writeFileSync(gitignore, "*\n");
  }
}

export interface WorkstreamListing {
  slug: string;
  // The workflow file the workstream's `workflow` field resolves to now;
  // absent when it resolves to none, for example after a rename.
  workflowPath?: string;
  workstream?: Workstream;
  // Why the state file could not be read.
  error?: string;
}

// Every workstream in the project, by slug.
export function listWorkstreams(root: string): WorkstreamListing[] {
  const dir = workstreamsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".yml"))
    .sort()
    .map((name) => {
      const slug = name.slice(0, -".yml".length);
      let workstream: Workstream;
      try {
        workstream = readWorkstream(root, slug);
      } catch (e) {
        return { slug, error: (e as Error).message };
      }
      let workflowPath: string | undefined;
      try {
        const path = findWorkflow(root, workstream.workflow);
        workflowPath = existsSync(path) ? resolve(root, path) : undefined;
      } catch {
        workflowPath = undefined;
      }
      return { slug, workstream, ...(workflowPath ? { workflowPath } : {}) };
    });
}
