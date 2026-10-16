// SPDX-License-Identifier: Apache-2.0
// The workstream's base: the commit HEAD was at when the workstream started.
// A code review covers the commits from the base to HEAD. The base is found
// on a best-effort basis, because a rebase or a squash can rewrite it: an
// inexact review range is acceptable, a broken workflow is not. Nothing here
// ever refuses; with no git, or no commits, there is simply no base.

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import type { Workstream } from "./schemas/workstream.ts";

export interface RecordedBase {
  sha: string;
  subject: string;
}

export interface ResolvedBase {
  sha: string;
  subject: string;
  // How the base was found, for the agent; it never needs the owner.
  how: string;
}

// `git -C root <args>`, trimmed stdout, or undefined when git fails or is not
// installed.
function git(root: string, args: string[]): string | undefined {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

// Whether `root` is the top of its own git repository, rather than a folder
// inside some other repository.
function isRepoTop(root: string): boolean {
  const top = git(root, ["rev-parse", "--show-toplevel"]);
  if (!top) return false;
  try {
    return realpathSync(top) === realpathSync(root);
  } catch {
    return false;
  }
}

const subjectOf = (root: string, sha: string) => git(root, ["log", "-1", "--format=%s", sha]) ?? "";

// HEAD now, to record as a new workstream's base.
export function currentBase(root: string): RecordedBase | undefined {
  if (!isRepoTop(root)) return undefined;
  const sha = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return sha ? { sha, subject: subjectOf(root, sha) } : undefined;
}

// The base to review from. In order: the recorded commit, when it is still in
// HEAD's history; else the newest commit in HEAD's history with the recorded
// subject, which finds the base again after a rebase; else the newest commit
// made before the workstream started; else the first commit of the history.
export function resolveBase(root: string, ws: Workstream): ResolvedBase | undefined {
  if (!isRepoTop(root) || !git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) return undefined;
  const found = (sha: string, how: string): ResolvedBase => ({ sha, subject: subjectOf(root, sha), how });
  const rec = ws.base;
  if (rec) {
    if (git(root, ["merge-base", "--is-ancestor", rec.sha, "HEAD"]) !== undefined) return found(rec.sha, "recorded when the workstream started");
    if (rec.subject) {
      const log = git(root, ["log", "--format=%H%x00%s", "HEAD"]) ?? "";
      const match = log.split("\n").find((line) => line.slice(line.indexOf("\0") + 1) === rec.subject);
      if (match) return found(match.slice(0, match.indexOf("\0")), "found by its commit message; the history was rewritten since the workstream started");
    }
  }
  const lost = rec ? "the recorded base is no longer in the history" : "no base was recorded";
  // Git compares commit dates in whole seconds; the second before the start
  // keeps out commits made in the same second, after it.
  const since = startedAt(ws);
  const before = since === undefined ? undefined : git(root, ["rev-list", "-1", `--before=@${Math.floor(since / 1000) - 1}`, "HEAD"]);
  if (before) return found(before, `the newest commit made before the workstream started, because ${lost}`);
  const roots = (git(root, ["rev-list", "--max-parents=0", "HEAD"]) ?? "").split("\n").filter(Boolean);
  const first = roots.at(-1);
  return first ? found(first, `the first commit of the history, because ${lost} and no commit predates the workstream`) : undefined;
}

// When the workstream started, in milliseconds since the epoch: its earliest
// history line, else the start of its start date.
function startedAt(ws: Workstream): number | undefined {
  const times = Object.values(ws.steps)
    .flatMap((s) => s.history.map((h) => Date.parse(h.split(" ")[0])))
    .filter((t) => !Number.isNaN(t));
  if (times.length) return Math.min(...times);
  const day = ws.started ? Date.parse(`${ws.started}T00:00:00`) : Number.NaN;
  return Number.isNaN(day) ? undefined : day;
}
