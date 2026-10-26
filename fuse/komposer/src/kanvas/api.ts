// SPDX-License-Identifier: Apache-2.0
// Kanvas's calls to Komposer's server, with the session token of api.ts.
// Every call but projects() names the project whose design/ folder it is for.

import { ApiError, token } from "../api.ts";
import type { Anchor, CommentState, KanvasComment, KanvasProjects, KanvasState } from "./model.ts";

async function call<T>(method: string, path: string, project: string | null, body?: unknown): Promise<T> {
  const query = project ? `?project=${encodeURIComponent(project)}` : "";
  const res = await fetch(`/api/kanvas${path}${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const answer = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, answer.error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const kanvasApi = {
  projects: () => call<KanvasProjects>("GET", "/projects", null),
  state: (project: string) => call<KanvasState>("GET", "", project),
  eventsUrl: (project: string) => `/api/kanvas/events?token=${encodeURIComponent(token)}&project=${encodeURIComponent(project)}`,
  addComment: (project: string, target: string, anchor: Anchor, body: string) =>
    call<KanvasComment>("POST", "/comments", project, { target, anchor, body }),
  setState: (project: string, id: number, state: CommentState) => call<KanvasComment>("PUT", "/comments", project, { id, state }),
  deleteComment: (project: string, id: number) => call<{ deleted: number }>("DELETE", "/comments", project, { id }),
  select: (project: string, target: string | null, anchor: Anchor | null) =>
    call<unknown>("PUT", "/selection", project, target && anchor ? { target, anchor } : {}),
};
