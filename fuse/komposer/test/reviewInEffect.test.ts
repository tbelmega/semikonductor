// SPDX-License-Identifier: Apache-2.0
// The Review in effect box of an agent gate: one row per guide the engine
// reviews the step's artifacts against, in the shape /api/review-guides
// returns, with the precedence fuse-flow applies (reviewGuideSource in
// flow/src/policy.ts).

import { describe, expect, test } from "bun:test";
import { reviewInEffectRows, type GateReviewGuides } from "../src/model/reviewInEffect.ts";

const gatePath = "/p/.konductor/workflows/rules/review.md";
const gateGuide = { path: gatePath, display: ".konductor/workflows/rules/review.md", exists: true };
const essayRules = { path: "/p/.konductor/library/artifacts/essay/review.md", display: ".konductor/library/artifacts/essay/review.md" };
const notesGuide = { path: "/p/.konductor/library/artifacts/notes/guide.md", display: ".konductor/library/artifacts/notes/guide.md" };
const rows = (gate: GateReviewGuides) =>
  reviewInEffectRows(gate).map(({ name, from }) => ({ name, from }));

describe("reviewInEffectRows", () => {
  test("a project review guide replaces the gate guide for its artifact; the gate guide covers the rest", () => {
    expect(
      rows({
        gateGuide,
        reviews: [
          { artifact: "essay", guide: { ...essayRules, source: "project library" } },
          { artifact: "notes", guide: { path: gatePath, display: gateGuide.display, source: "gate" } },
        ],
      }),
    ).toEqual([
      { name: essayRules.display, from: "Project; replaces the gate guide" },
      { name: gateGuide.display, from: "gate guide for notes; replaces any personal or fuse-flow review guide" },
    ]);
  });

  test("the gate guide names every artifact it applies to", () => {
    const viaGate = { path: gatePath, display: gateGuide.display, source: "gate" as const };
    expect(rows({ gateGuide, reviews: [{ artifact: "essay", guide: viaGate }, { artifact: "notes", guide: viaGate }] })).toEqual([
      { name: gateGuide.display, from: "gate guide for essay, notes; replaces any personal or fuse-flow review guide" },
    ]);
  });

  test("a team or local policy guide replaces the gate guide", () => {
    const team = { path: "/p/.konductor/team-review.md", display: ".konductor/team-review.md", source: "team policy" as const };
    expect(rows({ gateGuide, reviews: [{ artifact: "essay", guide: team }] })).toEqual([
      { name: team.display, from: "team policy; replaces the gate guide" },
    ]);
  });

  test("without a gate guide, a review guide shows its level alone", () => {
    expect(rows({ reviews: [{ artifact: "essay", guide: { ...essayRules, source: "project library" } }] })).toEqual([
      { name: essayRules.display, from: "Project" },
    ]);
  });

  test("an artifact without any guide is listed, reviewed against the gate text alone", () => {
    expect(rows({ reviews: [{ artifact: "essay" }, { artifact: "notes", ownGuide: notesGuide }] })).toEqual([
      { name: "essay", from: "no guide; the gate text is the whole review of it" },
      { name: notesGuide.display, from: "its own guide; no review guide" },
    ]);
  });

  test("a step with no artifacts and no guide shows none", () => {
    expect(rows({ reviews: [{}] })).toEqual([{ name: "none", from: "no review guide; the gate text is the whole review" }]);
  });
});
