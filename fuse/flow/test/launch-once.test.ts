// SPDX-License-Identifier: Apache-2.0
// The example launch wrapper next to the policy schema: it returns once the
// task's output file is written, whatever the output is, and leaves nothing
// of the task running.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FLOW_DIR } from "./helpers";

const WRAPPER = join(FLOW_DIR, "workflows", "schemas", "launch-once.sh");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "launch-once-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], grace = "1") {
  const started = Date.now();
  const proc = Bun.spawnSync(["bash", WRAPPER, ...args], { env: { ...process.env, LAUNCH_ONCE_GRACE: grace }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, err: proc.stderr.toString(), seconds: (Date.now() - started) / 1000 };
}

// Whether a process whose command line holds `tag` is still running.
const alive = (tag: string) => Bun.spawnSync(["pgrep", "-f", tag]).exitCode === 0;

test("a command that writes its output and keeps running is stopped after the grace, and the wrapper succeeds", () => {
  const out = join(dir, "verdict.txt");
  const marker = join(dir, "still-running");
  const r = run([out, "30", "bash", "-c", `echo pass > '${out}.tmp' && mv '${out}.tmp' '${out}'; sleep 20; touch '${marker}'`]);
  expect(r.code).toBe(0);
  expect(r.seconds).toBeLessThan(15);
  expect(existsSync(marker)).toBe(false);
});

test("a writer that pauses before publishing its output is not stopped", () => {
  const out = join(dir, "out.json");
  // It writes a part, pauses longer than the grace, then publishes the whole.
  const r = run([out, "30", "bash", "-c", `printf '{' > '${out}.tmp'; sleep 3; printf '}' >> '${out}.tmp'; mv '${out}.tmp' '${out}'`]);
  expect(r.code).toBe(0);
  expect(Bun.file(out).size).toBe(2);
});

test("a command that fails keeps its exit code, also after writing its output", () => {
  const out = join(dir, "out.json");
  expect(run([out, "30", "bash", "-c", "exit 3"]).code).toBe(3);
  expect(run([out, "30", "bash", "-c", `echo '{' > '${out}'; exit 5`]).code).toBe(5);
});

test("a command that exits 0 without writing its output fails with 1, and one that writes it succeeds", () => {
  const out = join(dir, "out.json");
  const silent = run([out, "30", "true"]);
  expect(silent.code).toBe(1);
  expect(silent.err).toContain("exited without writing");
  expect(run([out, "30", "bash", "-c", `echo '{}' > '${out}'`]).code).toBe(0);
});

test("a command that writes nothing in time is stopped with exit 124", () => {
  const r = run([join(dir, "out.json"), "2", "sleep", "30"]);
  expect(r.code).toBe(124);
  expect(r.seconds).toBeLessThan(15);
});

test("what the command left running when it exited is stopped", () => {
  const out = join(dir, "out.json");
  const tag = `launch-once-orphan-${process.pid}-${Date.now()}`;
  const r = run([out, "30", "bash", "-c", `echo '{}' > '${out}'; (exec -a ${tag} sleep 30) & exit 0`]);
  expect(r.code).toBe(0);
  expect(alive(tag)).toBe(false);
});

test("stopping the wrapper stops the command", async () => {
  const tag = `launch-once-cancel-${process.pid}-${Date.now()}`;
  const proc = Bun.spawn(["bash", WRAPPER, join(dir, "out.json"), "60", "bash", "-c", `exec -a ${tag} sleep 60`], { stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 50 && !alive(tag); i++) await Bun.sleep(100);
  expect(alive(tag)).toBe(true);
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(143);
  expect(alive(tag)).toBe(false);
});

test("an output file that exists already is refused, so an earlier output is not taken for this one", () => {
  const out = join(dir, "out.json");
  writeFileSync(out, "{}\n");
  expect(run([out, "30", "true"]).code).toBe(2);
  expect(run([out]).code).toBe(64);
  expect(run([join(dir, "new.json"), "soon", "true"]).code).toBe(64);
});
