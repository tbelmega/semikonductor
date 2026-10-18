// SPDX-License-Identifier: Apache-2.0
// Left lane: the workflow list grouped Project / Personal / fuse-flow, with
// sections and folder rows that open and close (kept in localStorage),
// search, and New. While searching, every match is shown. On the Workstreams
// page the lane also offers "All workstreams" and the workflows of other
// projects that workstreams follow, and each row counts its workstreams. On
// the Compare page the selected row is tagged "left", the right workflow's
// row "right", and every other row offers "as right". What a location holds
// that fuse-flow cannot use (a folder that cannot be searched, a file that
// cannot be read, a link whose target is missing), and a working copy or
// working-copy folder that cannot be read, is listed at the end of its
// section, with the reason, so it is not hidden.

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { folderPrefixes, useFolderState } from "./folders.ts";
import type { LibraryEntry, WorkstreamSummary } from "./api.ts";
import { gateCount, workflowKey, type OpenWorkflow, type WorkflowLocation } from "./workflowView.ts";
import { problemsForText } from "./validate.ts";
import { stepViews } from "./workflowView.ts";
import { laneCount, plural } from "./model/workstreams.ts";
import { projectName } from "./runView.ts";
import type { UnavailableWorkflow } from "./model/workflowLinks.ts";

const LOCATION_LABEL: Record<WorkflowLocation, string> = {
  project: "Project",
  personal: "Personal",
  "fuse-flow": "fuse-flow",
  run: "Other projects",
};
export const LOCATION_ROOT: Record<WorkflowLocation, string> = {
  project: ".konductor/workflows/",
  personal: "~/.konductor/workflows/",
  "fuse-flow": "fuse-flow/workflows/",
  run: "opened with their workstreams",
};

function stem(file: string) {
  return file.replace(/\.ya?ml$/, "");
}

// A workflow's path inside its location, by which the lane sorts and
// searches: a folder's files sort with the names next to it, as "docs/" does
// among the files beside the folder.
const inLocation = (w: OpenWorkflow) => (w.dir ? `${w.dir}/${w.file}` : w.file);

// An unavailable entry's path inside its location, or the whole path when
// the location's folder is unknown or the entry lies outside it.
const shownPath = (path: string, root: string | undefined) =>
  root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : root === path ? "./" : path;

export type LaneMode = "edit" | "workstreams";

// An unavailable entry as the server lists it. Besides the kinds the link
// resolver reads, it sends "working-copy" for a working copy, its base
// record or a working-copy folder that cannot be read, and "link" for a link
// whose target is missing.
type ListedUnavailable = Omit<UnavailableWorkflow, "kind"> & { kind: string };

// What the row of an unavailable entry says, before the reason. A working
// copy that cannot be read is left where it is, not removed.
const UNAVAILABLE_NOTE: Record<string, { meta: string; dot: string }> = {
  folder: { meta: "folder cannot be searched", dot: "Cannot be used" },
  "working-copy": { meta: "unsaved edits here cannot be read and are kept", dot: "Working copy cannot be read" },
};
const unavailableNote = (kind: string) => UNAVAILABLE_NOTE[kind] ?? { meta: "cannot be used", dot: "Cannot be used" };

export function WorkflowList({
  mode,
  workflows,
  currentKey,
  onOpen,
  workstreams,
  onNew,
  allWorkstreams,
  onAllWorkstreams,
  compareRight,
  onCompareRight,
  unavailable = [],
  locationPaths = {},
}: {
  mode: LaneMode;
  workflows: OpenWorkflow[];
  // The selected workflow; null shows no row selected.
  currentKey: string | null;
  onOpen: (key: string) => void;
  workstreams: WorkstreamSummary[];
  onNew: () => void;
  // The Workstreams page's "All workstreams" row.
  allWorkstreams?: boolean;
  onAllWorkstreams?: () => void;
  // The Compare page's right workflow (null when it has none); undefined on
  // the other pages.
  compareRight?: string | null;
  onCompareRight?: (key: string) => void;
  // What the three locations hold that cannot be used, as the server lists it.
  unavailable?: ListedUnavailable[];
  // Each location's folder, by which an unavailable entry's path is shown.
  locationPaths?: Partial<Record<WorkflowLocation, string>>;
}) {
  const comparing = compareRight !== undefined;
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const order: WorkflowLocation[] = mode === "workstreams" ? ["project", "personal", "fuse-flow", "run"] : ["project", "personal", "fuse-flow"];

  const groups = order
    .map((loc) => {
      const inLoc = workflows
        .filter((w) => w.location === loc && (!q || inLocation(w).toLowerCase().includes(q)))
        .sort((a, b) => inLocation(a).localeCompare(inLocation(b)));
      const root = locationPaths[loc];
      const broken = unavailable
        .filter((u) => u.location === loc && (!q || u.path.toLowerCase().includes(q)))
        .map((u) => ({ ...u, shown: shownPath(u.path, root) }))
        .sort((a, b) => a.shown.localeCompare(b.shown));
      return { loc, workflows: inLoc, broken };
    });
  const shownGroups = groups.filter((g) => g.workflows.length > 0 || g.broken.length > 0);

  const folders = useFolderState("komposer-workflow-folders");
  // A section or folder is shown open while searching, so no match is hidden.
  const sectionOpen = (loc: WorkflowLocation) => !!q || folders.isOpen(`${loc}:`, "", true);
  const folderOpen = (loc: WorkflowLocation, prefix: string, name: string) => !!q || folders.isOpen(`${loc}:${prefix}`, name);

  return (
    <div className="lane">
      <div className="lane-search">
        <input
          className="input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workflows"
          aria-label="Search workflows"
        />
        <button className="new-workflow-btn" title="New workflow" onClick={onNew}>
          + New
        </button>
      </div>
      <div className="lane-list">
        {mode === "workstreams" && (
          <button
            className={`lane-all${allWorkstreams ? " is-current" : ""}`}
            title="Show the workstreams of every workflow"
            onClick={onAllWorkstreams}
          >
            <span className="lane-all-label">All workstreams</span>
            <span className="lane-all-count">
              {workstreams.length} workstream{workstreams.length === 1 ? "" : "s"}
            </span>
          </button>
        )}
        {shownGroups.map((group) => {
          const shownFolders = new Set<string>();
          return (
            <div key={group.loc}>
              <button
                className="lane-group-head lane-toggle"
                aria-expanded={sectionOpen(group.loc)}
                title={LOCATION_ROOT[group.loc]}
                onClick={() => folders.toggle(`${group.loc}:`, "", true)}
              >
                <Chevron open={sectionOpen(group.loc)} />
                <span className="lane-group-label">{LOCATION_LABEL[group.loc]}</span>
                <span className="lane-group-root">{LOCATION_ROOT[group.loc]}</span>
              </button>
              {sectionOpen(group.loc) &&
                group.workflows.map((w) => {
                  const key = workflowKey(w);
                  const parts = folderPrefixes(w.dir);
                  const folderRows: React.ReactNode[] = [];
                  // A row is shown when every folder above it is open.
                  let visible = true;
                  parts.forEach(({ prefix, name }, depth) => {
                    if (!visible) return;
                    const open = folderOpen(group.loc, prefix, name);
                    if (!shownFolders.has(prefix)) {
                      shownFolders.add(prefix);
                      folderRows.push(
                        <button
                          key={prefix}
                          className="lane-folder-row lane-toggle"
                          aria-expanded={open}
                          style={{ paddingLeft: `${8 + depth * 12}px` }}
                          onClick={() => folders.toggle(`${group.loc}:${prefix}`, name)}
                        >
                          <Chevron open={open} />
                          {name}/
                        </button>,
                      );
                    }
                    visible = open;
                  });
                  if (!visible) return <div key={key}>{folderRows}</div>;
                  const readOnly = w.location === "run";
                  const steps = stepViews(w);
                  const problemCount = readOnly ? 0 : problemsForText(w.openText).length;
                  const dirty = !readOnly && (!w.onDisk || w.openText !== w.text);
                  const counted = mode === "workstreams" ? laneCount(w, workstreams) : null;
                  const meta = counted
                    ? `${counted.text}${readOnly && w.project ? ` · ${projectName(w.project)}` : ""}`
                    : `${plural(steps.length, "step")} · ${plural(gateCount(steps), "gate")}`;
                  const isLeft = key === currentKey;
                  const isRight = comparing && key === compareRight;
                  const asRight = comparing && !isLeft && !isRight;
                  return (
                    <div key={key}>
                      {folderRows}
                      <div className="lane-row-wrap">
                        <button
                          className={`lane-row${isLeft ? " is-current" : ""}${isRight ? " is-right" : ""}${asRight ? " has-as-right" : ""}${counted && !counted.count ? " is-faded" : ""}`}
                          onClick={() => onOpen(key)}
                          title={w.path}
                          style={{ paddingLeft: `${10 + parts.length * 12}px` }}
                        >
                          <span className="lane-row-head">
                            <span className="lane-row-name">{stem(w.file)}</span>
                            {problemCount > 0 && <span className="dot dot-problem" title="Has problems" />}
                            {dirty && <span className="dot dot-unsaved" title="Unsaved changes" />}
                            {comparing && isLeft && <span className="lane-row-tag is-left">left</span>}
                            {isRight && <span className="lane-row-tag is-right">right</span>}
                          </span>
                          <span className="lane-row-meta">{meta}</span>
                        </button>
                        {asRight && (
                          <button className="lane-as-right" title="Compare against this workflow, on the right" onClick={() => onCompareRight?.(key)}>
                            as right
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              {sectionOpen(group.loc) &&
                group.broken.map((u) => (
                  <div key={`unavailable:${u.path}`} className="lane-row lane-row-unavailable" title={`${u.path}: ${u.reason}`}>
                    <span className="lane-row-head">
                      <span className="lane-row-name">{u.shown}</span>
                      <span className="dot dot-problem" title={unavailableNote(u.kind).dot} />
                    </span>
                    <span className="lane-row-meta">
                      {unavailableNote(u.kind).meta}: {u.reason}
                    </span>
                  </div>
                ))}
            </div>
          );
        })}
        {shownGroups.length === 0 && <div className="lane-empty">No match.</div>}
      </div>
    </div>
  );
}

// The 12px chevron of a section that opens and closes; it turns 90° when open.
export function Chevron({ open }: { open: boolean }) {
  return <ChevronRight size={12} strokeWidth={2.25} className={`lane-chevron${open ? " is-open" : ""}`} />;
}

export type { LibraryEntry };
