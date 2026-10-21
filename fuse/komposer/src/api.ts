// SPDX-License-Identifier: Apache-2.0
// Typed client for Komposer's local server. The token travels in
// location.hash (#token=...); we read it once, keep it in sessionStorage so a
// reload does not lose it, and strip it from the URL bar.

import type { UnavailableWorkflow } from "./model/workflowLinks.ts";
import type { EngineValidation } from "./validate.ts";
import type { Session, WorkflowFile } from "./workflowView.ts";

const STORAGE_KEY = "komposer-token";

function readToken(): string {
  const fromHash = /(?:^#|[?&])token=([^&]+)/.exec(location.hash);
  if (fromHash) {
    const token = decodeURIComponent(fromHash[1]);
    sessionStorage.setItem(STORAGE_KEY, token);
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  return sessionStorage.getItem(STORAGE_KEY) ?? "";
}

export const token = readToken();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      authorization: `Bearer ${token}`,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  session: () => request<Session>("session"),
  workflows: () => request<{ workflows: WorkflowFile[]; unavailable: UnavailableWorkflow[] }>("workflows"),
  updateWorkflow: (path: string, baseHash: string, text: string) =>
    request<{ path: string; hash: string }>("workflows", {
      method: "PUT",
      body: JSON.stringify({ path, baseHash, text }),
    }),
  saveNewWorkflow: (location: string, folder: string, file: string, text: string) =>
    request<{ path: string; hash: string }>("workflows", {
      method: "POST",
      body: JSON.stringify({ location, folder, file, text }),
    }),
  // A working copy is written or removed only while the server holds the copy
  // the tab last saw (`expected`: its hash, or null for none). An urgent
  // request outlives the page, as when the tab is closed or reloaded.
  putWorkingCopy: (path: string, text: string, base: string, expected: string | null, urgent = false) =>
    request<{ path: string; hash: string }>("working-copies", {
      method: "PUT",
      body: JSON.stringify({ path, text, base, expected }),
      keepalive: urgent,
    }),
  deleteWorkingCopy: (path: string, expected: string | null, urgent = false) =>
    request<Record<string, never>>("working-copies", {
      method: "DELETE",
      body: JSON.stringify({ path, expected }),
      keepalive: urgent,
    }),
  library: () => request<{ entries: LibraryEntry[] }>("library"),
  reviewGuides: (path: string, text: string) =>
    request<ReviewGuides>("review-guides", { method: "POST", body: JSON.stringify({ path, text }) }),
  // The checks of `fuse-flow validate` that need other files, for the text
  // as if it were saved at path.
  validate: (path: string, text: string) =>
    request<EngineValidation>("validate", { method: "POST", body: JSON.stringify({ path, text }) }),
  workstreams: () => request<{ workstreams: WorkstreamSummary[] }>("workstreams"),
  projects: () => request<{ projects: ProjectSummary[]; error?: string }>("projects"),
  addProjects: (path: string) =>
    // truncated: the scan stopped at its folder limit, so some may be missing.
    request<{ found: string[]; added: string[]; truncated?: true }>("projects", { method: "POST", body: JSON.stringify({ path }) }),
  removeProject: (path: string) =>
    request<{ removed: boolean }>("projects", { method: "DELETE", body: JSON.stringify({ path }) }),
  watchUrl: (path: string) => `/api/watch?path=${encodeURIComponent(path)}&token=${encodeURIComponent(token)}`,
};

export interface LibraryEntry {
  id: string;
  level: "project" | "user" | "package";
  folder: string;
  // The folders between artifacts/ and the entry, such as "writing"; "" at the top.
  group: string;
  // Files that are symlinks, by name: where each leads, such as a Konductor skill.
  links?: Record<string, FileRef>;
  // From the entry's entry.yml.
  description?: string;
  entryProblem?: string;
  files: Record<string, string>;
  guideMissing?: string;
  hides?: "project" | "user" | "package";
  hiddenBy?: "project" | "user" | "package";
}

export interface FileRef {
  path: string;
  // Relative to the project, or to the repository that holds a link's target.
  display: string;
  // Set when the file lies outside the locations Komposer reads guides from;
  // its text is not sent then.
  outside?: boolean;
  // Set when the file may be read but reading it failed: the reason. Its
  // text is not sent then, and it is not a file that does not exist.
  unreadable?: string;
}

export type ReviewGuideSource =
  "local policy" | "team policy" | "project library" | "gate" | "user policy" | "user library" | "package library";

// For each agent gate of the open text: the review guide the engine gives it
// for each artifact of its step, and the gate's own guide.
export interface ReviewGuides {
  gates: {
    step: number;
    gate: number;
    gateGuide?: FileRef & { exists: boolean };
    reviews: { artifact?: string; guide?: FileRef & { source: ReviewGuideSource }; ownGuide?: FileRef }[];
  }[];
  // The text of every file named above that exists and can be read, by path.
  files: Record<string, string>;
}

export interface RunEvent {
  time: string;
  step: string;
  kind: string;
  from: string;
  to: string;
  actor?: "agent" | "owner";
  detail: string;
  backFrom?: string;
  backTo?: string;
}

export interface WorkstreamSummary {
  // The project the run belongs to: its repository root.
  project: string;
  slug: string;
  workflow?: string;
  workflowPath?: string;
  // The real path of the workflow file, when a link lies on workflowPath.
  workflowRealPath?: string;
  error?: string;
  // The workstream this one was started after (`start --after`).
  after?: string;
  // For a child: the workstream and the step with the workflow gate that waits for it.
  parent?: { slug: string; step: string };
  // The workflow inputs bound when it started: input id -> path.
  inputs?: Record<string, string>;
  // The workstreams started after this one.
  startedAfter?: string[];
  // The child workstreams its steps wait for, in step and pass order; a
  // step's last one is the one it waits for now.
  children?: { step: string; pass: number; slug: string }[];
  steps?: Record<string, unknown>;
  events?: RunEvent[];
  summary?: {
    status: string;
    currentStep?: string;
    started?: string;
    lastEvent?: string;
    ownerWaitMs: number;
    routesBack: { time: string; from: string; to: string }[];
    // Set when the owner closed the workstream with `fuse-flow close`.
    closed?: { date: string; at: string; reason: string };
    steps: Record<
      string,
      { status: string; activeMs: number; ownerWaitMs: number; visits: number; skipReason?: string }
    >;
  };
}

// One project whose runs Komposer shows: the one it was started on (current),
// one in ~/.konductor/projects.yml, or the example runs that ship with
// Komposer (example).
export interface ProjectSummary {
  path: string;
  name: string;
  current: boolean;
  // The project's own workflow folder, where fuse-flow looks up a workflow
  // name in its runs first.
  workflowsDir: string;
  example?: boolean;
  runs?: number;
  // The registered folder no longer exists.
  missing?: boolean;
  // Why the project's runs cannot be read.
  error?: string;
}

// A run's identity across projects: slugs repeat between projects.
export const runKey = (run: Pick<WorkstreamSummary, "project" | "slug">): string => `${run.project}/${run.slug}`;

// The drag-and-drop type of a library entry dragged from the Library tab.
export const ARTIFACT_DRAG = "application/x-komposer-artifact";

// Where a new artifact goes unless the author says otherwise.
export function suggestPath(id: string): string {
  return id === "code" ? "." : `.konductor/{slug}/${id}.md`;
}

// G/T/R presence for one artifact id, resolved project > personal > package.
export function resolveLibrary(
  entries: LibraryEntry[],
  artifactId: string,
): { level: LibraryEntry["level"]; g: boolean; t: boolean; r: boolean } | null {
  const order: LibraryEntry["level"][] = ["project", "user", "package"];
  const candidates = entries.filter((e) => e.id === artifactId);
  for (const level of order) {
    const e = candidates.find((c) => c.level === level);
    if (e) {
      const t = Object.keys(e.files).some((f) => f.startsWith("template."));
      return { level, g: !!e.files["guide.md"], t, r: !!e.files["review.md"] };
    }
  }
  return null;
}
