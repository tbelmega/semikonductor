// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { entryIndex, entryProject, entryState, parseRoute, routePath, routedWorkflow, workflowRoute } from "../src/model/route.ts";
import type { WorkflowFile } from "../src/workflowView.ts";

type Listed = Pick<WorkflowFile, "location" | "dir" | "file" | "path">;

const project: Listed = { location: "project", dir: "", file: "build.yml", path: "/repo/.konductor/workflows/build.yml" };
const nested: Listed = { location: "personal", dir: "team/a b", file: "ship#1.yml", path: "/home/me/.fuse/workflows/team/a b/ship#1.yml" };
const shipped: Listed = { location: "fuse-flow", dir: "", file: "feature-development.yml", path: "/opt/fuse/workflows/feature-development.yml" };
const run: Listed = { location: "run", dir: "", file: "other.yml", path: "/work/other/.konductor/workflows/other.yml" };
const all = [project, nested, shipped, run];

describe("routes", () => {
  test("a workflow of the three locations is named by location, folder and file", () => {
    expect(routePath("edit", project)).toBe("/edit/project/build.yml");
    expect(routePath("present", shipped)).toBe("/present/fuse-flow/feature-development.yml");
    expect(routePath("compare", nested)).toBe("/compare/personal/team/a%20b/ship%231.yml");
  });

  test("another project's workflow file is named by its path", () => {
    expect(routePath("workstreams", run)).toBe("/workstreams/run/work/other/.konductor/workflows/other.yml");
  });

  test("every listed workflow's path leads back to it, on every page", () => {
    for (const page of ["edit", "compare", "present", "workstreams"] as const)
      for (const w of all) {
        const parsed = parseRoute(routePath(page, w));
        expect(parsed.page).toBe(page);
        expect(routedWorkflow(all, parsed.workflow)).toBe(w);
      }
  });

  test("a path without a workflow names only the page; one without a page shows Edit", () => {
    expect(parseRoute("/workstreams")).toEqual({ page: "workstreams", workflow: null });
    expect(parseRoute("/")).toEqual({ page: "edit", workflow: null });
    expect(parseRoute("/nonsense/project/build.yml")).toEqual({ page: "edit", workflow: null });
  });

  test("a workflow that is not listed, or a path that does not decode, selects none", () => {
    expect(routedWorkflow(all, parseRoute("/edit/project/gone.yml").workflow)).toBeUndefined();
    expect(parseRoute("/edit/project/%E0%A4%A.yml")).toEqual({ page: "edit", workflow: null });
    expect(routedWorkflow(all, parseRoute("/edit/project").workflow)).toBeUndefined();
  });

  test("workflowRoute is the decoded form the URL encodes", () => {
    expect(workflowRoute(nested)).toBe("personal/team/a b/ship#1.yml");
  });

  test("a history entry keeps its place and the project a followed link was read for, and nothing else", () => {
    expect(entryProject(entryState(3, "/work/other"))).toBe("/work/other");
    expect(entryIndex(entryState(3, "/work/other"))).toBe(3);
    expect(entryState(0, undefined)).toEqual({ n: 0 });
    expect(entryProject(null)).toBeUndefined();
    expect(entryIndex(null)).toBeUndefined();
    expect(entryProject({ project: 3 })).toBeUndefined();
    expect(entryIndex({ n: "1" })).toBeUndefined();
    expect(entryProject("x")).toBeUndefined();
  });
});
