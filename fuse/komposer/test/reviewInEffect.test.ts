// SPDX-License-Identifier: Apache-2.0
// The Review in effect box of an agent gate: one row per guide the engine
// reviews the step's artifacts against, in the shape /api/review-guides
// returns: every guide fuse-flow applies (reviewGuides in
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
  const viaGate = { path: gatePath, display: gateGuide.display, source: "gate" as const, role: "gate" as const };

  test("a gate guide that hands the judgement to the working agent is said to apply alone", () => {
    expect(rows({ gateGuide, workingAgent: true, reviews: [{ artifact: "essay", guides: [viaGate] }] })).toEqual([
      { name: gateGuide.display, from: "gate guide; the agent that did the work judges by it alone, with no reviewer" },
    ]);
  });

  test("the artifacts' own guides apply together with the gate guide", () => {
    expect(
      rows({
        gateGuide,
        reviews: [
          { artifact: "essay", guides: [{ ...essayRules, source: "project library", role: "review" }, viaGate] },
          { artifact: "notes", guides: [{ ...notesGuide, source: "project library", role: "authoring" }, viaGate] },
        ],
      }),
    ).toEqual([
      { name: essayRules.display, from: "Project review guide for essay" },
      { name: gateGuide.display, from: "gate guide; applies with the artifacts' own guides" },
      { name: notesGuide.display, from: "Project guide for notes; how a good artifact is built" },
    ]);
  });

  test("a guide that applies to several artifacts names each of them", () => {
    const shared = { ...notesGuide, source: "package library" as const, role: "review" as const };
    expect(rows({ reviews: [{ artifact: "essay", guides: [shared] }, { artifact: "notes", guides: [shared] }] })).toEqual([
      { name: notesGuide.display, from: "fuse-flow review guide for essay, notes" },
    ]);
  });

  test("a team or local policy guide replaces the gate guide, and the artifact's guides still apply", () => {
    const team = { path: "/p/.konductor/team-review.md", display: ".konductor/team-review.md", source: "team policy" as const, role: "gate" as const };
    expect(rows({ gateGuide, reviews: [{ artifact: "essay", guides: [{ ...essayRules, source: "project library", role: "review" }, team] }] })).toEqual([
      { name: essayRules.display, from: "Project review guide for essay" },
      { name: team.display, from: "team policy; replaces the gate guide" },
    ]);
  });

  test("an artifact without any guide is listed, reviewed against the gate text alone", () => {
    expect(rows({ reviews: [{ artifact: "essay", guides: [] }, { artifact: "notes", guides: [{ ...notesGuide, source: "project library", role: "authoring" }] }] })).toEqual([
      { name: "essay", from: "no guide; the gate text is the whole review of it" },
      { name: notesGuide.display, from: "Project guide for notes; how a good artifact is built" },
    ]);
  });

  test("a guide's row keeps whether it lies outside the readable locations and why it cannot be read", () => {
    const outside = { path: "/elsewhere/rules.md", display: "/elsewhere/rules.md", outside: true, source: "gate" as const, role: "gate" as const };
    const locked = { ...essayRules, unreadable: "EACCES: permission denied", source: "project library" as const, role: "review" as const };
    const files = reviewInEffectRows({ reviews: [{ artifact: "essay", guides: [locked, outside] }] }).map((row) => row.file);
    expect(files).toEqual([
      { path: essayRules.path, display: essayRules.display, unreadable: "EACCES: permission denied" },
      { path: "/elsewhere/rules.md", display: "/elsewhere/rules.md", outside: true },
    ]);
  });

  test("a shipped artifact guide that a local policy also names as the gate's guide shows both", () => {
    const shared = { path: "/clone/skills/testing-strategy/SKILL.md", display: "skills/testing-strategy/SKILL.md" };
    expect(
      rows({
        gateGuide,
        reviews: [
          {
            artifact: "code",
            guides: [
              { ...shared, source: "package library", role: "authoring" },
              { ...shared, source: "local policy", role: "gate" },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        name: shared.display,
        from: "fuse-flow guide for code; how a good artifact is built. Also local policy; replaces the gate guide",
      },
    ]);
  });

  test("one file that serves different roles for different artifacts names each role with its artifacts", () => {
    const shared = { path: "/p/.konductor/library/shared.md", display: ".konductor/library/shared.md" };
    const out = reviewInEffectRows({
      reviews: [
        { artifact: "essay", guides: [{ ...shared, source: "project library", role: "authoring" }] },
        { artifact: "notes", guides: [{ ...shared, source: "project library", role: "review" }] },
        { artifact: "draft", guides: [{ ...shared, source: "project library", role: "authoring" }] },
      ],
    });
    expect(out.map(({ name, from, title }) => ({ name, from, title }))).toEqual([
      {
        name: shared.display,
        from: "Project guide for essay, draft; how a good artifact is built. Also Project review guide for notes",
        title: "Guide · essay, draft and Review guide · notes",
      },
    ]);
  });

  test("a step with no artifacts and no guide shows none", () => {
    expect(rows({ reviews: [{ guides: [] }] })).toEqual([{ name: "none", from: "no review guide; the gate text is the whole review" }]);
  });
});
