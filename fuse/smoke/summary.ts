// SPDX-License-Identifier: Apache-2.0
// Summarize a finished smoke run: wall-clock time, fuse agent turns, credits,
// and the verdicts. Writes <run>/summary.json and prints a short report.
//
// usage: bun summary.ts <run dir> <wall seconds> <orchestrator exit code>

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [run, wallArg, orchestratorExit] = process.argv.slice(2);
const env = Object.fromEntries(
  readFileSync(join(run, "run.env"), "utf8")
    .split("\n")
    .map((line) => /^([A-Z_]+)=(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => [m[1], m[2].replace(/^'(.*)'$/, "$1")]),
);

// The JSON value in a command's output, from its first `open` character on,
// after any banner the command printed; undefined when there is none or it
// does not parse, so a missing or broken record reads as unknown.
function jsonIn(text: string, open: string): unknown {
  const at = text.indexOf(open);
  if (at < 0) return undefined;
  try {
    return JSON.parse(text.slice(at));
  } catch {
    return undefined;
  }
}

const read = (name: string) => (existsSync(join(run, name)) ? readFileSync(join(run, name), "utf8") : "");
const turns = read("timings.tsv")
  .split("\n")
  .filter(Boolean)
  .map((line) => line.split("\t").map(Number));
const verdictLines = read("verdict.md").split("\n").map((line) => line.trim());
// The orchestrator's verdict has one line per layer; a missing or malformed
// line reads MISSING.
const layer = (name: string, values: string) =>
  verdictLines.map((line) => new RegExp(`^${name}: (${values})$`).exec(line)?.[1]).find(Boolean) ?? "MISSING";
const engine = layer("ENGINE", "PASS|FAIL");
const workflow = layer("WORKFLOW", "PASS|FAIL");
const guidance = layer("GUIDANCE", "PASS|FRICTION|FAIL");
const mechanical = /MECHANICAL: (PASS|FAIL)/.exec(read("mechanical.txt"))?.[1] ?? "MISSING";

// Credits are recorded per user turn in kiro-cli's session files. Sum every
// session kiro-cli lists for a directory; each role has a directory of its own.
function credits(dir: string): number | null {
  const r = Bun.spawnSync(["kiro-cli", "chat", "--list-sessions", "-f", "json"], { cwd: dir });
  if (r.exitCode !== 0) return null;
  const groups = jsonIn(r.stdout.toString(), "[") as { cwd: string; sessions: { sessionId: string }[] }[] | undefined;
  if (!Array.isArray(groups)) return null;
  let total = 0;
  for (const group of groups) {
    for (const { sessionId } of group.sessions ?? []) {
      const file = join(homedir(), ".kiro", "sessions", "cli", `${sessionId}.json`);
      if (!existsSync(file)) return null;
      const session = jsonIn(readFileSync(file, "utf8"), "{") as Record<string, any> | undefined;
      if (session === undefined) return null;
      const metas = session?.session_state?.conversation_metadata?.user_turn_metadatas ?? [];
      for (const meta of metas) for (const usage of meta.metering_usage ?? []) total += usage.value ?? 0;
    }
  }
  return Math.round(total * 1000) / 1000;
}

// opencode records a cost in US dollars on each assistant message; sum them
// over every session in the role's private home. The subagent sessions that
// run the reviews count too, and `opencode session list` shows only the
// sessions they started from, so the sum reads opencode's database.
function opencodeUsd(home: string, project: string): number | null {
  const procEnv = { ...(process.env as Record<string, string>), HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const query = "select coalesce(sum(json_extract(data, '$.cost')), 0) as usd from message";
  const r = Bun.spawnSync(["opencode", "db", query, "--format", "json"], { cwd: project, env: procEnv });
  if (r.exitCode !== 0) return null;
  const rows = jsonIn(r.stdout.toString(), "[") as { usd?: unknown }[] | undefined;
  if (!Array.isArray(rows)) return null;
  // No row means opencode has no database: the role never started a session.
  if (rows.length === 0) return 0;
  const usd = rows[0]?.usd;
  return typeof usd === "number" ? Math.round(usd * 10000) / 10000 : null;
}

const opencode = env.FUSE_HARNESS === "opencode";
const orchestratorOpencode = env.ORCHESTRATOR_HARNESS === "opencode";

const summary = {
  workflow: env.WORKFLOW,
  fuse_harness: env.FUSE_HARNESS ?? "kiro",
  fuse_model: env.FUSE_MODEL,
  orchestrator_harness: env.ORCHESTRATOR_HARNESS ?? "kiro",
  orchestrator_model: env.ORCHESTRATOR_MODEL,
  wall_seconds: Number(wallArg),
  orchestrator_exit: Number(orchestratorExit),
  fuse_turns: turns.length,
  fuse_seconds: turns.reduce((sum, t) => sum + (t[1] ?? 0), 0),
  fuse_turn_failures: turns.filter((t) => t[2] !== 0).length,
  credits_fuse: opencode ? null : credits(env.PROJECT),
  usd_fuse: opencode ? opencodeUsd(env.FUSE_HOME, env.PROJECT) : null,
  credits_orchestrator: orchestratorOpencode ? null : credits(join(run, "orchestrator")),
  usd_orchestrator: orchestratorOpencode ? opencodeUsd(join(run, "orchestrator-home"), join(run, "orchestrator")) : null,
  mechanical,
  verdict_engine: engine,
  verdict_workflow: workflow,
  verdict_guidance: guidance,
};
writeFileSync(join(run, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

const minutes = (s: number) => `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
console.log(`run:          ${run}`);
console.log(`workflow:     ${summary.workflow}`);
console.log(`models:       fuse ${summary.fuse_harness} ${summary.fuse_model}, orchestrator ${summary.orchestrator_harness} ${summary.orchestrator_model}`);
console.log(`wall clock:   ${minutes(summary.wall_seconds)} (fuse agent ${minutes(summary.fuse_seconds)} over ${summary.fuse_turns} turns)`);
const fuseCost = opencode ? `$${summary.usd_fuse ?? "unknown"}` : `${summary.credits_fuse ?? "unknown"} credits`;
const orchestratorCost = orchestratorOpencode
  ? `$${summary.usd_orchestrator ?? "unknown"}`
  : `${summary.credits_orchestrator ?? "unknown"} credits`;
console.log(`cost:         fuse ${fuseCost}, orchestrator ${orchestratorCost}`);
console.log(`MECHANICAL:   ${mechanical}`);
console.log(`ENGINE:       ${engine}`);
console.log(`WORKFLOW:     ${workflow}`);
console.log(`GUIDANCE:     ${guidance}`);
