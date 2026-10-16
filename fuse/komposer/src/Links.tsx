// SPDX-License-Identifier: Apache-2.0
// Links to another workflow (a hand-off, a workflow gate) or another
// workstream (the one a run came after, its parent, its children). Komposer
// never draws one workflow inside another: it links to it, and a click opens
// it in place of the current one.

import type { WorkstreamSummary } from "./api.ts";
import { RUN_STATE, runState } from "./runView.ts";
import type { WorkflowLink } from "./workflowView.ts";

// A workflow reference as written, opening the workflow it resolves to; one
// that does not resolve is shown with the reason and does nothing, as
// unavailable when it leads to a file or folder that cannot be read.
export function WorkflowLinkButton({
  refText,
  link,
  onOpen,
}: {
  refText: string;
  link: WorkflowLink;
  onOpen: (key: string) => void;
}) {
  return (
    <button
      type="button"
      className={`workflow-link${link.ok ? "" : " is-unresolved"}`}
      title={link.ok ? `Open ${link.path}` : link.reason}
      aria-disabled={!link.ok}
      onClick={(event) => {
        event.stopPropagation();
        if (link.ok) onOpen(link.key);
      }}
    >
      <span className="mono">{refText}</span>
      <span aria-hidden="true">{link.ok ? "↗" : link.unavailable ? "unavailable" : "not found"}</span>
    </button>
  );
}

// A workstream by slug, with its state, opening its run; one Komposer does
// not list (deleted, or unreadable) is shown as not found.
export function RunLinkButton({
  slug,
  run,
  onOpen,
  detail,
}: {
  slug: string;
  run?: WorkstreamSummary;
  onOpen: (slug: string) => void;
  detail?: string;
}) {
  const openable = !!run?.workflowPath;
  const state = run?.summary ? RUN_STATE[runState(run.summary.status)] : undefined;
  return (
    <button
      type="button"
      className={`run-link${openable ? "" : " is-unresolved"}`}
      title={
        openable
          ? `Open the run of ${slug}${run?.workflow ? ` (${run.workflow})` : ""}`
          : run
            ? `${slug}: ${run.error ?? "its workflow does not resolve"}`
            : `no workstream ${slug}`
      }
      aria-disabled={!openable}
      onClick={(event) => {
        event.stopPropagation();
        if (openable) onOpen(slug);
      }}
    >
      <span className="mono">{slug}</span>
      {detail && <span className="run-link-detail">{detail}</span>}
      {state ? (
        <span className={`run-state-pill ${state.className}`}>{state.label}</span>
      ) : (
        <span className="run-link-detail">{run ? "unreadable" : "not found"}</span>
      )}
    </button>
  );
}
