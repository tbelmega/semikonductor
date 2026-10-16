// SPDX-License-Identifier: Apache-2.0
// Links to another workflow (a hand-off, a workflow gate) or another
// workstream (its parent, the one it came after, its children). Komposer
// never draws one workflow inside another: it links to it, and a click opens
// it in place of the current one.

import type { WorkflowLink } from "./workflowView.ts";

// A workflow reference as written, opening the workflow it resolves to; one
// that does not resolve is shown with the reason and does nothing, as
// unavailable when it leads to a file or folder that cannot be read.
export function WorkflowLinkButton({
  refText,
  link,
  onOpen,
  when,
}: {
  refText: string;
  link: WorkflowLink;
  onOpen: (key: string) => void;
  // A hand-off's condition, shown after the link.
  when?: string;
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
      {refText} {link.ok ? "→" : link.unavailable ? "· unavailable" : "· not found"}
      {when && <span className="workflow-link-when">when {when}</span>}
    </button>
  );
}

// A linked workstream by slug; one Komposer does not list is shown as not found.
export function WorkstreamLinkButton({
  slug,
  found,
  onOpen,
}: {
  slug: string;
  found: boolean;
  onOpen: (slug: string) => void;
}) {
  return (
    <button
      type="button"
      className={`workstream-link${found ? "" : " is-unresolved"}`}
      title={found ? `Show workstream ${slug}` : `No workstream ${slug} in this project`}
      aria-disabled={!found}
      onClick={() => found && onOpen(slug)}
    >
      {slug}
    </button>
  );
}
