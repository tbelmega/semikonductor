// SPDX-License-Identifier: Apache-2.0
// The schema of a workstream's state file, .konductor/workstreams/<slug>.yml:
// where each step of the workflow stands. Only fuse-flow writes this file, and
// git ignores it. State files written before the six step states are read and
// migrated, so a workstream started with an earlier fuse-flow can continue.

import { posix } from "node:path";
import { z } from "zod";
import { idRecord } from "./id-record.ts";

export const STEP_STATES = ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED", "COMPLETED", "SKIPPED"] as const;
export type StepStatus = (typeof STEP_STATES)[number];

const LEGACY_STATES: Record<string, StepStatus> = {
  pending: "PENDING",
  "awaiting-owner": "AWAITING_OWNER",
  blocked: "BLOCKED",
  done: "COMPLETED",
};

// A recorded relative path in the form artifactPath gives a declared path:
// posix.normalize, which keeps a trailing slash. Anything else is left as it is.
const normalized = (path: unknown) => (typeof path === "string" && path && !posix.isAbsolute(path) ? posix.normalize(path) : path);

// What a recorded artifact's status says about it. State files written before
// "done" record "approved" for steps without an owner gate too, and are read
// as they are.
const ArtifactStatusSchema = z.enum(["draft", "done", "approved", "superseded"]).meta({
  description:
    "draft: written, while the step waits for the owner, is blocked or was sent back. done: the step completed " +
    "and its gates passed, but it has no owner gate, so no owner approved it yet. approved: the owner approved it, " +
    "at the step's owner gate or at the next owner gate of a later step. superseded: reserved for a later " +
    "artifact replacement process.",
});

// An artifact the workstream recorded, with its status.
export const RecordedArtifactSchema = z
  .object({
    artifact: z.string().optional().meta({ description: "The artifact's id; absent in migrated state files." }),
    path: z.string(),
    status: ArtifactStatusSchema,
  })
  .strict();

// A file or folder the step wrote, under the artifact it belongs to.
export const WrittenSchema = z
  .object({
    artifact: z.string().optional().meta({
      description: "The artifact's id, fixed when the file is named or found; absent for a file outside every declared path.",
    }),
    path: z.string(),
    kind: z.enum(["whole", "file"]).meta({
      description: "whole: the artifact's declared path, found on disk by fuse-flow. file: a file the agent named with --updated.",
    }),
    pass: z.enum(["this", "earlier"]).meta({ description: "Whether the step wrote it in this pass or in an earlier one." }),
    status: ArtifactStatusSchema,
  })
  .strict();

// A review named as "review <n> (<its text>)", <n> its number in the step
// block's list of gates, followed, when it follows review guides, by
// " following <guide> (sha256 <digest>)" for each, and the reviews before it
// that passed, named so.
export const ReviewEvidenceSchema = z
  .object({
    review: z.string(),
    passed: z.array(z.string()),
  })
  .strict();

export const StepStateSchema = z
  .preprocess(
    (raw) => {
      if (!raw || typeof raw !== "object") return raw;
      const { fix_cycles: _dropped, ...state } = raw as Record<string, unknown>;
      if (typeof state.status === "string" && state.status in LEGACY_STATES) {
        const done = state.status === "done";
        state.status = LEGACY_STATES[state.status];
        if (Array.isArray(state.artifacts)) {
          state.artifacts = state.artifacts.map((a) =>
            typeof a === "string" ? { path: a, status: done ? "approved" : "draft" } : a,
          );
        }
      }
      // Earlier versions kept a declared path as the workflow wrote it, such
      // as ./reports/ or docs/../reports/. Paths are compared as the engine
      // places them now, normalized, so the recorded ones are read that way.
      for (const key of ["existed", "updated", "earlier_pass"]) {
        if (Array.isArray(state[key])) state[key] = (state[key] as unknown[]).map(normalized);
      }
      for (const key of ["artifacts", "files"]) {
        if (Array.isArray(state[key])) {
          state[key] = (state[key] as unknown[]).map((e) =>
            e && typeof e === "object" && "path" in e ? { ...e, path: normalized((e as { path: unknown }).path) } : e,
          );
        }
      }
      return state;
    },
    z
      .object({
        status: z.enum(STEP_STATES).meta({
          description:
            "PENDING: not handed out yet. IN_PROGRESS: handed out; the agent is working on it. AWAITING_OWNER: " +
            "the work is done and an owner-action gate waits. BLOCKED: the agent reported that the planned path " +
            "broke down. COMPLETED and SKIPPED: finished.",
        }),
        skip_reason: z.string().optional(),
        rounds_granted: z.number().int().min(1).optional().meta({
          description: "Review rounds the owner granted on top of the agent gates' cap, with --more-rounds.",
        }),
        blocked_gate: z.number().int().min(1).optional().meta({
          description:
            "While the step is BLOCKED: the review the agent reported it blocked at, with --gate, by its number in " +
            "the step block's list of gates.",
        }),
        blocked_review: ReviewEvidenceSchema.optional().meta({
          description:
            "With blocked_gate: the review the agent reported the step blocked at, and the reviews before it, which " +
            "passed, as the workflow named them then. An edit that changes or moves that review voids --gate.",
        }),
        accepted_gates: z.array(z.number().int().min(1)).optional().meta({
          description:
            "The reviews the owner accepted as they were in this pass, with --owner-approved --gate, by their " +
            "number in the step block's list of gates. The agent does not run them again.",
        }),
        accepted_reviews: z.array(ReviewEvidenceSchema).optional().meta({
          description:
            "For each review in accepted_gates: the review and the reviews before it, which passed, as the workflow " +
            "named them when the step was blocked. An acceptance, and what it says passed before it, counts only " +
            "while the workflow still names those reviews so: the same text at the same number, following the same " +
            "guides with the same content, each for the same artifact.",
        }),
        reviews_waived: z
          .array(z.object({ review: z.string(), reason: z.string() }).strict())
          .optional()
          .meta({
            description:
              "The reviews the owner waived in this pass, with --waived, named as in accepted_reviews, each with the " +
              "owner's reason. A waiver holds only while the workflow names the review so.",
          }),
        reviews_passed: z.array(z.string()).optional().meta({
          description:
            "When the agent recorded the work for the owner: the step's reviews, named as in accepted_reviews. A " +
            "review the workflow names otherwise now, such as one an edit added, has not run on the recorded work.",
        }),
        artifacts: z.array(RecordedArtifactSchema).meta({
          description: "The artifacts recorded for the step, as later steps and workstreams read them; derived from `files`.",
        }),
        files: z.array(WrittenSchema).optional().meta({
          description: "What the step wrote, in this pass and earlier ones, by artifact id: the files the agent named and the declared paths found on disk.",
        }),
        updated: z.array(z.string()).optional().meta({
          description: "Before `files`: the files the agent reported with --updated. Converted to `files` by the next command.",
        }),
        unchanged: idRecord(z.string(), z.string()).optional().meta({
          description: "Updates artifacts the agent left as they were, with the reason, by artifact id.",
        }),
        not_produced: idRecord(z.string(), z.string()).optional().meta({
          description: "Produces artifacts the agent did not write, with the reason, by artifact id.",
        }),
        existed: z.array(z.string()).optional().meta({
          description: "Produces paths that existed, unrecorded by this workstream, when the step was first handed out.",
        }),
        pass: z.number().int().min(2).optional().meta({
          description:
            "Which pass of the step this is, when the owner sent the work back to it or past it; absent for the " +
            "first pass. Review rounds count per pass.",
        }),
        rerun: z.array(z.string()).optional().meta({
          description:
            "With a for_each gate, after a send-back to this step: the items that get a new child in the next pass, " +
            "chosen by the owner with --rerun or by the engine for an automatic retry; every other item keeps its " +
            "previous child. Consumed when the pass's set is recorded.",
        }),
        retries_used: z.number().int().min(0).optional().meta({
          description:
            "With a for_each gate: how many passes the engine opened on its own for items whose child ended as failed, " +
            "against the gate's retries. Reset by an owner send-back.",
        }),
        earlier_pass: z.array(z.string()).optional().meta({
          description: "Before `files`: the files the step wrote in its earlier passes. Converted to `files` by the next command.",
        }),
        verification: z.array(z.string()).optional().meta({
          description: "The result of each check and script gate when the step was last continued.",
        }),
        children: z
          .array(
            z
              .object({
                pass: z.number().int().min(1),
                slug: z.string(),
                item: z.string().optional().meta({ description: "With for_each: the item this child was created for, the file name without its extension." }),
                file: z.string().optional().meta({ description: "With for_each: the item's file, relative to the repository root, bound to the child's inputs." }),
              })
              .strict(),
          )
          .optional()
          .meta({
            description:
              "The child workstreams of a step with a workflow gate, one per pass of the step, or several per pass " +
              "when the gate has for_each, one per item: the newest pass's are the ones the step waits for, and the " +
              "ones later steps read returned documents from.",
          }),
        history: z.array(z.string()).meta({ description: "One timestamped line per event on the step, oldest first." }),
      })
      .strict(),
  )
  .meta({ description: "Where one step stands. A step the file does not mention yet is PENDING." });

// Step id -> state. An object with a catchall rather than z.record, which
// refuses objects that have a "constructor" key, and "constructor" is a valid
// step id.
export const WorkstreamSchema = z
  .object({
    workflow: z.string().min(1).meta({
      description:
        "The workflow the workstream follows, as given to `start`: a name, or a path. A path to a file inside the " +
        "repository is relative to its root, so the workstream survives a move of the checkout; any other path, " +
        "and every path in state files written before this, is absolute. A path that is gone, as after a move of the " +
        "checkout, is refused until `start --workflow` names the file's new path, which it then records.",
    }),
    started: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .meta({
        description:
          "The local date the workstream was started, YYYY-MM-DD; artifact paths use it for `{date}`. Absent in " +
          "state files written before it existed; the date of the earliest history line stands in then.",
      }),
    base: z
      .object({ sha: z.string(), subject: z.string() })
      .strict()
      .optional()
      .meta({
        description:
          "The commit HEAD was at when the workstream started, with its subject, so the base can be found again " +
          "after a rebase rewrites it. Code reviews cover the commits from the base to HEAD. Absent outside a git " +
          "repository, in a repository with no commits, and in state files written before it existed.",
      }),
    after: z.string().optional().meta({
      description: "The workstream this one was started after, with `start --after`, which gave it its inputs.",
    }),
    parent: z
      .object({ slug: z.string(), step: z.string(), item: z.string().optional() })
      .strict()
      .optional()
      .meta({
        description:
          "For a child workstream: the workstream and the step with the workflow gate that created it and waits for " +
          "it, and with for_each the item this child was created for.",
      }),
    inputs: z.object({}).catchall(z.string()).optional().meta({
      description: "The workflow's inputs that were bound when the workstream started: input id -> path.",
    }),
    outcome: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("succeeded") }).strict(),
        z
          .object({
            kind: z.literal("failed"),
            reason: z.string().min(1),
            step: z.string().optional().meta({ description: "The step the workstream was failed at; absent when it was declared on a complete workstream." }),
          })
          .strict(),
      ])
      .optional()
      .meta({
        description:
          "How the workstream ended, as its agent declared it with `fuse-flow finish`; the engine records the " +
          "declaration and does not verify it. Absent when nothing was declared: a complete workstream then reads as " +
          "succeeded. A hand-out or a send-back deletes it, since new work makes the declaration stale.",
      }),
    steps: z.object({}).catchall(StepStateSchema).meta({ description: "The state of each step, by step id." }),
  })
  .strict()
  .meta({ title: "fuse-flow workstream state" });

export type RecordedArtifact = z.infer<typeof RecordedArtifactSchema>;
export type Written = z.infer<typeof WrittenSchema>;
export type StepState = z.infer<typeof StepStateSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
