// SPDX-License-Identifier: Apache-2.0
// Kanvas's calls to Komposer's server, with the session token of api.ts.

import { ApiError, token } from "../api.ts";
import type { Anchor, CommentState, KanvasComment, KanvasState } from "./model.ts";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/kanvas${path}`, {
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
  state: () => call<KanvasState>("GET", ""),
  eventsUrl: () => `/api/kanvas/events?token=${encodeURIComponent(token)}`,
  addComment: (target: string, anchor: Anchor, body: string) => call<KanvasComment>("POST", "/comments", { target, anchor, body }),
  setState: (id: number, state: CommentState) => call<KanvasComment>("PUT", "/comments", { id, state }),
  deleteComment: (id: number) => call<{ deleted: number }>("DELETE", "/comments", { id }),
  select: (target: string | null, anchor: Anchor | null) =>
    call<unknown>("PUT", "/selection", target && anchor ? { target, anchor } : {}),
};
