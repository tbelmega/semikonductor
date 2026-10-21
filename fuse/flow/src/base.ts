// SPDX-License-Identifier: Apache-2.0
// The workstream's base: the commit HEAD was at when the workstream started.
// A code review covers the commits from the base to HEAD. The base is found
// on a best-effort basis, because a rebase or a squash can rewrite it: an
// inexact review range is acceptable, a broken workflow is not. Nothing here
// ever refuses; with no git, or no commits, there is simply no base.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
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

// The patch id of a commit's change, which a rebase or cherry-pick keeps;
// undefined for a commit without one, such as a merge or an empty commit.
function patchId(root: string, sha: string): string | undefined {
  const diff = spawnSync("git", ["-C", root, "show", "--format=", sha], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (diff.status !== 0 || !diff.stdout) return undefined;
  const id = spawnSync("git", ["-C", root, "patch-id", "--stable"], { input: diff.stdout, encoding: "utf8" });
  return id.status === 0 ? id.stdout.split(" ")[0] || undefined : undefined;
}

const subjectOf = (root: string, sha: string) => git(root, ["log", "-1", "--format=%s", sha]) ?? "";

// HEAD now, to record as a new workstream's base.
export function currentBase(root: string): RecordedBase | undefined {
  if (!isRepoTop(root)) return undefined;
  const sha = git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return sha ? { sha, subject: subjectOf(root, sha) } : undefined;
}

// What makes the checkout a poor place to start a workstream in, each as a
// clause: uncommitted changes outside .konductor/, which the workstream's
// commits and reviews would mix with, and being on the branch a remote's HEAD
// points to, such as main, where the work would land unreviewed. A checkout
// git cannot report on counts too, so `checkout: refuse` never passes an
// unchecked one. None outside a git repository: a folder git says is not
// one, such as one whose .git is empty.
export function checkoutProblems(root: string): string[] {
  const top = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.error) return [`fuse-flow could not run git to check it: ${top.error.message}`];
  if (top.status !== 0) {
    const why = top.stderr.trim().split("\n")[0] || `git rev-parse exited with ${top.status}`;
    // Outside git means no repository metadata here: no .git, or an empty
    // .git folder. A .git with content that git cannot read, such as a
    // worktree pointer to a missing folder or a repository without its HEAD,
    // is a problem.
    const dotGit = join(root, ".git");
    const none = !existsSync(dotGit) || (statSync(dotGit).isDirectory() && readdirSync(dotGit).length === 0);
    return none ? [] : [`fuse-flow could not check it for uncommitted changes: ${why}`];
  }
  if (!isRepoTop(root)) return [];
  const problems: string[] = [];
  const status = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=normal"], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
  if (status.status !== 0 || status.error) {
    const why = status.error?.message ?? (status.stderr.trim().split("\n")[0] || `git status exited with ${status.status}`);
    problems.push(`fuse-flow could not check it for uncommitted changes: ${why}`);
  } else {
    const entries = status.stdout.split("\0");
    const outside = (path: string) => path !== ".konductor/" && !path.startsWith(".konductor/");
    const changed: string[] = [];
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      if (entry.length < 4) continue;
      const paths = [entry.slice(3)];
      // A rename or a copy, in either column, is followed by the path it
      // came from, which changed too.
      if ("RC".includes(entry[0]) || "RC".includes(entry[1])) paths.push(entries[(i += 1)] ?? "");
      const path = paths.find((p) => p && outside(p));
      if (path) changed.push(path);
    }
    if (changed.length) {
      const such = changed.slice(0, 3).join(", ");
      problems.push(`it has uncommitted changes outside .konductor/, in ${changed.length > 3 ? `${changed.length} paths such as ${such}` : such}`);
    }
  }
  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch) {
    const heads = (git(root, ["for-each-ref", "--format=%(refname)%00%(symref)", "refs/remotes/"]) ?? "").split("\n");
    for (const line of heads) {
      const [ref, target] = line.split("\0");
      const m = /^refs\/remotes\/(.+)\/HEAD$/.exec(ref ?? "");
      if (!m || !target?.startsWith(`refs/remotes/${m[1]}/`)) continue;
      if (target.slice(`refs/remotes/${m[1]}/`.length) === branch) {
        problems.push(`it is on branch ${branch}, which ${m[1]}/HEAD points to`);
        break;
      }
    }
  }
  return problems;
}

// The base to review from. In order: the recorded commit, when it is still in
// HEAD's history; else the newest commit in HEAD's history with the recorded
// subject that was written before the workstream started, which finds the base
// again after a rebase; else the newest commit made before the workstream
// started; else the first commit of the history.
export function resolveBase(root: string, ws: Workstream): ResolvedBase | undefined {
  if (!isRepoTop(root) || !git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) return undefined;
  const found = (sha: string, how: string): ResolvedBase => ({ sha, subject: subjectOf(root, sha), how });
  const rec = ws.base;
  // Git compares commit dates in whole seconds; the second before the start
  // keeps out commits made in the same second, after it.
  const since = startedAt(ws);
  const cutoff = since === undefined ? undefined : Math.floor(since / 1000) - 1;
  if (rec) {
    if (git(root, ["merge-base", "--is-ancestor", rec.sha, "HEAD"]) !== undefined) return found(rec.sha, "recorded when the workstream started");
    if (rec.subject) {
      // A rebase keeps each commit's author and author date, so the
      // workstream's own commits, written after it started, are told apart
      // from its base even when they share its message. Where the recorded
      // commit is still in the repository, as it is after a rebase until git
      // prunes it, its author and date must match too, which keeps out an
      // older commit with the same message brought in during the workstream.
      // Without it, a message that more than one commit has does not say
      // which one is the base; the earlier fallbacks below decide then.
      const identity = git(root, ["log", "-1", "--format=%an%x00%ae%x00%at", rec.sha]);
      const log = git(root, ["log", "--format=%H%x00%an%x00%ae%x00%at%x00%s", "HEAD"]) ?? "";
      const matches = log
        .split("\n")
        .map((line) => line.split("\0"))
        .filter(([, , , at, ...subject]) => subject.join("\0") === rec.subject && (cutoff === undefined || Number(at) <= cutoff));
      const same = identity === undefined ? (matches.length === 1 ? matches : []) : matches.filter((m) => m.slice(1, 4).join("\0") === identity);
      // Author times are whole seconds, so two commits can still share all of
      // it. Then the one with the recorded commit's patch is the base; else
      // the oldest, whose range is wider rather than missing work.
      const patch = same.length > 1 ? patchId(root, rec.sha) : undefined;
      const byPatch = patch ? same.filter((m) => patchId(root, m[0]) === patch) : [];
      const match = byPatch.length === 1 ? byPatch[0] : same.at(-1);
      if (match) return found(match[0], "found by its commit message; the history was rewritten since the workstream started");
    }
  }
  const lost = rec ? "the recorded base is no longer in the history" : "no base was recorded";
  const before = cutoff === undefined ? undefined : git(root, ["rev-list", "-1", `--before=@${cutoff}`, "HEAD"]);
  if (before) return found(before, `the newest commit made before the workstream started, because ${lost}`);
  // No commit predates the workstream, so the first commit holds its work
  // too, as when it started before the repository's first commit; a range
  // from that commit to HEAD would leave it out.
  const roots = (git(root, ["rev-list", "--max-parents=0", "HEAD"]) ?? "").split("\n").filter(Boolean);
  const first = roots.at(-1);
  return first
    ? found(first, `the first commit of the history, because ${lost} and no commit predates the workstream, so the review covers that first commit too`)
    : undefined;
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
