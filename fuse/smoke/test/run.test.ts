// SPDX-License-Identifier: Apache-2.0
// End-to-end tests for run.sh's setup and wrap-up, without any model. kiro-cli
// and opencode are stand-ins on PATH: the stand-in orchestrator runs the shell
// script a test gives it, or nothing, and opencode lists no sessions.

import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SMOKE_DIR = resolve(import.meta.dir, "..");
const CLONE = resolve(SMOKE_DIR, "..", "..");
const RUN_SH = join(SMOKE_DIR, "run.sh");
const FLOW_CLI = resolve(CLONE, "fuse", "flow", "src", "cli.ts");

const TINY = `version: 1
name: tiny
steps:
  - id: hello
    instruction: say hello
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Box {
  root: string;
  home: string;
  out: string;
  bin: string;
}

function box(): Box {
  const base = process.env.KIROCREW_SCRATCH ?? tmpdir();
  const root = realpathSync(mkdtempSync(join(base, "fuse-smoke-run-")));
  roots.push(root);
  const home = join(root, "home");
  const out = join(root, "runs");
  const bin = join(root, "bin");
  mkdirSync(home);
  mkdirSync(bin);
  writeFileSync(join(bin, "kiro-cli"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  writeFileSync(
    join(bin, "opencode"),
    '#!/bin/sh\nif [ "$1" = run ] && [ -n "${FAKE_ORCHESTRATOR:-}" ]; then exec sh "$FAKE_ORCHESTRATOR"; fi\n' +
      `if [ "$1" = db ]; then exec bun ${JSON.stringify(join(bin, "opencode-db.ts"))} "$2"; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  // Like opencode db <sql> --format json: the rows of the query against the
  // database in the role's home, or [] when there is no database yet.
  writeFileSync(
    join(bin, "opencode-db.ts"),
    'import { Database } from "bun:sqlite";\nimport { existsSync } from "node:fs";\n' +
      'const path = `${process.env.HOME}/.local/share/opencode/opencode.db`;\n' +
      "console.log(JSON.stringify(existsSync(path) ? new Database(path).query(process.argv[2]).all() : []));\n",
  );
  return { root, home, out, bin };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Runs run.sh; `orchestrator` is a shell script the stand-in orchestrator runs in <run>/orchestrator. */
function smoke(b: Box, args: string[], orchestrator?: string): { code: number; out: string; run?: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: b.home,
    PATH: `${b.bin}:${process.env.PATH}`,
  };
  delete env.XDG_CONFIG_HOME;
  if (orchestrator !== undefined) {
    const script = join(b.root, "orchestrator.sh");
    writeFileSync(script, orchestrator);
    env.FAKE_ORCHESTRATOR = script;
  }
  const result = Bun.spawnSync(["bash", RUN_SH, "--out", b.out, ...args], { env });
  const out = `${result.stdout}${result.stderr}`;
  const run = /^smoke run: (.*)$/m.exec(out)?.[1];
  return { code: result.exitCode ?? -1, out, run };
}

function tiny(b: Box, name = "tiny.yml"): string {
  const path = join(b.root, "workflows", name);
  write(path, TINY);
  return path;
}

/** Whether anything, a dangling symlink included, is at <path>. */
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

const pointer = (home: string) => join(home, ".konductor", "fuse-konductor-clone");

test("with OpenCode roles the user's clone pointer is never touched, and the fuse agent's home names this clone", () => {
  const b = box();
  write(pointer(b.home), "clone=/somewhere/else\n");
  const result = smoke(b, ["--workflow", tiny(b)]);
  expect(result.run).toBeDefined();
  expect(readFileSync(pointer(b.home), "utf8")).toBe("clone=/somewhere/else\n");
  expect(readFileSync(pointer(join(result.run!, "fuse-home")), "utf8")).toBe(`clone=${CLONE}\n`);
});

test("the OpenCode roles may not read the user's own ~/.konductor, so they use the copy that names this clone", () => {
  const b = box();
  const result = smoke(b, ["--workflow", tiny(b)]);
  expect(result.run).toBeDefined();
  for (const role of ["fuse-home", "orchestrator-home"]) {
    const config = join(result.run!, role, ".config", "opencode", "opencode.json");
    if (role === "orchestrator-home" && !existsSync(config)) continue;
    const permission = JSON.parse(readFileSync(config, "utf8")).permission;
    for (const tool of ["read", "external_directory"]) {
      for (const home of [b.home, realpathSync(b.home)]) {
        expect({ role, tool, rule: permission?.[tool]?.[`${home}/.konductor/*`] }).toEqual({ role, tool, rule: "deny" });
      }
    }
  }
});

test("an OpenCode role's cost includes its subagent sessions", () => {
  const b = box();
  // The stand-in orchestrator records a root session and the reviewer
  // subagent session it started, as opencode stores them.
  const dbScript = join(b.root, "make-db.ts");
  writeFileSync(
    dbScript,
    'import { Database } from "bun:sqlite";\nimport { mkdirSync } from "node:fs";\n' +
      "const dir = `${process.argv[2]}/.local/share/opencode`;\nmkdirSync(dir, { recursive: true });\n" +
      "const db = new Database(`${dir}/opencode.db`);\n" +
      'db.run("create table session (id text primary key, parent_id text)");\n' +
      'db.run("create table message (id text primary key, session_id text, data text)");\n' +
      "db.run(\"insert into session values ('root', null), ('child', 'root')\");\n" +
      "db.run(`insert into message values ('m1', 'root', '{\"role\":\"assistant\",\"cost\":0.25}'), " +
      "('m2', 'root', '{\"role\":\"user\"}'), ('m3', 'child', '{\"role\":\"assistant\",\"cost\":0.125}')`);\n",
  );
  const result = smoke(b, ["--workflow", tiny(b)], `bun ${JSON.stringify(dbScript)} "$PWD/../fuse-home"\n`);
  const summary = JSON.parse(readFileSync(join(result.run!, "summary.json"), "utf8"));
  expect(summary.usd_fuse).toBe(0.375);
});

test("with a Kiro CLI fuse agent the pointer names this clone during the run and is put back afterwards", () => {
  for (const before of ["clone=/somewhere/else\n", undefined]) {
    const b = box();
    if (before !== undefined) write(pointer(b.home), before);
    const seen = join(b.root, "seen");
    const result = smoke(
      b,
      ["--workflow", tiny(b), "--fuse-harness", "kiro", "--fuse-model", "some-model"],
      `cat ${JSON.stringify(pointer(b.home))} > ${JSON.stringify(seen)}\n`,
    );
    expect(result.run).toBeDefined();
    expect(readFileSync(seen, "utf8")).toBe(`clone=${CLONE}\n`);
    if (before === undefined) expect(existsSync(pointer(b.home))).toBe(false);
    else expect(readFileSync(pointer(b.home), "utf8")).toBe(before);
  }
});

test("overlapping Kiro CLI fuse runs keep the pointer on this clone until the last one exits", async () => {
  const b = box();
  write(pointer(b.home), "clone=/somewhere/else\n");
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: b.home,
    PATH: `${b.bin}:${process.env.PATH}`,
  };
  delete env.XDG_CONFIG_HOME;
  // Each stand-in orchestrator says it started, then waits until the test releases it.
  const marker = (name: string) => join(b.root, name);
  const start = (name: string) => {
    const script = join(b.root, `${name}.sh`);
    writeFileSync(
      script,
      `touch ${JSON.stringify(marker(`${name}-started`))}\n` +
        `i=0; while [ ! -f ${JSON.stringify(marker(`${name}-release`))} ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\n`,
    );
    return Bun.spawn(
      ["bash", RUN_SH, "--out", b.out, "--workflow", tiny(b), "--fuse-harness", "kiro", "--fuse-model", "some-model"],
      { env: { ...env, FAKE_ORCHESTRATOR: script }, stdout: "pipe", stderr: "pipe" },
    );
  };
  const until = async (name: string) => {
    for (let i = 0; i < 300 && !existsSync(marker(name)); i++) await Bun.sleep(100);
    expect(existsSync(marker(name))).toBe(true);
  };
  const a = start("a");
  await until("a-started");
  const b2 = start("b");
  await Bun.sleep(1000);
  // Run b waits for run a's lock instead of starting its orchestrator.
  expect(existsSync(marker("b-started"))).toBe(false);
  writeFileSync(marker("a-release"), "");
  await a.exited;
  await until("b-started");
  // Run b is still active, so the pointer must still name this clone.
  expect(readFileSync(pointer(b.home), "utf8")).toBe(`clone=${CLONE}\n`);
  writeFileSync(marker("b-release"), "");
  await b2.exited;
  expect(readFileSync(pointer(b.home), "utf8")).toBe("clone=/somewhere/else\n");
  expect(present(join(b.home, ".konductor", "fuse-smoke-pointer.lock"))).toBe(false);
}, 60000);

const lockOf = (home: string) => join(home, ".konductor", "fuse-smoke-pointer.lock");

test("a pointer lock left by a Kiro CLI run that was killed stops the next run with a message naming it", () => {
  const b = box();
  write(pointer(b.home), "clone=/the/killed/run\n");
  const lock = lockOf(b.home);
  const gone = Bun.spawnSync(["sh", "-c", "echo $$"]).stdout.toString().trim();
  symlinkSync(gone, lock);
  const seen = join(b.root, "seen");
  const result = smoke(
    b,
    ["--workflow", tiny(b), "--fuse-harness", "kiro", "--fuse-model", "some-model"],
    `touch ${JSON.stringify(seen)}\n`,
  );
  expect(result.code).toBe(1);
  expect(result.out).toContain(`run.sh: ${lock} names process ${gone}, which is no longer running`);
  expect(existsSync(seen)).toBe(false);
  // Nothing is changed: the killed run's lock and pointer stay for the user to check.
  expect(readlinkSync(lock)).toBe(gone);
  expect(readFileSync(pointer(b.home), "utf8")).toBe("clone=/the/killed/run\n");
});

// Stand-ins for ln and rm that hold a run when they are given the path in
// PAUSE_LN or PAUSE_RM: ln right after it has created it, rm right before it
// removes it. The test can
// then stop the run at that point, and release the stand-in with <root>/go.
function pausingTools(b: Box): void {
  for (const [tool, when] of [["ln", "after"], ["rm", "before"]] as const) {
    const real = Bun.which(tool);
    expect(real).not.toBeNull();
    const hold = `touch "$RACE_DIR/paused"\n  i=0; while [ ! -f "$RACE_DIR/go" ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done`;
    const pause = `PAUSE_${tool.toUpperCase()}`;
    const named = `named=no\nif [ -n "\${${pause}:-}" ] && [ ! -f "$RACE_DIR/paused" ]; then\n  for a in "$@"; do [ "$a" = "$${pause}" ] && named=yes; done\nfi\n`;
    writeFileSync(
      join(b.bin, tool),
      when === "after"
        ? `#!/bin/sh\n${named}${JSON.stringify(real)} "$@"; rc=$?\nif [ $rc -eq 0 ] && [ $named = yes ]; then\n  ${hold}\nfi\nexit $rc\n`
        : `#!/bin/sh\n${named}if [ $named = yes ]; then\n  ${hold}\nfi\nexec ${JSON.stringify(real)} "$@"\n`,
      { mode: 0o755 },
    );
  }
}

/** Starts run.sh with a stand-in orchestrator that waits for <root>/<name>-release. */
function starter(b: Box) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: b.home,
    PATH: `${b.bin}:${process.env.PATH}`,
    RACE_DIR: b.root,
  };
  delete env.XDG_CONFIG_HOME;
  delete env.PAUSE_LN;
  delete env.PAUSE_RM;
  const marker = (name: string) => join(b.root, name);
  const start = (name: string, extra: Record<string, string> = {}) => {
    const script = join(b.root, `${name}.sh`);
    writeFileSync(
      script,
      `touch ${JSON.stringify(marker(`${name}-started`))}\n` +
        `i=0; while [ ! -f ${JSON.stringify(marker(`${name}-release`))} ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done\n`,
    );
    return Bun.spawn(
      ["bash", RUN_SH, "--out", b.out, "--workflow", tiny(b), "--fuse-harness", "kiro", "--fuse-model", "some-model"],
      { env: { ...env, ...extra, FAKE_ORCHESTRATOR: script }, stdout: "pipe", stderr: "pipe" },
    );
  };
  const until = async (name: string, tenths = 300) => {
    for (let i = 0; i < tenths && !existsSync(marker(name)); i++) await Bun.sleep(100);
    return existsSync(marker(name));
  };
  // The exit code, or "running" when the run has not exited within ten seconds; then it is killed.
  const exitOf = async (run: ReturnType<typeof start>) => {
    const code = await Promise.race([run.exited, Bun.sleep(10000).then(() => "running" as const)]);
    if (code === "running") run.kill("SIGKILL");
    return code;
  };
  return { marker, start, until, exitOf };
}

// A run can be stopped right after it has created the pointer lock, before it
// has recorded that it did. SIGTERM still runs its exit cleanup, which removes
// the lock; SIGKILL leaves the lock, which then names the stopped run.
for (const signal of ["SIGTERM", "SIGKILL"] as const) {
  test(`a Kiro CLI run stopped by ${signal} right after it creates its pointer lock leaves ${signal === "SIGTERM" ? "nothing that blocks the next run" : "a lock that names it"}`, async () => {
    const b = box();
    const lock = lockOf(b.home);
    pausingTools(b);
    const { marker, start, until, exitOf } = starter(b);
    const stopped = start("stopped", { PAUSE_LN: lock });
    expect(await until("paused")).toBe(true);
    stopped.kill(signal);
    writeFileSync(marker("go"), "");
    const code = await stopped.exited;
    if (signal === "SIGTERM") expect(code).toBe(130);
    writeFileSync(marker("next-release"), "");
    const next = start("next");
    const nextCode = await exitOf(next);
    if (signal === "SIGTERM") {
      // A run that ran through ends with 1 here, as the stand-in fuse agent did nothing.
      expect(nextCode).not.toBe("running");
      expect(existsSync(marker("next-started"))).toBe(true);
      expect(present(lock)).toBe(false);
    } else {
      expect(nextCode).toBe(1);
      expect(existsSync(marker("next-started"))).toBe(false);
      expect(await new Response(next.stderr).text()).toContain(`run.sh: ${lock} names process ${stopped.pid}, which is no longer running`);
      expect(readlinkSync(lock)).toBe(String(stopped.pid));
    }
  }, 60000);
}

test("the removal of a killed run's pointer lock, still running after it, never removes another run's lock", async () => {
  const b = box();
  write(pointer(b.home), "clone=/somewhere/else\n");
  const lock = lockOf(b.home);
  pausingTools(b);
  const { marker, start, until, exitOf } = starter(b);
  // The run finishes, and is killed while its exit cleanup's rm is about to remove the lock.
  writeFileSync(marker("stopped-release"), "");
  const stopped = start("stopped", { PAUSE_RM: lock });
  expect(await until("paused")).toBe(true);
  stopped.kill("SIGKILL");
  await stopped.exited;
  // The rm outlives the run. No later run may take the lock while it is still pending.
  const next = start("next");
  expect(await exitOf(next)).toBe(1);
  expect(existsSync(marker("next-started"))).toBe(false);
  // The rm then removes the lock it was given, the killed run's, and the next run gets the pointer.
  writeFileSync(marker("go"), "");
  for (let i = 0; i < 100 && present(lock); i++) await Bun.sleep(100);
  expect(present(lock)).toBe(false);
  writeFileSync(marker("third-release"), "");
  const third = start("third");
  expect(await exitOf(third)).not.toBe("running");
  expect(existsSync(marker("third-started"))).toBe(true);
  expect(readFileSync(pointer(b.home), "utf8")).toBe("clone=/somewhere/else\n");
  expect(present(lock)).toBe(false);
}, 60000);

test("a .yaml workflow file is copied as <name>.yml with its policy and library, and the brief names the copy", () => {
  const b = box();
  const workflow = join(b.root, "workflows", "tiny.yaml");
  write(workflow, TINY);
  write(join(b.root, "workflows", "tiny.policy-overrides"), "checks:\n  default: none\n");
  write(join(b.root, "workflows", "tiny.library", "artifacts", "note", "guide.md"), "# note\n");
  const result = smoke(b, ["--workflow", workflow]);
  const run = result.run!;
  const project = join(run, "project");
  expect(readFileSync(join(project, ".konductor", "workflows", "tiny.yml"), "utf8")).toBe(TINY);
  expect(readFileSync(join(project, ".konductor", "policy-overrides.yml"), "utf8")).toBe("checks:\n  default: none\n");
  expect(existsSync(join(project, ".konductor", "library", "artifacts", "note", "guide.md"))).toBe(true);
  const brief = readFileSync(join(run, "orchestrator", "brief.md"), "utf8");
  expect(brief).toContain("Workflow under test: `tiny`");
  expect(brief).toContain(`\`${project}/.konductor/workflows/tiny.yml\``);
  const env = { ...(process.env as Record<string, string>), HOME: join(run, "fuse-home") };
  const start = Bun.spawnSync(["bun", FLOW_CLI, "start", "hello", "--workflow", "tiny"], { cwd: project, env });
  expect(start.exitCode).toBe(0);
});

test("the review guides and child workflows a non-shipped workflow names by relative path are copied with it", () => {
  const b = box();
  const dir = join(b.root, "workflows");
  write(
    join(dir, "main.yml"),
    `version: 1
name: main
hands_off_to: ./next/after.yml
steps:
  - id: write
    instruction: write it
    gates:
      - agent: review it
        guide: guides/review.md
  - id: delegate
    instruction: let the child do it
    gates:
      - workflow: ./sub/kid.yml
`,
  );
  write(join(dir, "guides", "review.md"), "# review\n");
  write(
    join(dir, "sub", "kid.yml"),
    "version: 1\nname: kid\nsteps:\n  - id: work\n    instruction: do it\n    gates:\n      - agent: review it\n        guide: kid-review.md\n",
  );
  write(join(dir, "sub", "kid-review.md"), "# kid review\n");
  write(join(dir, "next", "after.yml"), "version: 1\nname: after\nsteps:\n  - id: more\n    instruction: more\n");
  write(join(dir, "unrelated.md"), "not named by the workflow\n");
  const result = smoke(b, ["--workflow", join(dir, "main.yml")]);
  const copied = join(result.run!, "project", ".konductor", "workflows");
  for (const file of ["main.yml", "guides/review.md", "sub/kid.yml", "sub/kid-review.md", "next/after.yml"]) {
    expect(readFileSync(join(copied, file), "utf8")).toBe(readFileSync(join(dir, file), "utf8"));
  }
  expect(existsSync(join(copied, "unrelated.md"))).toBe(false);
  const validate = Bun.spawnSync(["bun", FLOW_CLI, "validate", copied], { cwd: join(result.run!, "project") });
  expect(`${validate.stdout}${validate.stderr}`).not.toContain("not found");
  expect(validate.exitCode).toBe(0);
});

test("a non-shipped workflow that names a file outside its own folder is refused before a run starts", () => {
  const b = box();
  const dir = join(b.root, "workflows", "mine");
  write(
    join(dir, "main.yml"),
    "version: 1\nname: main\nsteps:\n  - id: write\n    instruction: write it\n    gates:\n      - agent: review it\n        guide: ../review.md\n",
  );
  write(join(b.root, "workflows", "review.md"), "# review\n");
  const result = smoke(b, ["--workflow", join(dir, "main.yml")]);
  expect(result.code).toBe(64);
  expect(result.out).toContain("../review.md");
  expect(result.run).toBeUndefined();
});

test("a run that ends with no OpenCode session still writes summary.json", () => {
  const b = box();
  const result = smoke(b, ["--workflow", tiny(b)]);
  expect(result.code).toBe(1);
  const summary = JSON.parse(readFileSync(join(result.run!, "summary.json"), "utf8"));
  expect(summary.mechanical).toBe("FAIL");
  // opencode prints nothing when a role never started a session, so it cost nothing.
  expect(summary.usd_fuse).toBe(0);
});

test("the mechanical check reads the OpenCode fuse agent's home, not the user's", () => {
  const b = box();
  // A user policy that sets artifacts is refused; the fuse agent never saw it.
  write(join(b.home, ".konductor", "policy-overrides.yml"), "artifacts:\n  note:\n    path: x.md\n");
  const result = smoke(
    b,
    ["--workflow", tiny(b)],
    `cd ../project && HOME="$PWD/../fuse-home" bun ${JSON.stringify(FLOW_CLI)} start hello --workflow tiny >/dev/null &&
HOME="$PWD/../fuse-home" bun ${JSON.stringify(FLOW_CLI)} continue hello >/dev/null\n`,
  );
  const mechanical = readFileSync(join(result.run!, "mechanical.txt"), "utf8");
  expect(mechanical).not.toContain("sets artifacts");
  expect(mechanical).toContain("MECHANICAL: PASS");
});

test("a project policy the agent rebound fails the mechanical check", () => {
  const b = box();
  const workflow = tiny(b);
  write(join(b.root, "workflows", "tiny.policy-overrides"), 'checks:\n  default: "false"\n');
  const result = smoke(
    b,
    ["--workflow", workflow],
    `cd ../project && HOME="$PWD/../fuse-home" bun ${JSON.stringify(FLOW_CLI)} start hello --workflow tiny >/dev/null &&
HOME="$PWD/../fuse-home" bun ${JSON.stringify(FLOW_CLI)} continue hello >/dev/null &&
printf 'checks:\\n  default: "true"\\n' > .konductor/policy-overrides.yml\n`,
  );
  const mechanical = readFileSync(join(result.run!, "mechanical.txt"), "utf8");
  expect(mechanical).toContain("differs from the policy under test");
  expect(mechanical).toContain("MECHANICAL: FAIL");
});

test("a missing, non-numeric or zero numeric option is a usage error that starts no run", () => {
  const b = box();
  const workflow = tiny(b);
  for (const args of [
    ["--max-turns", "many"],
    ["--max-turns", "0"],
    ["--timeout-min", "1.5"],
    ["--turn-timeout-min", ""],
    ["--max-turns"],
    ["--out"],
  ]) {
    const result = smoke(b, ["--workflow", workflow, ...args]);
    expect({ args, code: result.code }).toEqual({ args, code: 64 });
  }
  expect(existsSync(b.out) ? readdirSync(b.out) : []).toEqual([]);
});
