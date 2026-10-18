// SPDX-License-Identifier: Apache-2.0
// The schema of a workstream's state file, .konductor/workstreams/<slug>.yml:
// where each step of the workflow stands. Only fuse-flow writes this file, and
// git ignores it. State files written before the six step states are read and
// migrated, so a workstream started with an earlier fuse-flow can continue.

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
        accepted_gates: z.array(z.number().int().min(1)).optional().meta({
          description:
            "The reviews the owner accepted as they were in this pass, with --owner-approved --gate, by their " +
            "number in the step block's list of gates. The agent does not run them again.",
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
        earlier_pass: z.array(z.string()).optional().meta({
          description: "Before `files`: the files the step wrote in its earlier passes. Converted to `files` by the next command.",
        }),
        verification: z.array(z.string()).optional().meta({
          description: "The result of each check and script gate when the step was last continued.",
        }),
        children: z
          .array(z.object({ pass: z.number().int().min(1), slug: z.string() }).strict())
          .optional()
          .meta({
            description:
              "The child workstreams of a step with a workflow gate, one per pass of the step: the newest is " +
              "the one the step waits for, and the one later steps read returned documents from.",
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
      description: "The workflow the workstream follows, as given to `start`: a name, or an absolute path.",
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
      .object({ slug: z.string(), step: z.string() })
      .strict()
      .optional()
      .meta({ description: "For a child workstream: the workstream and the step with the workflow gate that created it and waits for it." }),
    inputs: z.object({}).catchall(z.string()).optional().meta({
      description: "The workflow's inputs that were bound when the workstream started: input id -> path.",
    }),
    steps: z.object({}).catchall(StepStateSchema).meta({ description: "The state of each step, by step id." }),
  })
  .strict()
  .meta({ title: "fuse-flow workstream state" });

export type RecordedArtifact = z.infer<typeof RecordedArtifactSchema>;
export type Written = z.infer<typeof WrittenSchema>;
export type StepState = z.infer<typeof StepStateSchema>;
export type Workstream = z.infer<typeof WorkstreamSchema>;
