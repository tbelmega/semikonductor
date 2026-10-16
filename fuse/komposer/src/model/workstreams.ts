// SPDX-License-Identifier: Apache-2.0
// The Workstreams page as data: the workstreams of each listed project,
// newest first with every child right after its parent, optionally only
// those of one workflow; the one-line summaries the rail and the left lane
// show; and the links between workstreams that the detail offers.

// The fields of a workstream and a project this file reads, as the server's
// /api/workstreams and /api/projects give them.
export interface WorkstreamSummary {
  project: string;
  slug: string;
  workflowPath?: string;
  after?: string;
  parent?: { slug: string; step: string };
  startedAfter?: string[];
  children?: { step: string; pass: number; slug: string }[];
  summary?: {
    status: string;
    currentStep?: string;
    started?: string;
    lastEvent?: string;
    ownerWaitMs: number;
    routesBack: { time: string; from: string; to: string }[];
  };
}

export interface ProjectSummary {
  path: string;
  // The project's own workflow folder.
  workflowsDir?: string;
  missing?: boolean;
  // Why the project's workstreams cannot be read.
  error?: string;
}

export type RunState = "PENDING" | "IN_PROGRESS" | "AWAITING_OWNER" | "BLOCKED" | "COMPLETED" | "SKIPPED";
const STATES: RunState[] = ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED", "COMPLETED", "SKIPPED"];

export function runState(value?: string): RunState {
  return STATES.includes(value as RunState) ? (value as RunState) : "PENDING";
}

export function duration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h${minutes % 60 ? ` ${minutes % 60}m` : ""}`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

// From the start to the last event when completed, else to now.
export function runDuration(run: WorkstreamSummary, now = Date.now()): number {
  const start = Date.parse(run.summary?.started ?? "");
  if (Number.isNaN(start)) return 0;
  const completed = run.summary?.status === "COMPLETED";
  const end = completed ? Date.parse(run.summary?.lastEvent ?? "") : now;
  return Math.max(0, (Number.isNaN(end) ? now : end) - start);
}

export const workstreamKey = (w: Pick<WorkstreamSummary, "project" | "slug">): string => `${w.project}/${w.slug}`;

export interface WorkstreamRow<W extends WorkstreamSummary = WorkstreamSummary> {
  workstream: W;
  // How many parents above it are listed too: 0 for a top-level row.
  depth: number;
}

export interface ProjectGroup<P extends ProjectSummary = ProjectSummary, W extends WorkstreamSummary = WorkstreamSummary> {
  project: P;
  // Every workstream of the project, whatever the filter.
  total: number;
  rows: WorkstreamRow<W>[];
}

const startedAt = (w: WorkstreamSummary) => {
  const t = Date.parse(w.summary?.started ?? "");
  return Number.isNaN(t) ? -Infinity : t;
};

// Newest started first; a child follows its parent when the parent is in the
// list too, and is otherwise listed where its own start puts it.
export function orderWorkstreams<W extends WorkstreamSummary>(list: W[]): WorkstreamRow<W>[] {
  const sorted = [...list].sort((a, b) => startedAt(b) - startedAt(a) || a.slug.localeCompare(b.slug));
  const listed = new Set(sorted.map(workstreamKey));
  const parentKey = (w: W) => (w.parent ? workstreamKey({ project: w.project, slug: w.parent.slug }) : null);
  const childrenOf = new Map<string, W[]>();
  const roots: W[] = [];
  for (const w of sorted) {
    const parent = parentKey(w);
    if (parent && parent !== workstreamKey(w) && listed.has(parent)) childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), w]);
    else roots.push(w);
  }
  const out: WorkstreamRow<W>[] = [];
  const seen = new Set<string>();
  const visit = (w: W, depth: number) => {
    const key = workstreamKey(w);
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ workstream: w, depth });
    for (const child of childrenOf.get(key) ?? []) visit(child, depth + 1);
  };
  roots.forEach((w) => visit(w, 0));
  // A cycle of parents has no root; its members are listed at the top level.
  sorted.forEach((w) => visit(w, 0));
  return out;
}

// The projects in their listed order, each with its workstreams; with a
// workflow path, only the workstreams that follow that file.
export function groupByProject<P extends ProjectSummary, W extends WorkstreamSummary>(
  projects: P[],
  workstreams: W[],
  workflowPath: string | null,
): ProjectGroup<P, W>[] {
  return projects.map((project) => {
    const own = workstreams.filter((w) => w.project === project.path);
    const shown = workflowPath === null ? own : own.filter((w) => w.workflowPath === workflowPath);
    return { project, total: own.length, rows: orderWorkstreams(shown) };
  });
}

// "1 step", "2 steps".
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// A project divider's count: all of them, or how many of them follow the
// selected workflow.
export function projectCount(group: ProjectGroup, filtered: boolean): string {
  if (group.project.missing) return "folder not found";
  if (group.project.error) return "workstreams cannot be read";
  return filtered ? `${group.rows.length} of ${plural(group.total, "workstream")}` : plural(group.total, "workstream");
}

export const isActive = (w: WorkstreamSummary) => w.summary?.status !== "COMPLETED";

// A workflow's row in the left lane on the Workstreams page.
export function laneCount(workflowPath: string, workstreams: WorkstreamSummary[]): { text: string; count: number } {
  const own = workstreams.filter((w) => w.workflowPath === workflowPath);
  if (!own.length) return { text: "no workstreams", count: 0 };
  const active = own.filter(isActive).length;
  return { text: `${plural(own.length, "workstream")}${active ? ` · ${active} active` : ""}`, count: own.length };
}

export const stateOf = (w: WorkstreamSummary): RunState => runState(w.summary?.status);

// Under the state pill of a rail row: where it is and for how long, or how
// long it took.
export function rowTiming(w: WorkstreamSummary, now = Date.now()): string {
  const time = duration(runDuration(w, now));
  if (stateOf(w) === "COMPLETED") return `took ${time}`;
  return w.summary?.currentStep ? `at ${w.summary.currentStep} · ${time}` : time;
}

export interface WorkstreamLink {
  // The words before the link, such as "started after".
  label: string;
  slug: string;
}

// The workstreams one is linked to, all in its own project: its parent, the
// one it was started after, its children and the ones started after it.
export function workstreamLinks(w: WorkstreamSummary, all: WorkstreamSummary[]): WorkstreamLink[] {
  const same = all.filter((x) => x.project === w.project && x.slug !== w.slug);
  const out: WorkstreamLink[] = [];
  if (w.parent) out.push({ label: `child of step ${w.parent.step} of`, slug: w.parent.slug });
  if (w.after) out.push({ label: "started after", slug: w.after });
  const children = [
    ...(w.children ?? []).map((c) => c.slug),
    ...same.filter((x) => x.parent?.slug === w.slug).map((x) => x.slug),
  ];
  [...new Set(children)].forEach((slug) => out.push({ label: "child workstream", slug }));
  const followers = [...(w.startedAfter ?? []), ...same.filter((x) => x.after === w.slug).map((x) => x.slug)];
  [...new Set(followers)].forEach((slug) => out.push({ label: "followed by", slug }));
  return out;
}

// The workflow folder in which the workflow references of a workstream's
// workflow (its workflow gates and hand-offs) are looked up by name: that of
// the workstream's own project, as fuse-flow looks them up when it runs the
// workstream. `fallback` is used when Komposer does not list the project.
export function workstreamLinkDir(w: Pick<WorkstreamSummary, "project">, projects: Pick<ProjectSummary, "path" | "workflowsDir">[], fallback: string): string {
  return projects.find((p) => p.path === w.project)?.workflowsDir ?? fallback;
}

// The four figures at the top of a workstream's summary.
export function workstreamStats(w: WorkstreamSummary, now = Date.now()): { label: string; value: string }[] {
  const s = w.summary;
  const done = stateOf(w) === "COMPLETED";
  const back = s?.routesBack ?? [];
  return [
    { label: "at step", value: done ? "done" : (s?.currentStep ?? "not started") },
    { label: done ? "took" : "running for", value: duration(runDuration(w, now)) },
    { label: "waited for owner", value: duration(s?.ownerWaitMs ?? 0) },
    { label: "sent back", value: back.length ? back.map((b) => `${b.from} → ${b.to}`).join(", ") : "never" },
  ];
}

// The figures of one step of a workstream: time working, time waiting for
// the owner, visits, and why it was skipped.
export function stepTiming(
  step: { activeMs: number; ownerWaitMs: number; visits: number; skipReason?: string } | undefined,
  working = "",
): string {
  if (!step) return "";
  return [
    step.activeMs ? `${duration(step.activeMs)}${working}` : "",
    step.ownerWaitMs ? `owner ${duration(step.ownerWaitMs)}` : "",
    step.visits > 1 ? `×${step.visits} visits` : "",
    step.skipReason ?? "",
  ]
    .filter(Boolean)
    .join(" · ");
}

// The steps a step was sent back to from, in the order it happened.
export function sentBackFrom(w: WorkstreamSummary, stepId: string): string[] {
  return [...new Set((w.summary?.routesBack ?? []).filter((b) => b.from === stepId).map((b) => b.to))];
}

// The child workstreams one step's workflow gate started, by pass: the
// newest is the one the step waits for now, the others are earlier passes,
// oldest first. Null when the step started none.
export function stepChildren(w: WorkstreamSummary, stepId: string): { current: string; earlier: string[] } | null {
  const own = (w.children ?? []).filter((c) => c.step === stepId).sort((a, b) => a.pass - b.pass);
  const last = own.at(-1);
  return last ? { current: last.slug, earlier: own.slice(0, -1).map((c) => c.slug) } : null;
}
