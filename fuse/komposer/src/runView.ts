// SPDX-License-Identifier: Apache-2.0
// How a workstream's states, times and project read in the UI.

import { duration, runDuration, runState, type RunState } from "./model/workstreams.ts";

export { duration, runDuration, runState, type RunState };

export const RUN_STATE: Record<RunState, { label: string; className: string }> = {
  PENDING: { label: "not started", className: "pending" },
  IN_PROGRESS: { label: "in progress", className: "progress" },
  AWAITING_OWNER: { label: "waiting for owner", className: "waiting" },
  BLOCKED: { label: "blocked", className: "blocked" },
  COMPLETED: { label: "completed", className: "completed" },
  SKIPPED: { label: "skipped", className: "skipped" },
};

export function dateTime(value?: string): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const month = date.toLocaleString("en", { month: "short" });
  const time = date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${month} ${date.getDate()} ${time}`;
}

// A project's folder name, as the Workstreams page shows it.
export function projectName(path: string): string {
  return path.split("/").filter(Boolean).pop() ?? path;
}
