// SPDX-License-Identifier: Apache-2.0
// The mechanical half of a smoke verdict. After a smoke run, it reads the
// project's workstream under test and confirms that every step finished, every
// artifact is accounted for, and every mechanical gate still passes. The
// workstream under test is the one no other workstream started. The child
// workstream each of its completed workflow gates waited for is checked the
// same way, and so are that child's own children, because a later step can
// still undo the child's work. Workstreams started after a hand-off, and the
// children of earlier passes of a step, are listed, not checked.
//
// usage: bun check.ts --project <dir> --workflow <workflow file> [--policy <policy file>]
// --policy names the harness's copy of the project policy the run started
// with; the project's policy must then still be that copy, so the agent
// cannot rebind a check to make it pass.
// Exit codes: 0 PASS, 1 FAIL, 64 usage error.

import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { childGate, childSlug } from "../flow/src/links.ts";
import { artifactPath, checkBinding, loadProject } from "../flow/src/policy.ts";
import { findWorkflow, isWorkflowPath, policyFiles, workflowFilesBelow, workstreamsDir } from "../flow/src/project.ts";
import { loadWorkflow, type Workflow } from "../flow/src/workflow.ts";
import { readWorkstream, startedOn, stateOf, type Workstream } from "../flow/src/workstream.ts";

function arg(name: string, optional = false): string | undefined {
  const i = process.argv.indexOf(name);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (!value && !(optional && i < 0)) {
    console.error("usage: bun check.ts --project <dir> --workflow <workflow file> [--policy <policy file>]");
    process.exit(64);
  }
  return value;
}

const project = resolve(arg("--project") as string);
const workflowPath = resolve(arg("--workflow") as string);
const policyArg = arg("--policy", true);
const policyPath = policyArg === undefined ? undefined : resolve(policyArg);
const failures: string[] = [];
const notes: string[] = [];

function finish(): never {
  for (const line of notes) console.log(line);
  for (const line of failures) console.log(`FAIL ${line}`);
  console.log(failures.length === 0 ? "MECHANICAL: PASS" : "MECHANICAL: FAIL");
  process.exit(failures.length === 0 ? 0 : 1);
}

// Whether `file` lies in the declared `path`, as an earlier fuse-flow decided it.
function contains(path: string, file: string): boolean {
  if (file.startsWith("/") || file === ".." || file.startsWith("../")) return false;
  const base = path.replace(/\/+$/, "").replace(/^\.\/+/, "");
  if (base === "" || base === ".") return true;
  return file === base || file.startsWith(`${base}/`);
}

function runGate(slug: string, at: string, stepId: string, label: string, command: string): void {
  const result = Bun.spawnSync(["sh", "-c", command], {
    cwd: project,
    env: { ...(process.env as Record<string, string>), FUSE_FLOW_SLUG: slug, FUSE_FLOW_STEP: stepId },
    stdout: "ignore",
    stderr: "ignore",
  });
  if (result.exitCode !== 0) failures.push(`${at}${stepId}: ${label} failed: ${command}`);
}

const dir = workstreamsDir(project);
const slugs = existsSync(dir)
  ? readdirSync(dir)
      .filter((file) => file.endsWith(".yml"))
      .map((file) => basename(file, ".yml"))
      .sort()
  : [];
if (slugs.length === 0) {
  failures.push(`no workstream in ${dir}`);
  finish();
}
// A workflow gate starts a child workstream, and an accepted hand-off starts
// one after the workstream under test; neither is the workstream under test.
const all = slugs.map((s) => ({ slug: s, ws: readWorkstream(project, s) }));
function startedBy(ws: Workstream): string | undefined {
  if (ws.parent) return `child of ${ws.parent.slug}, step ${ws.parent.step}`;
  if (ws.after && slugs.includes(ws.after)) return `started after ${ws.after}`;
  return undefined;
}
const roots = all.filter(({ ws }) => startedBy(ws) === undefined);
if (roots.length !== 1) {
  const found = (roots.length === 0 ? all : roots).map((r) => r.slug).join(", ");
  failures.push(`expected one workstream that no other workstream started, found ${found}`);
  finish();
}

const root = roots[0];
const followed = resolve(project, findWorkflow(project, root.ws.workflow));
// A fixture may be copied into the project, but the copy must remain byte for
// byte identical to the harness's workflow under test.
if (followed !== workflowPath && readFileSync(followed, "utf8") !== readFileSync(workflowPath, "utf8")) {
  failures.push(`workstream ${root.slug} follows ${followed}, which differs from the workflow under test ${workflowPath}`);
  finish();
}
// Likewise the policy the run started with: a check rebound in the project,
// or overridden by a local policy file, would otherwise rerun as the agent
// left it.
if (policyPath !== undefined) {
  const files = policyFiles(project);
  const current = existsSync(files.team) ? readFileSync(files.team, "utf8") : undefined;
  if (current !== readFileSync(policyPath, "utf8")) {
    failures.push(`${files.team} differs from the policy under test ${policyPath}`);
  }
  if (existsSync(files.local)) failures.push(`${files.local} overrides the policy under test ${policyPath}`);
  if (failures.length > 0) finish();
}

// The harness's own file for a child: the workflow its gate names in the
// harness's workflow. loadWorkflow resolves a gate's path against the
// harness's file; a name means the workflow that ships with this clone. The
// project's file for that child, a copy run.sh made or whatever a name
// resolves to there, must be that file or equal it byte for byte, or a
// project override could drop a step, an artifact or a gate. Returns
// undefined, with a failure, when it is not.
const shippedDir = resolve(import.meta.dir, "..", "flow", "workflows");
function harnessCopy(slug: string, ref: string, file: string): string | undefined {
  let own = ref;
  if (!isWorkflowPath(ref)) {
    const found = workflowFilesBelow(project, shippedDir).filter((path) => basename(path) === `${ref}.yml`);
    if (found.length !== 1) {
      failures.push(`workstream ${slug} follows workflow ${ref}, which ${found.length === 0 ? "does not ship" : "ships more than once"} in ${shippedDir}`);
      return undefined;
    }
    own = found[0];
  }
  if (!existsSync(own)) {
    failures.push(`workstream ${slug} follows ${file}, but the workflow under test ${own} does not exist`);
    return undefined;
  }
  if (realpathSync(own) !== realpathSync(file) && readFileSync(own, "utf8") !== readFileSync(file, "utf8")) {
    failures.push(`workstream ${slug} follows ${file}, which differs from the workflow under test ${own}`);
    return undefined;
  }
  return own;
}

const policy = loadProject(project);
const checked = new Set<string>();

// Checks one workstream against its workflow, then the child each of its
// completed workflow gates waited for. `at` prefixes a child's failures with
// its slug; the workstream under test has none.
function checkWorkstream(slug: string, workstream: Workstream, workflow: Workflow, at: string): void {
  checked.add(slug);
  const date = startedOn(workstream);
  for (const step of workflow.steps) {
    const state = stateOf(workstream, step.id);
    const finishedStep = state.status === "COMPLETED" || (state.status === "SKIPPED" && Boolean(state.skip_reason));
    if (!finishedStep) {
      const detail = state.status === "SKIPPED" ? "SKIPPED without a reason" : state.status;
      failures.push(`${at}${step.id}: not finished (${detail})`);
    }
    if (state.status === "SKIPPED" && state.skip_reason) {
      notes.push(`${at}${step.id}: skipped: ${state.skip_reason}`);
      continue;
    }
    if (state.rounds_granted) notes.push(`${at}${step.id}: owner granted ${state.rounds_granted} more review round(s)`);
    for (const line of state.history) {
      const approval = /owner approved.*$/.exec(line)?.[0];
      if (approval) notes.push(`${at}${step.id}: ${approval}`);
    }

    for (const artifact of step.produces) {
      const path = artifactPath(policy, artifact, slug, date);
      if (!(artifact.artifact in (state.not_produced ?? {})) && !existsSync(resolve(project, path))) {
        failures.push(`${at}${step.id}: missing artifact ${path} (${artifact.artifact})`);
      }
    }
    for (const artifact of step.updates) {
      const path = artifactPath(policy, artifact, slug, date);
      // A file the agent named with --updated in this pass; the whole updates
      // path is recorded from disk anyway, so it is no evidence of a revision.
      // A state file of an earlier fuse-flow has only the bare `updated` list.
      const updated =
        state.files === undefined
          ? (state.updated ?? []).some((file) => contains(path, file))
          : state.files.some((f) => f.artifact === artifact.artifact && f.kind === "file" && f.pass === "this");
      if (!updated && !(artifact.artifact in (state.unchanged ?? {}))) {
        failures.push(`${at}${step.id}: update not accounted for ${path} (${artifact.artifact})`);
      }
    }

    for (const gate of step.gates) {
      if (gate.kind === "script") {
        runGate(slug, at, step.id, "script", gate.text);
        continue;
      }
      if (gate.kind !== "check") continue;
      const binding = checkBinding(policy, gate.text);
      if (!binding) failures.push(`${at}${step.id}: check ${gate.text} is unbound`);
      else if (binding.command === "none") notes.push(`${at}${step.id}: check ${gate.text} is not configured in this project`);
      else runGate(slug, at, step.id, `check ${gate.text}`, binding.command);
    }

    // The child of the step's current pass, as fuse-flow records it.
    const gate = childGate(step);
    if (!gate || state.status !== "COMPLETED") continue;
    const pass = state.pass ?? 1;
    const child = state.children?.find((ch) => ch.pass === pass)?.slug ?? childSlug(gate, slug, step.id, pass);
    const found = all.find((w) => w.slug === child);
    if (!found || found.ws.parent?.slug !== slug || found.ws.parent.step !== step.id) {
      failures.push(`${at}${step.id}: child workstream ${child} is missing`);
      continue;
    }
    if (checked.has(child)) continue;
    const file = resolve(project, findWorkflow(project, found.ws.workflow));
    notes.push(`workstream ${child} (${startedBy(found.ws)}) follows ${file}`);
    const own = harnessCopy(child, gate.text, file);
    if (own !== undefined) checkWorkstream(child, found.ws, loadWorkflow(own), `${child}: `);
  }
}

notes.push(`workstream ${root.slug} follows ${followed}`);
checkWorkstream(root.slug, root.ws, loadWorkflow(workflowPath), "");
for (const { slug: other, ws } of all) {
  if (!checked.has(other)) notes.push(`workstream ${other} (${startedBy(ws)}) is not checked`);
}
finish();
