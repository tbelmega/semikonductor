// SPDX-License-Identifier: Apache-2.0
// Loading a workflow file. Parsing its text is in parse.ts, which Komposer
// shares; the fields themselves are defined in schemas/.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { FlowError } from "./errors.ts";
import { formatIssue, parseWorkflowText } from "./parse.ts";
import { isWorkflowPath } from "./project.ts";
import type { Workflow } from "./schemas/workflow.ts";

export { describeGate, describeGates } from "./parse.ts";
export type { Condition, Gate, GateKind } from "./schemas/gate.ts";
export type { Artifact, Step } from "./schemas/step.ts";
export type { HandOff, Workflow, WorkflowInput } from "./schemas/workflow.ts";

export function loadWorkflow(path: string): Workflow {
  if (!existsSync(path)) throw new FlowError(`no workflow at ${path}`);
  const parsed = parseWorkflowText(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    if (parsed.issues[0]?.code === "yaml") throw new FlowError(`${path} is ${parsed.issues[0].message}`);
    const issues = parsed.issues.map((i) => `  ${formatIssue(i)}`);
    throw new FlowError(`${path} is not a valid workflow:\n${issues.join("\n")}`);
  }
  // A gate's review guide, and a workflow named by its path, are relative to
  // the workflow file, so a workflow and the files it names can be moved
  // together.
  // Whether a gate's guide is there is checked once the policy files have had
  // their say, by reviewGuideProblems: a guide they replace is never read.
  const near = (ref: string) => (isWorkflowPath(ref) && !isAbsolute(ref) ? resolve(dirname(path), ref) : ref);
  for (const step of parsed.workflow.steps) {
    for (const gate of step.gates) {
      if (gate.guide && !isAbsolute(gate.guide)) gate.guide = resolve(dirname(path), gate.guide);
      if (gate.kind === "workflow") gate.text = near(gate.text);
    }
  }
  for (const handOff of parsed.workflow.hands_off_to) handOff.workflow = near(handOff.workflow);
  return parsed.workflow;
}
