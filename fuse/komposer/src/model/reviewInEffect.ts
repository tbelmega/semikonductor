// SPDX-License-Identifier: Apache-2.0
// What an agent gate reviews against, as rows of the Review in effect box,
// following fuse-flow. For each artifact of the step, reviewGuideSource in
// flow/src/policy.ts takes the first guide in this order: local policy, team
// policy, the Project library entry's review.md, the gate's guide, personal
// policy, the Personal entry's review.md, fuse-flow's entry's review.md. An
// artifact with none is reviewed against its own guide.md if it has one, or
// against the gate text alone (reviewText in flow/src/commands.ts).

import type { ReviewGuideSource } from "../../../flow/src/policy.ts";

// The fields of one agent gate this file reads, as the server's
// /api/review-guides gives them.
export interface FileRef {
  path: string;
  display: string;
}
export interface GateReviewGuides {
  gateGuide?: FileRef;
  reviews: { artifact?: string; guide?: FileRef & { source: ReviewGuideSource }; ownGuide?: FileRef }[];
}

const SOURCE_LEVEL: Record<ReviewGuideSource, string> = {
  "local policy": "local policy",
  "team policy": "team policy",
  "project library": "Project",
  gate: "gate guide",
  "user policy": "personal policy",
  "user library": "Personal",
  "package library": "fuse-flow",
};

// The sources fuse-flow looks at before the gate's guide.
const BEFORE_GATE = new Set<ReviewGuideSource>(["local policy", "team policy", "project library"]);

export interface ReviewRow {
  key: string;
  name: string;
  from: string;
  title: string;
  file?: FileRef;
}

export function reviewInEffectRows(gate: GateReviewGuides): ReviewRow[] {
  const rows: ReviewRow[] = [];
  const add = (row: ReviewRow) => !rows.some((r) => r.key === row.key) && rows.push(row);
  // The artifacts the gate's own guide applies to; the others have a guide
  // that comes before it.
  const viaGate = gate.reviews.filter((r) => r.guide?.source === "gate").flatMap((r) => (r.artifact ? [r.artifact] : []));
  for (const review of gate.reviews) {
    if (review.guide?.source === "gate")
      add({
        key: review.guide.path,
        name: review.guide.display,
        from: `gate guide${viaGate.length ? ` for ${viaGate.join(", ")}` : ""}; replaces any personal or fuse-flow review guide`,
        title: "Gate guide",
        file: review.guide,
      });
    else if (review.guide)
      add({
        key: review.guide.path,
        name: review.guide.display,
        from:
          SOURCE_LEVEL[review.guide.source] +
          (gate.gateGuide && BEFORE_GATE.has(review.guide.source) ? "; replaces the gate guide" : ""),
        title: `Review guide · ${review.artifact ?? "the step"}`,
        file: review.guide,
      });
    else if (review.ownGuide)
      add({
        key: review.ownGuide.path,
        name: review.ownGuide.display,
        from: "its own guide; no review guide",
        title: `Guide · ${review.artifact}`,
        file: review.ownGuide,
      });
    else if (review.artifact)
      add({ key: `artifact:${review.artifact}`, name: review.artifact, from: "no guide; the gate text is the whole review of it", title: "" });
  }
  if (!rows.length) rows.push({ key: "none", name: "none", from: "no review guide; the gate text is the whole review", title: "" });
  return rows;
}
