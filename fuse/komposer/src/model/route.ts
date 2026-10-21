// SPDX-License-Identifier: Apache-2.0
// The URL path of what the app shows: the page, then the selected workflow,
// so the browser's back and forward buttons move between pages and
// workflows, and a link opens the same view.
//
//   /<page>/<location>/<folder>/<file>    a workflow of the three locations
//   /<page>/run/<absolute path>           another project's workflow file
//
// Each segment is URI-encoded. A path that names no page shows the first
// page, Present.

import type { WorkflowFile } from "../workflowView.ts";

// The pages in the order the page switcher shows them, which is also the
// order of keys 1 to 4. The first is the page Komposer opens on.
export const PAGE_IDS = ["present", "compare", "edit", "workstreams"] as const;
export type Page = (typeof PAGE_IDS)[number];
export const DEFAULT_PAGE: Page = PAGE_IDS[0];

const isPage = (s: string | undefined): s is Page => (PAGE_IDS as readonly string[]).includes(s ?? "");

// A workflow's place in the URL, decoded: its location, then its folder and
// file, or "run" and its path.
export function workflowRoute(w: Pick<WorkflowFile, "location" | "dir" | "file" | "path">): string {
  const segments = w.location === "run" ? w.path.split("/") : [...w.dir.split("/"), w.file];
  return [w.location, ...segments.filter(Boolean)].join("/");
}

// The URL path for a page and its selected workflow.
export function routePath(page: Page, workflow: Pick<WorkflowFile, "location" | "dir" | "file" | "path"> | null): string {
  const segments = workflow ? workflowRoute(workflow).split("/") : [];
  return `/${[page, ...segments].map(encodeURIComponent).join("/")}`;
}

// The page and the workflow (as workflowRoute gives it) a URL path names;
// workflow is null when the path names none, or cannot be decoded.
export function parseRoute(pathname: string): { page: Page; workflow: string | null } {
  const [first, ...rest] = pathname.split("/").filter(Boolean);
  const page = isPage(first) ? first : DEFAULT_PAGE;
  const raw = isPage(first) ? rest : [];
  try {
    const decoded = raw.map(decodeURIComponent);
    return { page, workflow: decoded.length > 1 ? decoded.join("/") : null };
  } catch {
    return { page, workflow: null };
  }
}

// The listed workflow a route names, if one is listed.
export function routedWorkflow<W extends Pick<WorkflowFile, "location" | "dir" | "file" | "path">>(
  workflows: W[],
  route: string | null,
): W | undefined {
  return route === null ? undefined : workflows.find((w) => workflowRoute(w) === route);
}

// A history entry's state: its place in this tab's history, n, counted
// from the entry the app first wrote, so a refused back or forward can be
// undone with history.go; and the project the entry's workflow names
// resolve in, when it was opened by following a link (appState, LinkContext).
export type EntryState = { n: number; project?: string };

export const entryState = (n: number, project: string | undefined): EntryState => (project ? { n, project } : { n });

const field = (state: unknown, key: string): unknown =>
  typeof state === "object" && state !== null ? (state as Record<string, unknown>)[key] : undefined;

export function entryProject(state: unknown): string | undefined {
  const project = field(state, "project");
  return typeof project === "string" && project ? project : undefined;
}

// The entry's place, or undefined for an entry the app did not write.
export function entryIndex(state: unknown): number | undefined {
  const n = field(state, "n");
  return Number.isInteger(n) ? (n as number) : undefined;
}
