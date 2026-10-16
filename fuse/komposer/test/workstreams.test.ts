// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
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

  test("a step's child workstreams: the newest pass is the one it waits for, the others are earlier passes", () => {
    const w = ws("/p", "pdf", {
      children: [
        { step: "review", pass: 2, slug: "pdf-review-2" },
        { step: "plan", pass: 1, slug: "pdf-plan" },
        { step: "review", pass: 3, slug: "pdf-review-3" },
        { step: "review", pass: 1, slug: "pdf-review" },
      ],
    });
    expect(stepChildren(w, "review")).toEqual({ current: "pdf-review-3", earlier: ["pdf-review", "pdf-review-2"] });
    expect(stepChildren(w, "plan")).toEqual({ current: "pdf-plan", earlier: [] });
    expect(stepChildren(w, "build")).toBeNull();
    expect(stepChildren(ws("/p", "none"), "review")).toBeNull();
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
