// SPDX-License-Identifier: Apache-2.0
// The tooltip of a workflow gate: where it delegates and how its children are handed out, accepted and re-run.

import { DEFAULT_CHILD_SLUG, DEFAULT_CHILD_SLUG_PER_ITEM, type Gate } from "../../flow/src/schemas/gate.ts";
import type { WorkflowLink } from "./workflowView.ts";

export function delegationTip(gate: Gate, link: WorkflowLink): string {
  const pairs = (map: Record<string, string> | undefined, arrow: string) =>
    Object.entries(map ?? {}).map(([a, b]) => (a === b ? a : `${a} ${arrow} ${b}`)).join(", ");
  return [
    `workflow: ${gate.text}`,
    link.ok ? `opens ${link.path}` : link.reason,
    `child slug: ${gate.slug ?? (gate.for_each !== undefined ? DEFAULT_CHILD_SLUG_PER_ITEM : DEFAULT_CHILD_SLUG)}`,
    gate.for_each && `one child per item of: ${gate.for_each}`,
    gate.inputs && `gives: ${pairs(gate.inputs, "←")}`,
    gate.returns && `returns: ${pairs(gate.returns, "←")}`,
    gate.accept && `acceptance criteria: ${gate.accept === "succeeded" ? "all children are successful" : "all children are completed"}`,
    gate.rerun && `a send-back re-runs: ${gate.rerun === "failed" ? "failed items only; the others are carried over" : "all items"}`,
    gate.rerun_override === false && "the owner cannot choose the items to re-run",
    gate.retries ? `re-runs failed items by itself: up to ${gate.retries} time${gate.retries === 1 ? "" : "s"}` : "",
    gate.route_back_to.length ? `route back to: ${gate.route_back_to.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
