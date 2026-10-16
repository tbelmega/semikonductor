// SPDX-License-Identifier: Apache-2.0
// The schema of a workflow file: the ordered steps a workstream goes through.
// The schemas in this folder are the source of truth: `bun run schema` turns
// each of them (workflow.ts, step.ts, gate.ts) into a JSON Schema file, which
// editors use to validate workflow files and show the descriptions on hover.
//
// Every description ends with the field's effect on the engine, so a reader
// can tell a field fuse-flow acts on from one that only documents the step.

import { z } from "zod";
import { ARTIFACT_ID, StepSchema } from "./step.ts";

// A document the workflow expects from outside: from the workstream it was
// started after, from a file the owner names, or from its parent workstream.
export const WorkflowInputSchema = z
  .object({
    artifact: ARTIFACT_ID.meta({
      description:
        "The input's id. Engine effect: steps may consume it as if an earlier step had produced it. It may not " +
        "be an id a step of this workflow produces, updates or returns.",
      examples: ["build-order"],
    }),
    description: z.string().optional().meta({ description: "What the input is, for the reader. Engine effect: none." }),
    required: z.boolean().optional().meta({
      description:
        "Whether the workflow cannot start without it. Engine effect: `start`, and a parent creating this " +
        "workflow as a child, refuse when it is not bound. Inputs are optional unless this is true.",
    }),
  })
  .strict()
  .meta({ description: "A document the workflow expects from outside." });

export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

// The workflow that may come next, and when.
const HandOffObject = z
  .object({
    workflow: z.string().min(1).meta({
      description: "The next workflow, by name or by a path relative to this workflow file.",
      examples: ["fuse-feature-development"],
    }),
    when: z.string().optional().meta({
      description:
        "When to start it, in words, such as once per entry of the build order. It can rule the hand-off out, " +
        "such as a pull request workflow the owner did not choose. Engine effect: printed in the completion block " +
        "with the start command; the agent offers the hand-off where this applies and does not mention it where " +
        "it does not.",
    }),
  })
  .strict();

const HandOffSchema = z.union([z.string().min(1), HandOffObject]).transform((v) => (typeof v === "string" ? { workflow: v } : v));

export type HandOff = z.infer<typeof HandOffObject>;

export const WorkflowSchema = z
  .object({
    version: z.literal(1).meta({
      description:
        "Version of the workflow file format; 1 is the only version so far. Engine effect: a file with any " +
        "other value is refused, so a file written for a different format is not misread.",
    }),
    name: z.string().min(1).meta({
      description: "Human-readable name of the workflow. Engine effect: none; shown by `fuse-flow status` and the viewer.",
    }),
    description: z.string().optional().meta({
      description: "What the workflow is for, in a sentence or two. Engine effect: none; shown by `fuse-flow list` and the viewer.",
    }),
    inputs: z.array(WorkflowInputSchema).optional().transform((v) => v ?? []).meta({
      description:
        "Documents the workflow expects from outside. Engine effect: `start --after <slug>` binds each to the " +
        "earlier workstream's document with the same id, `start --input <id>=<path>` to a file, and a parent's " +
        "workflow gate to its own documents. A step block shows an input that was not bound as not given.",
    }),
    hands_off_to: z
      .union([HandOffSchema, z.array(HandOffSchema)])
      .optional()
      .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]))
      .meta({
        description:
          "The workflows that may come next: one or a list, each a name or `{ workflow, when }`. Engine effect: " +
          "the completion block names each with the command that starts it after this workstream; nothing " +
          "starts on its own, so the owner decides.",
      }),
    steps: z.array(StepSchema).min(1).meta({
      description:
        "The steps, in the order fuse-flow runs them. The current step is the first one in the list that is " +
        "neither COMPLETED nor SKIPPED, so steps run one at a time, in file order.",
    }),
  })
  .strict()
  .superRefine((wf, ctx) => {
    // Zod runs this check even when a step failed its own rules, with the
    // values that step was written with, so read lists defensively.
    const list = <T>(v: T[] | unknown): T[] => (Array.isArray(v) ? v : []);
    type Written = { artifact: string };
    type WrittenGate = { kind?: string; route_back_to?: string[]; inputs?: Record<string, string>; returns?: Record<string, string> };
    const written = (step: (typeof wf.steps)[number]) =>
      [...list<Written>(step.produces), ...list<Written>(step.optional_produces), ...list<Written>(step.updates)].map((a) => a?.artifact);
    // An input stands for a document from outside, so no step may write one.
    const inputs = new Set<string>();
    list<{ artifact: string }>(wf.inputs).forEach((input, i) => {
      if (inputs.has(input?.artifact)) {
        ctx.addIssue({ code: "custom", path: ["inputs", i, "artifact"], message: `duplicate input "${input.artifact}"` });
      }
      inputs.add(input?.artifact);
    });
    // What a step consumes or routes back to must come before it, so the file
    // order, which is the order fuse-flow runs the steps in, respects both.
    const earlier = new Set<string>();
    const artifactsSoFar = new Set<string>(inputs);
    wf.steps.forEach((step, i) => {
      if (earlier.has(step.id)) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "id"], message: `duplicate step id "${step.id}"` });
      }
      list<string>(step.consumes).forEach((id, j) => {
        if (!artifactsSoFar.has(id)) {
          ctx.addIssue({
            code: "custom",
            path: ["steps", i, "consumes", j],
            message: `"${step.id}" consumes "${id}", which no step before it produces or updates, no earlier workflow gate returns, and the workflow does not declare as an input`,
          });
        }
      });
      earlier.add(step.id);
      const own = written(step);
      for (const id of own) {
        if (inputs.has(id)) {
          ctx.addIssue({ code: "custom", path: ["steps", i], message: `"${step.id}" writes "${id}", which is an input of the workflow; name the input differently` });
        }
      }
      const gates = list<WrittenGate>(step.gates);
      const delegations = gates.filter((g) => g?.kind === "workflow");
      if (delegations.length > 1) {
        ctx.addIssue({ code: "custom", path: ["steps", i, "gates"], message: `"${step.id}" has ${delegations.length} workflow gates; a step waits for one child` });
      }
      gates.forEach((g, j) => {
        // A gate routes back to this step or one listed before it.
        for (const target of new Set(list<string>(g?.route_back_to))) {
          if (!earlier.has(target)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", i, "gates", j, "route_back_to"],
              message: `"${step.id}" routes back to "${target}", which is not this step or a step listed before it`,
            });
          }
        }
        if (g?.kind !== "workflow") return;
        // The child is created when the step is handed out, so it is given
        // only what exists before the step.
        for (const [child, parent] of Object.entries(g.inputs ?? {})) {
          if (!artifactsSoFar.has(parent)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", i, "gates", j, "inputs", child],
              message: `"${step.id}" gives its child "${parent}", which no step before it produces or updates, no earlier workflow gate returns, and the workflow does not declare as an input`,
            });
          }
        }
        for (const id of Object.keys(g.returns ?? {})) {
          if (inputs.has(id) || own.includes(id)) {
            ctx.addIssue({
              code: "custom",
              path: ["steps", i, "gates", j, "returns", id],
              message: `"${step.id}" returns "${id}", which is ${inputs.has(id) ? "an input of the workflow" : "an artifact the step writes itself"}; rename it, as in returns: { <new id>: ${g.returns![id]} }`,
            });
          }
        }
      });
      for (const id of own) artifactsSoFar.add(id);
      for (const g of delegations) for (const id of Object.keys(g.returns ?? {})) artifactsSoFar.add(id);
    });
  })
  // Last, because a refinement returns a new schema that does not carry metadata.
  .meta({
    id: "Workflow",
    title: "fuse-flow workflow",
    description:
      "A fuse-flow workflow: the ordered steps a workstream goes through, and what closes each one. " +
      "Start a workstream with `fuse-flow start <slug> --workflow <name>`.",
  });

export type Workflow = z.infer<typeof WorkflowSchema>;
