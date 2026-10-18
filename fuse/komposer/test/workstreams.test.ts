// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  followsWorkflow,
  groupByProject,
  laneCount,
  orderWorkstreams,
  projectCount,
  rowTiming,
  sentBackFrom,
  stepChildren,
  stepTiming,
  workstreamLinkDir,
  workstreamLinks,
  workstreamStats,
  currentChildSlug,
  eventDetail,
  heldStep,
  orphanSteps,
  stateOf,
  workstreamProblem,
  type WorkstreamSummary,
} from "../src/model/workstreams.ts";
import { resolveWorkflowRef } from "../src/model/workflowLinks.ts";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-04T12:00:00Z");
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

function ws(project: string, slug: string, fields: Partial<WorkstreamSummary> & { started?: number; status?: string } = {}): WorkstreamSummary {
  const { started = 1, status = "IN_PROGRESS", ...rest } = fields;
  return {
    project,
    slug,
    workflowPath: `/wf/${slug}.yml`,
    summary: { status, started: at(started), lastEvent: at(started - 1), ownerWaitMs: 0, routesBack: [] },
    ...rest,
  };
}

const slugs = (rows: { workstream: WorkstreamSummary; depth: number }[]) => rows.map((r) => `${"  ".repeat(r.depth)}${r.workstream.slug}`);

describe("orderWorkstreams", () => {
  test("lists the newest first, and each child right after its parent", () => {
    const list = [
      ws("/p", "old", { started: 30 }),
      ws("/p", "new", { started: 2 }),
      ws("/p", "mid", { started: 10 }),
      ws("/p", "mid-review", { started: 1, parent: { slug: "mid", step: "review" } }),
      ws("/p", "mid-review-fix", { started: 0.5, parent: { slug: "mid-review", step: "fix" } }),
    ];
    expect(slugs(orderWorkstreams(list))).toEqual(["new", "mid", "  mid-review", "    mid-review-fix", "old"]);
  });

  test("a child whose parent is not listed, or is in another project, stands where its start puts it", () => {
    const list = [
      ws("/p", "a", { started: 5 }),
      ws("/p", "orphan", { started: 1, parent: { slug: "gone", step: "x" } }),
      ws("/q", "elsewhere", { started: 3, parent: { slug: "a", step: "x" } }),
    ];
    expect(slugs(orderWorkstreams(list))).toEqual(["orphan", "elsewhere", "a"]);
  });

  test("parents that point at each other are still listed once each", () => {
    const list = [
      ws("/p", "x", { started: 2, parent: { slug: "y", step: "s" } }),
      ws("/p", "y", { started: 1, parent: { slug: "x", step: "s" } }),
    ];
    expect(orderWorkstreams(list).map((r) => r.workstream.slug).sort()).toEqual(["x", "y"]);
  });
});

describe("groupByProject", () => {
  const projects = [{ path: "/p" }, { path: "/q" }, { path: "/gone", missing: true }];
  const all = [ws("/p", "a"), ws("/p", "b", { workflowPath: "/wf/shared.yml" }), ws("/q", "c", { workflowPath: "/wf/shared.yml" })];

  test("keeps the projects' order and counts every workstream of each", () => {
    const groups = groupByProject(projects, all, null);
    expect(groups.map((g) => [g.project.path, g.total, g.rows.length])).toEqual([["/p", 2, 2], ["/q", 1, 1], ["/gone", 0, 0]]);
    expect(groups.map((g) => projectCount(g, false))).toEqual(["2 workstreams", "1 workstream", "folder not found"]);
  });

  test("with a workflow, shows only the workstreams that follow its file, out of all of them", () => {
    const groups = groupByProject(projects, all, "/wf/shared.yml");
    expect(groups.map((g) => g.rows.map((r) => r.workstream.slug))).toEqual([["b"], ["c"], []]);
    expect(groups.map((g) => projectCount(g, true))).toEqual(["1 of 2 workstreams", "1 of 1 workstream", "folder not found"]);
  });

  test("a project whose workstreams cannot be read says so instead of a count", () => {
    const groups = groupByProject([{ path: "/bad", error: "EACCES" }], [], null);
    expect(groups.map((g) => projectCount(g, false))).toEqual(["workstreams cannot be read"]);
  });
});

describe("summaries", () => {
  test("a workflow's lane meta counts its workstreams and the ones not completed", () => {
    const list = [ws("/p", "a", { workflowPath: "/w.yml" }), ws("/p", "b", { workflowPath: "/w.yml", status: "COMPLETED" })];
    expect(laneCount("/w.yml", list)).toEqual({ text: "2 workstreams · 1 active", count: 2 });
    expect(laneCount("/w.yml", [list[1]])).toEqual({ text: "1 workstream", count: 1 });
    expect(laneCount("/other.yml", list)).toEqual({ text: "no workstreams", count: 0 });
  });

  test("a workstream follows a workflow reached through a link: by the real path both lead to", () => {
    // Personal workflows is a link to /shared/workflows; the run recorded the
    // physical path, the editable entry is listed under the link's path.
    const run = ws("/p", "a", { workflowPath: "/shared/workflows/parent.yml" });
    const alias = { path: "/home/.konductor/workflows/parent.yml", realPath: "/shared/workflows/parent.yml" };
    expect(followsWorkflow(run, alias)).toBe(true);
    expect(laneCount(alias, [run])).toEqual({ text: "1 workstream · 1 active", count: 1 });
    expect(groupByProject([{ path: "/p" }], [run], alias).map((g) => g.rows.length)).toEqual([1]);
    // A run that recorded the link's path, of the workflow listed by its real path.
    const viaLink = { ...ws("/p", "b"), workflowPath: alias.path, workflowRealPath: alias.realPath };
    expect(followsWorkflow(viaLink, { path: alias.realPath })).toBe(true);
    expect(followsWorkflow(viaLink, alias)).toBe(true);
    // Another file is not followed.
    expect(followsWorkflow(run, { path: "/shared/workflows/other.yml" })).toBe(false);
    expect(followsWorkflow({ workflowPath: undefined }, { path: "/x.yml" })).toBe(false);
  });

  test("a row says where an open workstream is and for how long, or how long a finished one took", () => {
    const open = ws("/p", "a", { started: 53 });
    open.summary!.currentStep = "implement";
    expect(rowTiming(open, NOW)).toBe("at implement · 2d 5h");
    expect(rowTiming(ws("/p", "b", { started: 20, status: "COMPLETED" }), NOW)).toBe("took 1h");
  });

  test("the stats strip and a step's figures", () => {
    const w = ws("/p", "a", { started: 53 });
    w.summary = { ...w.summary!, currentStep: "implement", ownerWaitMs: 6 * HOUR + 29 * 60_000, routesBack: [{ time: at(2), from: "implement", to: "plan" }] };
    expect(workstreamStats(w, NOW)).toEqual([
      { label: "at step", value: "implement" },
      { label: "running for", value: "2d 5h" },
      { label: "waited for owner", value: "6h 29m" },
      { label: "sent back", value: "implement → plan" },
    ]);
    expect(workstreamStats(ws("/p", "b", { status: "COMPLETED" }), NOW)[0]).toEqual({ label: "at step", value: "done" });
    expect(stepTiming({ activeMs: 90 * 60_000, ownerWaitMs: 143 * 60_000, visits: 2 })).toBe("1h 30m · owner 2h 23m · ×2 visits");
    expect(stepTiming({ activeMs: 8 * 60_000, ownerWaitMs: 0, visits: 1 }, " working")).toBe("8m working");
    expect(stepTiming({ activeMs: 0, ownerWaitMs: 0, visits: 0, skipReason: "started at review" })).toBe("started at review");
    expect(sentBackFrom(w, "implement")).toEqual(["plan"]);
    expect(sentBackFrom(w, "plan")).toEqual([]);
  });

  test("links name the parent, the one it came after, its children and its followers, once each", () => {
    const parent = ws("/p", "pdf", { children: [{ step: "review", pass: 1, slug: "pdf-fix" }], startedAfter: ["next"] });
    const child = ws("/p", "pdf-fix", { parent: { slug: "pdf", step: "review" } });
    const next = ws("/p", "next", { after: "pdf" });
    const foreign = ws("/q", "other", { after: "pdf" });
    const all = [parent, child, next, foreign];
    expect(workstreamLinks(parent, all)).toEqual([
      { label: "child workstream", slug: "pdf-fix" },
      { label: "followed by", slug: "next" },
    ]);
    expect(workstreamLinks(child, all)).toEqual([{ label: "child of step review of", slug: "pdf" }]);
    expect(workstreamLinks(next, all)).toEqual([{ label: "started after", slug: "pdf" }]);
  });

  test("a step's child workstreams are listed in pass order; one that is not handed out waits for none", () => {
    const w = ws("/p", "pdf", {
      children: [
        { step: "review", pass: 2, slug: "pdf-review-2" },
        { step: "plan", pass: 1, slug: "pdf-plan" },
        { step: "review", pass: 3, slug: "pdf-review-3" },
        { step: "review", pass: 1, slug: "pdf-review" },
      ],
    });
    expect(stepChildren(w, "review", "pdf-review")).toEqual({ others: ["pdf-review", "pdf-review-2", "pdf-review-3"] });
    expect(stepChildren(w, "plan", "pdf-plan")).toEqual({ others: ["pdf-plan"] });
    expect(stepChildren(w, "build", "pdf-build")).toBeNull();
    expect(stepChildren(ws("/p", "none"), "review", "none-review")).toBeNull();
  });
});

describe("workstreamLinkDir", () => {
  // Two projects with a child workflow of the same name, and Komposer opened in /a.
  const projects = [
    { path: "/a", workflowsDir: "/a/.konductor/workflows" },
    { path: "/b", workflowsDir: "/b/.konductor/workflows" },
  ];
  const listed = [
    { location: "project", path: "/a/.konductor/workflows/parent.yml", onDisk: true },
    { location: "project", path: "/a/.konductor/workflows/child.yml", onDisk: true },
    { location: "run", path: "/b/.konductor/workflows/child.yml", onDisk: true },
  ];

  test("a workstream's workflow gates and hand-offs are looked up in its own project", () => {
    const inB = ws("/b", "pdf");
    const dir = workstreamLinkDir(inB, projects, "/a/.konductor/workflows");
    expect(dir).toBe("/b/.konductor/workflows");
    const found = resolveWorkflowRef("child", listed[0].path, listed, dir);
    expect(found).toEqual({ ok: true, target: listed[2] });
  });

  test("a workstream of a project Komposer does not list falls back to the given folder", () => {
    expect(workstreamLinkDir(ws("/gone", "pdf"), projects, "/a/.konductor/workflows")).toBe("/a/.konductor/workflows");
    expect(resolveWorkflowRef("missing", listed[0].path, listed, "/a/.konductor/workflows")).toEqual({ ok: false, reason: 'no workflow named "missing"' });
  });
});

describe("a workstream as fuse-flow reads it", () => {
  const withSteps = (status: string, steps: Record<string, string>, fields: Partial<WorkstreamSummary> = {}) => {
    const w = ws("/p", "a", { status, ...fields });
    w.summary = { ...w.summary!, currentStep: "s3", steps: Object.fromEntries(Object.entries(steps).map(([id, st]) => [id, { status: st }])) };
    return w;
  };

  test("a current step that is PENDING after earlier steps finished is in progress, and is named as held", () => {
    const held = withSteps("PENDING", { s1: "COMPLETED", s2: "COMPLETED", s3: "PENDING" });
    expect(stateOf(held)).toBe("IN_PROGRESS");
    expect(heldStep(held)).toBe("s3");
    const fresh = withSteps("PENDING", { s1: "PENDING" });
    expect(stateOf(fresh)).toBe("PENDING");
    expect(heldStep(fresh)).toBeUndefined();
  });

  test("after a rename of the current step, the old step's record still counts and is listed as no longer in the workflow", () => {
    const renamed = withSteps("PENDING", { draft: "COMPLETED", reviewing: "PENDING", review: "IN_PROGRESS" });
    expect(stateOf(renamed)).toBe("IN_PROGRESS");
    expect(orphanSteps(renamed, ["draft", "reviewing"])).toEqual([
      { id: "review", status: "IN_PROGRESS", note: "recorded, but the workflow no longer has this step" },
    ]);
    expect(orphanSteps(renamed, ["draft", "reviewing", "review"])).toEqual([]);
  });

  test("a workflow file on disk that is not a valid workflow is a problem, as for fuse-flow list", () => {
    const w = ws("/p", "a");
    expect(workstreamProblem(w, "version: 1\nname: z\nsteps: [oops\n")).toMatch(/^Its workflow \/wf\/a\.yml cannot be read: it is /);
    expect(workstreamProblem(w, "version: 1\nname: z\nsteps:\n  - id: s\n    instruction: x\n")).toBeUndefined();
    expect(workstreamProblem({ ...w, error: "state is broken" }, undefined)).toBe("state is broken");
    expect(workstreamProblem({ ...w, workflowPath: undefined, workflow: "zeta" })).toBe("Its workflow zeta is not found.");
  });

  test("a send-back event says from which step to which, with the owner's note", () => {
    expect(eventDetail({ kind: "sent-back", backFrom: "s2", backTo: "s1", detail: "redo one" })).toBe("sent the work back from s2 to s1: redo one");
    expect(eventDetail({ kind: "sent-back", backFrom: "s2", backTo: "s1", detail: "" })).toBe("sent the work back from s2 to s1");
    expect(eventDetail({ kind: "completed", detail: "" })).toBe("");
  });

  test("a delegating step names the child of its current pass, and waits for it only while handed out", () => {
    const w = ws("/p", "ws-next", {
      children: [{ step: "deleg", pass: 1, slug: "ws-next-deleg" }],
      steps: { deleg: { status: "PENDING", pass: 2 } },
    });
    w.summary = { ...w.summary!, steps: { deleg: { status: "PENDING" } } };
    expect(currentChildSlug(w, "deleg", "ws-next-deleg")).toBe("ws-next-deleg-2");
    expect(stepChildren(w, "deleg", "ws-next-deleg")).toEqual({ others: ["ws-next-deleg"] });
    const second = { ...w, children: [...w.children!, { step: "deleg", pass: 2, slug: "ws-next-deleg-2" }] };
    second.summary = { ...w.summary, steps: { deleg: { status: "IN_PROGRESS" } } };
    expect(currentChildSlug(second, "deleg", "ws-next-deleg")).toBe("ws-next-deleg-2");
    expect(stepChildren(second, "deleg", "ws-next-deleg")).toEqual({ waitsFor: "ws-next-deleg-2", others: ["ws-next-deleg"] });
    const done = { ...second, summary: { ...second.summary, steps: { deleg: { status: "COMPLETED" } } } };
    expect(stepChildren(done, "deleg", "ws-next-deleg")).toEqual({ others: ["ws-next-deleg", "ws-next-deleg-2"] });
    // A step whose state names no pass is in its first.
    expect(currentChildSlug(ws("/p", "x"), "deleg", "x-deleg")).toBe("x-deleg");
  });

  // rvk-views-2: fuse-flow status names the child of the current pass, which
  // may not exist yet, and never an earlier pass's child in its place.
  test("a handed-out step whose current pass has no child yet waits for that pass's child, not the earlier one", () => {
    const w = ws("/p", "parent-run", {
      children: [{ step: "deleg", pass: 1, slug: "parent-run-deleg" }],
      steps: { deleg: { status: "IN_PROGRESS", pass: 2 } },
    });
    w.summary = { ...w.summary!, steps: { deleg: { status: "IN_PROGRESS" } } };
    expect(stepChildren(w, "deleg", "parent-run-deleg")).toEqual({ waitsFor: "parent-run-deleg-2", others: ["parent-run-deleg"] });
  });

  test("a step whose workflow gate was removed waits for no child and lists its children", () => {
    const w = ws("/p", "removed-gate-run", { children: [{ step: "deleg", pass: 1, slug: "removed-gate-run-deleg" }] });
    w.summary = { ...w.summary!, steps: { deleg: { status: "IN_PROGRESS" } } };
    expect(stepChildren(w, "deleg", undefined)).toEqual({ others: ["removed-gate-run-deleg"] });
    // A handed-out step with a gate and no child recorded yet waits for its first.
    expect(stepChildren({ ...w, children: [] }, "deleg", "removed-gate-run-deleg")).toEqual({ waitsFor: "removed-gate-run-deleg", others: [] });
  });

  // rvk-views-3: a send-back that resets every step to PENDING keeps the
  // events the workstream recorded; it has started.
  test("a workstream sent back so that every step is PENDING again is in progress and held at its current step", () => {
    const rewound = withSteps("PENDING", { first: "PENDING", second: "PENDING" }, {
      events: [
        { kind: "handed-out", detail: "" },
        { kind: "completed", detail: "" },
        { kind: "sent-back", backFrom: "second", backTo: "first", detail: "Repeat the work." },
      ],
    });
    rewound.summary = { ...rewound.summary!, currentStep: "first" };
    expect(stateOf(rewound)).toBe("IN_PROGRESS");
    expect(heldStep(rewound)).toBe("first");
    const fresh = withSteps("PENDING", { first: "PENDING" }, { events: [] });
    expect(stateOf(fresh)).toBe("PENDING");
  });

  // rvk-views-5: fuse-flow reads the workflow file for every command, so one
  // Komposer has no text of is a problem, with the server's reason when known.
  test("a workflow file that cannot be read is a problem, with its reason", () => {
    const w = ws("/p", "a");
    expect(workstreamProblem(w, undefined, "EACCES: permission denied, open '/wf/a.yml'")).toBe(
      "Its workflow /wf/a.yml cannot be read: EACCES: permission denied, open '/wf/a.yml'",
    );
    expect(workstreamProblem(w, undefined)).toBe("Its workflow /wf/a.yml cannot be read.");
  });

  // rvk-views-6: a workflow that cannot be read says nothing of which steps
  // it has, so no recorded step is said to be removed.
  test("recorded steps of a workflow that cannot be read are not said to be removed", () => {
    const w = withSteps("IN_PROGRESS", { original: "IN_PROGRESS" });
    expect(orphanSteps(w, [], false)).toEqual([
      { id: "original", status: "IN_PROGRESS", note: "recorded; the workflow cannot be read, so its steps are unknown" },
    ]);
  });
});
