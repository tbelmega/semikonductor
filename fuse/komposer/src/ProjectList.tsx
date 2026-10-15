// SPDX-License-Identifier: Apache-2.0
// The Projects section at the bottom of the left lane: every project whose
// runs Komposer shows, each opening to its runs, plus "Add projects", which
// looks for runs in a folder and the folders below it. fuse-flow adds a
// project by itself when it writes a run there; adding by hand is for
// projects whose runs are older than that.

import { useState } from "react";
import { FolderPlus, X } from "lucide-react";
import { api, runKey, type ProjectSummary, type WorkstreamSummary } from "./api.ts";
import { useFolderState } from "./folders.ts";
import { RUN_STATE, runState } from "./runView.ts";
import { Chevron } from "./WorkflowList.tsx";

export function ProjectList({
  projects,
  error,
  workstreams,
  currentRun,
  onOpenRun,
  onChanged,
  onMessage,
}: {
  projects: ProjectSummary[];
  // Why the projects file could not be read.
  error?: string;
  workstreams: WorkstreamSummary[];
  // The runKey of the open run.
  currentRun: string | null;
  onOpenRun: (run: WorkstreamSummary) => void;
  // Called after projects were added or removed, to reload.
  onChanged: () => void;
  onMessage: (message: string) => void;
}) {
  const sections = useFolderState("komposer-projects");
  const [adding, setAdding] = useState(false);
  const open = sections.isOpen("projects:", "", true);

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
    <div className="lane-projects">
      <div className="lane-projects-head">
        <button className="lane-group-head lane-toggle" aria-expanded={open} onClick={() => sections.toggle("projects:", "", true)}>
          <Chevron open={open} />
          <span className="lane-group-label">Projects</span>
          <span className="lane-group-root">{projects.length}</span>
        </button>
        <button className="icon-mini" title="Add projects" aria-label="Add projects" onClick={() => setAdding(true)}>
          <FolderPlus size={15} />
        </button>
      </div>
      {open && (
        <div className="lane-projects-list">
          {error && <div className="lane-projects-error">{error}</div>}
          {projects.map((project) => {
            const runs = workstreams.filter((w) => w.project === project.path);
            const expanded = sections.isOpen(`project:${project.path}`, project.name, project.current);
            return (
              <div key={project.path}>
                <div className="lane-project-row">
                  <button
                    className="lane-folder-row lane-toggle"
                    aria-expanded={expanded}
                    title={
                      project.current
                        ? `${project.path}, the project Komposer was started on`
                        : project.example
                          ? `${project.path}: made-up runs of the custom-example workflows, which ship with Komposer`
                          : project.path
                    }
                    onClick={() => sections.toggle(`project:${project.path}`, project.name, project.current)}
                  >
                    <Chevron open={expanded} />
                    <span className="lane-project-name">{project.name}</span>
                    <span className="lane-project-meta">
                      {project.missing ? "folder not found" : `${project.runs ?? 0} run${project.runs === 1 ? "" : "s"}`}
                    </span>
                  </button>
                  {!project.current && !project.example && (
                    <button
                      className="icon-mini lane-project-remove"
                      title={`Remove ${project.path} from the list; its runs stay where they are`}
                      aria-label={`Remove ${project.name}`}
                      onClick={() => remove(project)}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="lane-project-runs">
                    {runs.map((run) => {
                      const state = RUN_STATE[runState(run.summary?.status)];
                      const reason = run.error ?? (!run.workflowPath ? `its workflow ${run.workflow} is not found` : "");
                      return (
                        <button
                          key={runKey(run)}
                          className={`lane-run-row${runKey(run) === currentRun ? " is-current" : ""}`}
                          disabled={!!reason}
                          title={reason || `${run.workflowPath}`}
                          onClick={() => onOpenRun(run)}
                        >
                          <span className="lane-run-head">
                            <i className={`lane-run-dot ${state.className}`} />
                            <span className="mono">{run.slug}</span>
                          </span>
                          <span className="lane-row-meta">
                            {reason ? "cannot be shown" : `${run.workflow} · ${state.label}`}
                          </span>
                        </button>
                      );
                    })}
                    {!project.missing && runs.length === 0 && <div className="lane-empty">No runs.</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {adding && (
        <AddProjectsModal
          onClose={() => setAdding(false)}
          onAdded={(message) => {
            setAdding(false);
            onMessage(message);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function AddProjectsModal({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const { found, added } = await api.addProjects(path);
      if (!found.length) setError("No fuse-flow runs in this folder or the four folder levels below it.");
      else if (!added.length) setError(`Found ${found.length} project${found.length === 1 ? "" : "s"}, all of them listed already.`);
      else onAdded(`Added ${added.length} project${added.length === 1 ? "" : "s"}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="save-modal" role="dialog" aria-labelledby="add-projects-title" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2 id="add-projects-title">Add projects</h2>
          <button className="icon-mini" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        <p className="modal-text">
          Komposer looks for fuse-flow runs in this folder and up to four folder levels below it, and adds every project
          that has runs. fuse-flow adds a project by itself when it writes a run there, so this is only needed for runs
          from before that.
        </p>
        <label className="field">
          <span className="field-label-row">Folder</span>
          <input
            className="field-input mono-input"
            value={path}
            autoFocus
            placeholder="~/workplace"
            onChange={(e) => {
              setPath(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </label>
        {error && <div className="field-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary-button" disabled={!path.trim() || busy} onClick={submit}>
            {busy ? "Looking…" : "Add"}
          </button>
        </div>
      </div>
    </div>
  );
}
