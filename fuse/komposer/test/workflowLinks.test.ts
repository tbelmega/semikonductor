// SPDX-License-Identifier: Apache-2.0
// How Komposer shows a workflow's hand-offs, inputs and workflow gates: what
// the diagram and inspector read from the open text, and which listed
// workflow a reference opens. Real workflow text, the real engine parser.

import { describe, expect, test } from "bun:test";
import { layoutEdges } from "../src/layout.ts";
import { normalizePath, resolveWorkflowRef } from "../src/model/workflowLinks.ts";
import {
  delegationOf,
  gatesInRunOrder,
  linkTo,
  openWorkflow,
  stepViews,
  workflowHandOffs,
  workflowInputs,
  type LocationId,
  type OpenWorkflow,
} from "../src/workflowView.ts";

const PARENT = `version: 1
name: parent
inputs:
  - artifact: brief
    description: What to build.
    required: true
  - artifact: notes
hands_off_to:
  - workflow: next
    when: once the parent is done
  - other/later.yml
steps:
  - id: intake
    instruction: Write the diff.
    consumes: [brief]
    produces: { artifact: diff, path: "diffs/{slug}.diff" }
  - id: adversarial
    instruction: Merge the new findings.
    gates:
      - owner-action: approve the findings
      # the child does the review
      - workflow: child
        slug: "{slug}-adv"
        inputs: { given-diff: diff }
        returns: [report]
        description: an independent review
        route_back_to: intake
  - id: summary
    instruction: Summarize.
    consumes: [report, notes]
`;

const PROJECT = "/p/.konductor/workflows";
const PERSONAL = "/h/.konductor/workflows";
const PACKAGE = "/f/flow/workflows";

function listed(location: LocationId, path: string, text = "version: 1\nname: x\nsteps:\n  - id: a\n    instruction: Do it.\n", onDisk = true): OpenWorkflow {
  const base = { project: PROJECT, personal: PERSONAL, "fuse-flow": PACKAGE }[location];
  const rel = path.slice(base.length + 1);
  const file = rel.slice(rel.lastIndexOf("/") + 1);
  return openWorkflow({
    location,
    dir: rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "",
    file,
    path,
    onDisk,
    text: onDisk ? text : "",
    hash: "",
    ...(onDisk ? {} : { workingCopy: text }),
  });
}

describe("a workflow with inputs, hand-offs and a workflow gate", () => {
  const parent = listed("project", `${PROJECT}/parent.yml`, PARENT);

  test("parses, and the views read its inputs, hand-offs and delegation", () => {
    expect(parent.issues).toEqual([]);
    expect(parent.parsed).not.toBeNull();
    expect(workflowInputs(parent)).toEqual([
      { artifact: "brief", description: "What to build.", required: true },
      { artifact: "notes" },
    ]);
    // A bare string is a hand-off too.
    expect(workflowHandOffs(parent)).toEqual([{ workflow: "next", when: "once the parent is done" }, { workflow: "other/later.yml" }]);

    const steps = stepViews(parent);
    const gate = delegationOf(steps[1]);
    expect(gate).toMatchObject({
      kind: "workflow",
      text: "child",
      slug: "{slug}-adv",
      inputs: { "given-diff": "diff" },
      // A list of ids reads as a mapping of each id to itself.
      returns: { report: "report" },
      description: "an independent review",
      route_back_to: ["intake"],
    });
    expect(delegationOf(steps[0])).toBeUndefined();
    // The child must be complete before the owner is asked, so it runs first.
    expect(gatesInRunOrder(steps[1].gates).map(({ gate: g, fileIndex }) => [g.kind, fileIndex])).toEqual([
      ["workflow", 1],
      ["owner-action", 0],
    ]);
  });

  test("a returned document draws from the delegating step to the step that consumes it; an input draws nothing", () => {
    const layout = layoutEdges(stepViews(parent));
    expect(layout.buses.map((b) => [b.artifact, b.producerIndex, b.consumerIndices])).toEqual([
      ["report", 1, [2]],
    ]);
    expect(layout.routes.map((r) => [r.from, r.to])).toEqual([["adversarial", "intake"]]);
  });

  test("a file that does not parse still shows its inputs, hand-offs and workflow gate", () => {
    const broken = listed("project", `${PROJECT}/parent.yml`, PARENT.replace("    instruction: Summarize.\n", ""));
    expect(broken.parsed).toBeNull();
    expect(broken.issues.length).toBeGreaterThan(0);
    expect(workflowInputs(broken).map((i) => i.artifact)).toEqual(["brief", "notes"]);
    expect(workflowHandOffs(broken)).toEqual([{ workflow: "next", when: "once the parent is done" }, { workflow: "other/later.yml" }]);
    expect(delegationOf(stepViews(broken)[1])).toMatchObject({
      kind: "workflow",
      text: "child",
      slug: "{slug}-adv",
      inputs: { "given-diff": "diff" },
      returns: { report: "report" },
      route_back_to: ["intake"],
    });
  });
});

describe("which workflow a reference opens, as fuse-flow resolves it", () => {
  const parent = listed("project", `${PROJECT}/parent.yml`, PARENT);
  const all = [
    parent,
    listed("project", `${PROJECT}/review/child.yml`),
    listed("fuse-flow", `${PACKAGE}/child.yml`),
    listed("fuse-flow", `${PACKAGE}/next.yml`),
    listed("project", `${PROJECT}/other/later.yml`),
    listed("personal", `${PERSONAL}/a/dup.yml`),
    listed("personal", `${PERSONAL}/b/dup.yml`),
    listed("project", `${PROJECT}/draft.yml`, undefined, false),
  ];
  const target = (ref: string) => {
    const link = linkTo(ref, parent, all);
    return link.ok ? link.path : link.reason;
  };

  test("a name is <name>.yml at any depth, the project's before the user's before fuse-flow's", () => {
    expect(target("child")).toBe(`${PROJECT}/review/child.yml`);
    expect(target("next")).toBe(`${PACKAGE}/next.yml`);
    expect(linkTo("next", parent, all)).toMatchObject({ ok: true, name: "x" });
  });

  test("a path is relative to the workflow that names it, or absolute", () => {
    expect(target("other/later.yml")).toBe(`${PROJECT}/other/later.yml`);
    expect(target("./review/../other/later.yml")).toBe(`${PROJECT}/other/later.yml`);
    expect(target(`${PACKAGE}/next.yml`)).toBe(`${PACKAGE}/next.yml`);
    expect(target("../workflows/missing.yml")).toBe(`no workflow at ${PROJECT}/missing.yml in Komposer's workflow locations`);
  });

  test("an ambiguous name, a missing one and a never-saved working copy do not resolve", () => {
    expect(target("dup")).toBe(`workflow name "dup" is ambiguous; rename one of: ${PERSONAL}/a/dup.yml, ${PERSONAL}/b/dup.yml`);
    expect(target("missing")).toBe('no workflow named "missing"');
    // fuse-flow does not see a working copy that was never saved.
    expect(target("draft")).toBe('no workflow named "draft"');
    expect(resolveWorkflowRef("draft", parent.path, all).ok).toBe(false);
  });

  test("normalizePath drops . and .. segments and repeated slashes", () => {
    expect(normalizePath("/a/b/../c//./d.yml")).toBe("/a/c/d.yml");
    expect(normalizePath("/../a")).toBe("/a");
    expect(normalizePath("a/../../b")).toBe("../b");
  });
});
