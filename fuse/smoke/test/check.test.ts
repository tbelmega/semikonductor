// SPDX-License-Identifier: Apache-2.0
// End-to-end tests for the mechanical smoke verdict. Each test builds a
// throwaway project, drives the real fuse-flow command line, then runs check.ts.

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SMOKE_DIR = resolve(import.meta.dir, "..");
const FLOW_CLI = resolve(SMOKE_DIR, "..", "flow", "src", "cli.ts");
const CHECK = join(SMOKE_DIR, "check.ts");

const WORKFLOW = `version: 1
name: tiny
steps:
  - id: prepare
    instruction: write the requirements
    produces:
      - artifact: requirements
        path: notes/{slug}.md
    gates:
      - owner-action: approve the requirements
  - id: research
    instruction: research only when needed
    condition:
      agent: the work needs research
    produces:
      - artifact: research-note
        path: research/{slug}.md
  - id: explain
    instruction: write a report when useful
    produces:
      - artifact: report
        path: reports/{slug}.md
  - id: update
    instruction: update the code
    updates:
      - artifact: code
        path: src/
  - id: verify
    instruction: verify the result
    gates:
      - check: default
      - script: test -f script-ok
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): { root: string; workflow: string; env: Record<string, string> } {
  const base = process.env.KIROCREW_SCRATCH ?? tmpdir();
  const root = realpathSync(mkdtempSync(join(base, "fuse-smoke-check-")));
  roots.push(root);
  mkdirSync(join(root, ".git"));
  const workflow = join(root, "tiny.yml");
  writeFileSync(workflow, WORKFLOW);
  writePolicy(root, "test -f check-ok");
  const env = { ...(process.env as Record<string, string>), HOME: join(root, "home") };
  return { root, workflow, env };
}

function writePolicy(root: string, command: string, artifactOverride = true): void {
  const artifact = artifactOverride ? "artifacts:\n  requirements:\n    path: records/{slug}/requirements.md\n" : "";
  write(root, ".konductor/policy-overrides.yml", `checks:\n  default: ${JSON.stringify(command)}\n${artifact}`);
}

function write(root: string, path: string, content = "x\n"): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function flow(root: string, env: Record<string, string>, ...args: string[]): void {
  const result = Bun.spawnSync(["bun", FLOW_CLI, ...args], { cwd: root, env });
  if (result.exitCode !== 0) throw new Error(`fuse-flow ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
}

function check(root: string, workflow: string, env: Record<string, string>): { code: number; out: string } {
  const result = Bun.spawnSync(["bun", CHECK, "--project", root, "--workflow", workflow], { cwd: root, env });
  return { code: result.exitCode ?? -1, out: `${result.stdout}${result.stderr}` };
}

function checkWithPolicy(
  root: string,
  workflow: string,
  policy: string,
  env: Record<string, string>,
): { code: number; out: string } {
  const args = ["bun", CHECK, "--project", root, "--workflow", workflow, "--policy", policy];
  const result = Bun.spawnSync(args, { cwd: root, env });
  return { code: result.exitCode ?? -1, out: `${result.stdout}${result.stderr}` };
}

function runToEnd(root: string, workflow: string, env: Record<string, string>): void {
  flow(root, env, "start", "hello", "--workflow", workflow);
  write(root, "records/hello/requirements.md");
  flow(root, env, "continue", "hello");
  flow(root, env, "continue", "hello", "--owner-approved", "--note", "looks fine");
  flow(root, env, "continue", "hello", "--skip", "the change is already understood");
  flow(root, env, "continue", "hello", "--not-produced", "report", "the code is self-explanatory");
  write(root, "src/a.ts");
  flow(root, env, "continue", "hello", "--updated", "src/a.ts");
  write(root, "check-ok");
  write(root, "script-ok");
  flow(root, env, "continue", "hello");
}

function stateFile(root: string): string {
  return join(root, ".konductor", "workstreams", "hello.yml");
}

function projectCopy(root: string, text: string): void {
  write(root, ".konductor/workflows/tiny.yml", text);
}

test("completed and reasoned skipped steps pass with approvals and skip notes", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const result = check(root, workflow, env);
  expect(result.out).toContain("prepare: owner approved: looks fine");
  expect(result.out).toContain("research: skipped: the change is already understood");
  expect(result.out).toContain("MECHANICAL: PASS");
  expect(result.code).toBe(0);
});

test("a workstream that stopped part way names unfinished states", () => {
  const { root, workflow, env } = project();
  flow(root, env, "start", "hello", "--workflow", workflow);
  const result = check(root, workflow, env);
  expect(result.out).toContain("prepare: not finished (IN_PROGRESS)");
  expect(result.out).toContain("research: not finished (PENDING)");
  expect(result.out).toContain("MECHANICAL: FAIL");
  expect(result.code).toBe(1);
});

test("a missing produces artifact fails at its policy-overridden slug path", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  rmSync(join(root, "records", "hello", "requirements.md"));
  const result = check(root, workflow, env);
  expect(result.out).toContain("prepare: missing artifact records/hello/requirements.md (requirements)");
  expect(result.code).toBe(1);
});

test("a produces artifact recorded as not produced needs no file", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  expect(readFileSync(stateFile(root), "utf8")).toContain("the code is self-explanatory");
  expect(check(root, workflow, env)).toMatchObject({ code: 0 });
});

test("an updates artifact without an updated file or unchanged reason fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const state = readFileSync(stateFile(root), "utf8");
  const named = /\n      - artifact: code\n        path: src\/a\.ts\n        kind: file\n[^\n]*\n[^\n]*/;
  expect(state).toMatch(named);
  writeFileSync(stateFile(root), state.replace(named, ""));
  const result = check(root, workflow, env);
  expect(result.out).toContain("update: update not accounted for src/ (code)");
  expect(result.code).toBe(1);
});

test("a state file of an earlier fuse-flow, with the named file in updated, still accounts for the updates artifact", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const state = readFileSync(stateFile(root), "utf8");
  // An earlier fuse-flow kept no `files` entries, only the bare `updated` list.
  const legacy = state
    .replace(/\n    files:\n(      [ -][^\n]*\n)+/g, "\n")
    .replace("\n  update:\n    status: COMPLETED\n", "\n  update:\n    status: COMPLETED\n    updated:\n      - src/a.ts\n");
  expect(legacy).not.toContain("files:");
  expect(legacy).toContain("    updated:\n      - src/a.ts\n");
  writeFileSync(stateFile(root), legacy);
  expect(check(root, workflow, env)).toMatchObject({ code: 0 });
});

test("a check gate is rerun through policy and fails when its binding fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  writePolicy(root, "false");
  const result = check(root, workflow, env);
  expect(result.out).toContain("verify: check default failed: false");
  expect(result.code).toBe(1);
});

test("an updates artifact with an unchanged reason passes", () => {
  const { root, workflow, env } = project();
  flow(root, env, "start", "hello", "--workflow", workflow);
  write(root, "records/hello/requirements.md");
  flow(root, env, "continue", "hello");
  flow(root, env, "continue", "hello", "--owner-approved", "--note", "looks fine");
  flow(root, env, "continue", "hello", "--skip", "the change is already understood");
  flow(root, env, "continue", "hello", "--not-produced", "report", "the code is self-explanatory");
  flow(root, env, "continue", "hello", "--unchanged", "code", "no code change was needed");
  write(root, "check-ok");
  write(root, "script-ok");
  flow(root, env, "continue", "hello");
  const result = check(root, workflow, env);
  expect(result.out).toContain("MECHANICAL: PASS");
  expect(result.code).toBe(0);
});

test("a check kind bound to none passes", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  writePolicy(root, "none");
  const result = check(root, workflow, env);
  expect(result.out).toContain("verify: check default is not configured in this project");
  expect(result.out).toContain("MECHANICAL: PASS");
  expect(result.code).toBe(0);
});

test("an unbound check kind fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  rmSync(join(root, ".konductor", "policy-overrides.yml"));
  const result = check(root, workflow, env);
  expect(result.out).toContain("verify: check default is unbound");
  expect(result.code).toBe(1);
});

test("a project with no workstream fails", () => {
  const { root, workflow, env } = project();
  const result = check(root, workflow, env);
  expect(result.out).toContain("no workstream");
  expect(result.code).toBe(1);
});

const PARENT = `version: 1
name: parent
hands_off_to: ./kid.yml
steps:
  - id: delegate
    instruction: let the child do the work
    gates:
      - workflow: ./kid.yml
        slug: "{slug}-kid"
`;
const KID = `version: 1
name: kid
steps:
  - id: work
    instruction: do the work
`;

test("a child workstream of a workflow gate and a workstream started after a hand-off do not fail the check", () => {
  const { root, env } = project();
  const parent = join(root, "parent.yml");
  writeFileSync(parent, PARENT);
  writeFileSync(join(root, "kid.yml"), KID);
  flow(root, env, "start", "hello", "--workflow", parent);
  flow(root, env, "start", "hello-kid");
  flow(root, env, "continue", "hello-kid");
  flow(root, env, "continue", "hello");
  flow(root, env, "start", "next", "--workflow", join(root, "kid.yml"), "--after", "hello");
  flow(root, env, "continue", "next");
  const result = check(root, parent, env);
  expect(result.out).toContain("workstream hello follows");
  expect(result.out).toContain("hello-kid");
  expect(result.out).toContain("next");
  expect(result.out).toContain("MECHANICAL: PASS");
  expect(result.code).toBe(0);
});

const DELEGATING = `version: 1
name: delegating
steps:
  - id: delegate
    instruction: let the child write its note
    gates:
      - workflow: ./note-kid.yml
        slug: "{slug}-kid"
  - id: finish
    instruction: finish the work
`;
const NOTE_KID = `version: 1
name: note-kid
steps:
  - id: work
    instruction: write the note
    produces:
      - artifact: note
        path: kid/{slug}.md
    gates:
      - script: test -f kid-ok
`;

function delegatingRun(root: string, env: Record<string, string>): string {
  const parent = join(root, "delegating.yml");
  writeFileSync(parent, DELEGATING);
  writeFileSync(join(root, "note-kid.yml"), NOTE_KID);
  flow(root, env, "start", "hello", "--workflow", parent);
  flow(root, env, "start", "hello-kid");
  write(root, "kid/hello-kid.md");
  write(root, "kid-ok");
  flow(root, env, "continue", "hello-kid");
  flow(root, env, "continue", "hello");
  flow(root, env, "continue", "hello");
  return parent;
}

test("the child workstream a completed workflow gate waited for is checked with the workstream under test", () => {
  const { root, env } = project();
  const parent = delegatingRun(root, env);
  const passing = check(root, parent, env);
  expect(passing.out).toContain("workstream hello-kid (child of hello, step delegate) follows");
  expect(passing.out).toContain("MECHANICAL: PASS");
  expect(passing.code).toBe(0);
  rmSync(join(root, "kid", "hello-kid.md"));
  rmSync(join(root, "kid-ok"));
  const result = check(root, parent, env);
  expect(result.out).toContain("hello-kid: work: missing artifact kid/hello-kid.md (note)");
  expect(result.out).toContain("hello-kid: work: script failed: test -f kid-ok");
  expect(result.out).toContain("MECHANICAL: FAIL");
  expect(result.code).toBe(1);
});

test("a completed workflow gate whose child workstream is missing fails", () => {
  const { root, env } = project();
  const parent = delegatingRun(root, env);
  rmSync(join(root, ".konductor", "workstreams", "hello-kid.yml"));
  const result = check(root, parent, env);
  expect(result.out).toContain("delegate: child workstream hello-kid is missing");
  expect(result.code).toBe(1);
});

test("an edited project copy of a child workflow fails", () => {
  const { root, env } = project();
  // The harness's copies live apart from the project's copies.
  const harness = join(root, "harness");
  mkdirSync(harness);
  writeFileSync(join(harness, "delegating.yml"), DELEGATING);
  writeFileSync(join(harness, "note-kid.yml"), NOTE_KID);
  write(root, ".konductor/workflows/delegating.yml", DELEGATING);
  write(root, ".konductor/workflows/note-kid.yml", NOTE_KID.replace("test -f kid-ok", "test -n edited"));
  flow(root, env, "start", "hello", "--workflow", "delegating");
  flow(root, env, "start", "hello-kid");
  write(root, "kid/hello-kid.md");
  flow(root, env, "continue", "hello-kid");
  flow(root, env, "continue", "hello");
  flow(root, env, "continue", "hello");
  const result = check(root, join(harness, "delegating.yml"), env);
  expect(result.out).toContain("differs from the workflow under test");
  expect(result.out).toContain("note-kid.yml");
  expect(result.code).toBe(1);
});

const SHIPPED_SEARCH = resolve(SMOKE_DIR, "..", "flow", "workflows", "konductor", "k-sop-comprehensive-search.yml");
const SEARCHING = `version: 1
name: searching
steps:
  - id: delegate
    instruction: let the shipped search workflow search
    gates:
      - workflow: k-sop-comprehensive-search
        slug: "{slug}-search"
`;

// A parent outside the project, as the harness's own file, whose child is a
// shipped workflow named by name; the project may override that name.
function searchingRun(root: string, env: Record<string, string>): string {
  const parent = join(root, "harness", "searching.yml");
  write(root, "harness/searching.yml", SEARCHING);
  flow(root, env, "start", "hello", "--workflow", parent);
  flow(root, env, "start", "hello-search");
  write(root, ".konductor/hello-search/search-results.md");
  flow(root, env, "continue", "hello-search");
  flow(root, env, "continue", "hello");
  return parent;
}

test("the child of a gate that names a shipped workflow is checked against the shipped workflow", () => {
  const { root, env } = project();
  const parent = searchingRun(root, env);
  expect(check(root, parent, env)).toMatchObject({ code: 0 });
  rmSync(join(root, ".konductor", "hello-search", "search-results.md"));
  const result = check(root, parent, env);
  expect(result.out).toContain("hello-search: search: missing artifact .konductor/hello-search/search-results.md (search-results)");
  expect(result.code).toBe(1);
});

test("a project override of a shipped child workflow fails, even when the parent is the harness's own file", () => {
  const { root, env } = project();
  const shipped = readFileSync(SHIPPED_SEARCH, "utf8");
  const declaration = "    produces:\n      - artifact: search-results\n        path: .konductor/{slug}/search-results.md\n";
  expect(shipped).toContain(declaration);
  write(root, ".konductor/workflows/k-sop-comprehensive-search.yml", shipped.replace(declaration, ""));
  const parent = join(root, "harness", "searching.yml");
  write(root, "harness/searching.yml", SEARCHING);
  flow(root, env, "start", "hello", "--workflow", parent);
  flow(root, env, "start", "hello-search");
  flow(root, env, "continue", "hello-search");
  flow(root, env, "continue", "hello");
  const result = check(root, parent, env);
  expect(result.out).toContain(`differs from the workflow under test ${SHIPPED_SEARCH}`);
  expect(result.out).toContain("MECHANICAL: FAIL");
  expect(result.code).toBe(1);
});

test("two unrelated workstreams fail the check", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  flow(root, env, "start", "other", "--workflow", workflow);
  const result = check(root, workflow, env);
  expect(result.out).toContain("expected one workstream that no other workstream started, found hello, other");
  expect(result.code).toBe(1);
});

test("an artifact path with {date} is checked at the workstream's start date", () => {
  const { root, env } = project();
  const workflow = join(root, "dated.yml");
  writeFileSync(
    workflow,
    "version: 1\nname: dated\nsteps:\n  - id: note\n    instruction: write a note\n    produces:\n      - artifact: note\n        path: notes/{date}-{slug}.md\n",
  );
  flow(root, env, "start", "hello", "--workflow", workflow);
  const started = /started: (\d{4}-\d{2}-\d{2})/.exec(readFileSync(stateFile(root), "utf8"))?.[1];
  expect(started).toBeDefined();
  write(root, `notes/${started}-hello.md`);
  flow(root, env, "continue", "hello");
  const result = check(root, workflow, env);
  expect(result.out).toContain("MECHANICAL: PASS");
  expect(result.code).toBe(0);
});

test("with --policy, a project policy that differs from the harness's copy fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const harnessPolicy = join(root, "harness.policy-overrides");
  writeFileSync(harnessPolicy, readFileSync(join(root, ".konductor", "policy-overrides.yml"), "utf8"));
  expect(checkWithPolicy(root, workflow, harnessPolicy, env)).toMatchObject({ code: 0 });
  writePolicy(root, "true");
  const result = checkWithPolicy(root, workflow, harnessPolicy, env);
  expect(result.out).toContain("differs from the policy under test");
  expect(result.code).toBe(1);
});

test("with --policy, a local policy file in the project fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const harnessPolicy = join(root, "harness.policy-overrides");
  writeFileSync(harnessPolicy, readFileSync(join(root, ".konductor", "policy-overrides.yml"), "utf8"));
  write(root, ".konductor/policy-overrides.local.yml", 'checks:\n  default: "true"\n');
  const result = checkWithPolicy(root, workflow, harnessPolicy, env);
  expect(result.out).toContain("policy-overrides.local.yml");
  expect(result.code).toBe(1);
});

test("a workstream that follows a different workflow fails", () => {
  const { root, workflow, env } = project();
  runToEnd(root, workflow, env);
  const other = join(root, "other.yml");
  writeFileSync(other, WORKFLOW.replace("name: tiny", "name: other"));
  const result = check(root, other, env);
  expect(result.out).toContain("differs from the workflow under test");
  expect(result.code).toBe(1);
});

test("an unchanged project copy of the workflow passes", () => {
  const { root, workflow, env } = project();
  projectCopy(root, WORKFLOW);
  runToEnd(root, "tiny", env);
  expect(check(root, workflow, env)).toMatchObject({ code: 0 });
});

test("an edited project copy of the workflow fails", () => {
  const { root, workflow, env } = project();
  const edited = WORKFLOW.replace("script: test -f script-ok", "script: test -f other-ok");
  projectCopy(root, edited);
  write(root, "other-ok");
  runToEnd(root, "tiny", env);
  const result = check(root, workflow, env);
  expect(result.out).toContain("differs from the workflow under test");
  expect(result.code).toBe(1);
});
