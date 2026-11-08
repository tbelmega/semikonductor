// SPDX-License-Identifier: Apache-2.0
// What an agent gate reviews against, as rows of the Review in effect box,
// following fuse-flow. For each artifact of the step, reviewGuides in
// flow/src/policy.ts gives the reviewer every guide that applies: the
// artifact's own guide.md and review.md, from the library entry that wins
// (Project, then Personal, then fuse-flow), and the guide of the gate. A team
// or local policy's guide replaces the gate's guide, which replaces a personal
// policy's. An artifact with none is reviewed against the gate text alone
// (reviewText in flow/src/commands.ts).

import type { ReviewGuideRole, ReviewGuideSource } from "../../../flow/src/policy.ts";

// The fields of one agent gate this file reads, as the server's
// /api/review-guides gives them.
// `outside` and `unreadable` are kept, so the guide viewer can say why it
// shows no text instead of reporting the file missing.
export interface FileRef {
  path: string;
  display: string;
  outside?: boolean;
  unreadable?: string;
}
export interface GateReviewGuides {
  gateGuide?: FileRef;
  // The gate guide's front matter hands the judgement to the working agent:
  // it applies alone, and no reviewer is started.
  workingAgent?: boolean;
  reviews: { artifact?: string; guides: (FileRef & { source: ReviewGuideSource; role: ReviewGuideRole })[] }[];
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

export interface ReviewRow {
  key: string;
  name: string;
  from: string;
  title: string;
  file?: FileRef;
}

type AppliedGuide = GateReviewGuides["reviews"][number]["guides"][number];

// How one file applies to the review: its role and where it comes from, with
// every artifact it applies to that way.
interface Application {
  guide: AppliedGuide;
  artifacts: string[];
}

export function reviewInEffectRows(gate: GateReviewGuides): ReviewRow[] {
  // One row per guide file. The engine may apply one file in several ways,
  // such as a shipped artifact guide that a policy also names as the gate's
  // guide; the row keeps each way, with the artifacts it applies to.
  const byPath = new Map<string, Application[]>();
  const rows: (ReviewRow | string)[] = [];
  for (const review of gate.reviews) {
    for (const guide of review.guides) {
      let applications = byPath.get(guide.path);
      if (!applications) {
        applications = [];
        byPath.set(guide.path, applications);
        rows.push(guide.path);
      }
      let application = applications.find((a) => a.guide.role === guide.role && a.guide.source === guide.source);
      if (!application) {
        application = { guide, artifacts: [] };
        applications.push(application);
      }
      if (review.artifact && !application.artifacts.includes(review.artifact)) application.artifacts.push(review.artifact);
    }
    if (!review.guides.length && review.artifact)
      rows.push({ key: `artifact:${review.artifact}`, name: review.artifact, from: "no guide; the gate text is the whole review of it", title: "" });
  }
  const describe = ({ guide, artifacts }: Application): { from: string; title: string } => {
    const forWhich = artifacts.length ? ` for ${artifacts.join(", ")}` : "";
    const level = SOURCE_LEVEL[guide.source];
    if (guide.role === "authoring") return { from: `${level} guide${forWhich}; how a good artifact is built`, title: `Guide · ${artifacts.join(", ")}` };
    if (guide.role === "review") return { from: `${level} review guide${forWhich}`, title: `Review guide · ${artifacts.join(", ")}` };
    if (guide.source === "gate" && gate.workingAgent)
      return { from: "gate guide; the agent that did the work judges by it alone, with no reviewer", title: "Gate guide" };
    if (guide.source === "gate") return { from: "gate guide; applies with the artifacts' own guides", title: "Gate guide" };
    return { from: `${level}${gate.gateGuide ? "; replaces the gate guide" : ""}`, title: "Review guide · the step" };
  };
  const out = rows.map((row): ReviewRow => {
    if (typeof row !== "string") return row;
    const applications = byPath.get(row)!;
    const { source: _source, role: _role, ...file } = applications[0].guide;
    const parts = applications.map(describe);
    return {
      key: row,
      name: file.display,
      from: parts.map((p) => p.from).join(". Also "),
      title: [...new Set(parts.map((p) => p.title))].join(" and "),
      file,
    };
  });
  if (!out.length) out.push({ key: "none", name: "none", from: "no review guide; the gate text is the whole review", title: "" });
  return out;
}
