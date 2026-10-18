// SPDX-License-Identifier: Apache-2.0
// The Workstreams page's right rail: every project whose workstreams
// Komposer shows, as a divider that opens and closes, with its workstreams
// beneath; and "Add projects", which looks for workstreams in a folder and
// the folders below it. fuse-flow adds a project by itself when it writes a
// workstream there; adding by hand is for workstreams older than that.

import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { api, type ProjectSummary, type WorkstreamSummary } from "./api.ts";
import { useFolderState } from "./folders.ts";
import { RUN_STATE } from "./runView.ts";
import { projectCount, rowTiming, stateOf, workstreamKey, type ProjectGroup } from "./model/workstreams.ts";
import { Chevron } from "./WorkflowList.tsx";

// The workflow a workstream follows, by its file name without .yml.
export const workflowStem = (w: WorkstreamSummary) =>
  (w.workflowPath?.split("/").pop() ?? w.workflow ?? "").replace(/\.ya?ml$/, "");

export function ProjectList({
  title,
  groups,
  filtered,
  filterFile,
  error,
  selectedKey,
  onSelect,
  onChanged,
  onMessage,
  problemOf,
}: {
  // The selected workflow's file, or "All workstreams".
  title: string;
  groups: ProjectGroup<ProjectSummary, WorkstreamSummary>[];
  // Whether the rows are only those of one workflow, filterFile.
  filtered: boolean;
  filterFile: string;
  // Why the projects file could not be read.
  error?: string;
  selectedKey: string | null;
  onSelect: (workstream: WorkstreamSummary) => void;
  // Called after projects were added or removed, to reload.
  onChanged: () => void;
  onMessage: (message: string) => void;
  // Why fuse-flow cannot read a workstream, or undefined.
  problemOf: (workstream: WorkstreamSummary) => string | undefined;
}) {
  const sections = useFolderState("komposer-projects");
  const [adding, setAdding] = useState(false);

  const remove = async (project: ProjectSummary) => {
    try {
      await api.removeProject(project.path);
      onMessage(`Removed ${project.name} from the projects list`);
      onChanged();
    } catch (e) {
      onMessage(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <aside className="ws-rail" aria-label="Workstreams">
      <div className="ws-rail-head">
        <div className="ws-rail-heading">
          <span className="ws-rail-title">{title}</span>
          <span className="ws-rail-sub">
            {groups.length} project{groups.length === 1 ? "" : "s"}
          </span>
        </div>
        <button
          type="button"
          className="ws-add-projects"
          title="Look for workstreams in a folder and the four folder levels below it"
          onClick={() => setAdding(true)}
        >
          <FolderPlus size={15} strokeWidth={1.75} /> Add projects
        </button>
      </div>
      <div className="ws-rail-list">
        {error && <div className="lane-projects-error">{error}</div>}
        {groups.map((group) => {
          const { project } = group;
          const open = sections.isOpen(`project:${project.path}`, project.name, true);
          const tag = project.current ? "this project" : project.example ? "examples" : "";
          return (
            <div key={project.path} className="ws-project">
              <div className="ws-project-head">
                <button
                  type="button"
                  className="ws-project-toggle lane-toggle"
                  aria-expanded={open}
                  title={project.path}
                  onClick={() => sections.toggle(`project:${project.path}`, project.name, true)}
                >
                  <Chevron open={open} />
                  <span className="lane-group-label">{project.name}</span>
                  {tag && <span className="ws-project-tag">{tag}</span>}
                  <span
                    className={`ws-project-count${project.missing || project.error ? " is-missing" : ""}`}
                    title={project.error}
                  >
                    {projectCount(group, filtered)}
                  </span>
                </button>
                {!project.current && !project.example && (
                  <button
                    type="button"
                    className="ws-project-remove"
                    title={`Remove ${project.name} from the list; its workstreams stay where they are`}
                    onClick={() => remove(project)}
                  >
                    Remove
                  </button>
                )}
              </div>
              {open && (
                <>
                  {group.rows.map(({ workstream, depth }) => {
                    const key = workstreamKey(workstream);
                    const state = RUN_STATE[stateOf(workstream)];
                    const reason = problemOf(workstream) ?? "";
                    return (
                      <button
                        key={key}
                        type="button"
                        className={`ws-row${key === selectedKey ? " is-current" : ""}`}
                        style={depth ? { paddingLeft: `${10 + 18 * depth}px` } : undefined}
                        title={reason || workstream.workflowPath}
                        onClick={() => onSelect(workstream)}
                      >
                        <span className={`ws-dot ${state.className}`} />
                        <span className="ws-row-main">
                          <span className="ws-row-slug">
                            {depth > 0 && <span className="ws-row-child">↳ </span>}
                            {workstream.slug}
                          </span>
                          <span className="ws-row-file">{reason ? "cannot be read" : workflowStem(workstream)}</span>
                        </span>
                        <span className="ws-row-side">
                          {/* A state file that cannot be read has no state to show. */}
                          {workstream.summary && <span className={`run-state-pill ${state.className}`}>{state.label}</span>}
                          {workstream.summary && <span className="ws-row-time">{rowTiming(workstream)}</span>}
                        </span>
                      </button>
                    );
                  })}
                  {!project.missing && !project.error && group.rows.length === 0 && (
                    <div className="ws-empty">{filtered ? `no workstreams of ${filterFile}` : "no workstreams"}</div>
                  )}
                  {project.error && <div className="lane-projects-error">{project.error}</div>}
                </>
              )}
            </div>
          );
        })}
      </div>
      {adding && (
        <AddProjectsModal
          onClose={() => setAdding(false)}
          onAdded={(message, stay) => {
            if (!stay) setAdding(false);
            onMessage(message);
            onChanged();
          }}
        />
      )}
    </aside>
  );
}

// onAdded's stay keeps the dialog open, as when the search stopped early and
// says so.
function AddProjectsModal({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string, stay?: boolean) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { found, added, truncated } = await api.addProjects(path);
      // The search stops at a folder limit; what it found is kept, but more may lie beyond it.
      const partly = truncated ? " The search stopped after 20,000 folders, so some projects may be missing." : "";
      if (!found.length) setError(`No fuse-flow workstreams in this folder or the four folder levels below it.${partly}`);
      else if (!added.length) setError(`Found ${found.length} project${found.length === 1 ? "" : "s"} there, all listed already.${partly}`);
      else {
        const message = `Added ${added.length} project${added.length === 1 ? "" : "s"}.`;
        if (partly) setError(`${message}${partly}`);
        onAdded(message, !!partly);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-modal add-projects-modal" role="dialog" aria-labelledby="add-projects-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2 id="add-projects-title">Add projects</h2>
          <button className="icon-mini" title="Close" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <label className="field">
          <span className="field-label-row">Folder</span>
          <input
            className="field-input mono-input"
            value={path}
            autoFocus
            placeholder="~/workspace"
            onChange={(e) => {
              setPath(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        <p className="modal-text">Looks for fuse-flow workstreams in this folder and up to four folder levels below it.</p>
        {error && <div className="field-error">{error}</div>}
        <div className="modal-actions">
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" disabled={!path.trim() || busy} onClick={submit}>
            {busy ? "Looking…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
