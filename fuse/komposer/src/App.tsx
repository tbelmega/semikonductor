// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import { BookOpen, FileCode, Settings2, X } from "lucide-react";
import {
  api,
  ApiError,
  runKey,
  suggestPath,
  type LibraryEntry,
  type ProjectSummary,
  type ReviewGuides,
  type WorkstreamSummary,
} from "./api.ts";
import { type Edit, type OutputMode } from "./model/yamlEdit.ts";
import { diskChangeWatcher } from "./model/diskChange.ts";
import { mergeListed } from "./model/listedWorkflows.ts";
import { givesWay } from "./model/readOnlyView.ts";
import type { UnavailableWorkflow } from "./model/workflowLinks.ts";
import { copyWrite, editedWorkflow } from "./model/editWorkflow.ts";
import { addArtifactEdits, describeFrom, insertArtifactStepEdits } from "./model/artifactInstruction.ts";
import {
  artifactCount,
  linkTo,
  openWorkflow,
  routeBackCount,
  stepViews,
  workflowHandOffs,
  workflowInputs,
  workflowKey,
  type LocationId,
  type OpenWorkflow,
  type Session,
} from "./workflowView.ts";
import { problemsByStep, problemsForText } from "./validate.ts";
import { WorkflowList } from "./WorkflowList.tsx";
import { ProjectList } from "./ProjectList.tsx";
import { ComparePage, compareOrder, ModeSwitch, type Mode } from "./ComparePage.tsx";
import { defaultComparePair, swapPair } from "./model/compare.ts";
import { Flow } from "./Flow.tsx";
import { Inspector, type InspectorTab } from "./Inspector.tsx";
import { RunLinkButton } from "./Links.tsx";
import { dateTime, duration, projectName, RUN_STATE, runDuration, runOption, runState } from "./runView.ts";

type SaveModal = { type: "save"; asNew: boolean; location: LocationId; folder: string; name: string; error?: string };
type NewModal = { type: "new"; location: LocationId; folder: string; name: string; error?: string };
type Modal = SaveModal | NewModal;
type DiskVersion = { text: string; hash: string; at: string };

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [workflows, setWorkflows] = useState<OpenWorkflow[]>([]);
  // Another project's workflow files and folders that cannot be read; a link
  // to a name they hold leads to them, shown as unavailable.
  const [unavailable, setUnavailable] = useState<UnavailableWorkflow[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [workstreams, setWorkstreams] = useState<WorkstreamSummary[]>([]);
  const [projects, setProjects] = useState<{ projects: ProjectSummary[]; error?: string }>({ projects: [] });
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tab, setTab] = useState<InspectorTab>("step");
  // The detail drawer on the right. Closed until something needs its detail
  // view: a selected step, the library, a run, the workflow's settings or YAML.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const showTab = (next: InspectorTab) => {
    setTab(next);
    setDrawerOpen(true);
  };
  const [compareRequest, setCompareRequest] = useState(0);
  // The open run, by its runKey.
  const [openRunKey, setOpenRunKey] = useState<string | null>(null);
  // The workflow last opened by itself (from the list or by following a
  // link), not with a run; another project's file opened so stays open.
  const [linkedKey, setLinkedKey] = useState<string | null>(null);
  // Edit mode is the editor; compare mode shows two workflows side by side.
  const [mode, setMode] = useState<Mode>("edit");
  const [comparePair, setComparePair] = useState<[string | null, string | null]>([null, null]);
  const [error, setError] = useState<string | null>(null);
  const [showPaths, setShowPaths] = useState(false);
  const [showDescriptions, setShowDescriptions] = useState(true);
  const [hoveredArtifact, setHoveredArtifact] = useState<string | null>(null);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const [modal, setModal] = useState<Modal | null>(null);
  const [diskVersions, setDiskVersions] = useState<Record<string, DiskVersion>>({});
  const [toast, setToast] = useState("");
  const toastTimer = useRef<number | undefined>(undefined);

  const showToast = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2400);
  };
  const replaceWorkflow = (key: string, next: OpenWorkflow) =>
    setWorkflows((all) => all.map((w) => (workflowKey(w) === key ? next : w)));
  const reloadData = async () => {
    const [s, w, l, ws, p] = await Promise.all([
      api.session(),
      api.workflows(),
      api.library(),
      api.workstreams(),
      api.projects(),
    ]);
    const opened = w.workflows.map((file) => openWorkflow(file));
    const first = opened.find((x) => x.location !== "run");
    setSession(s);
    setWorkflows(opened);
    setUnavailable(w.unavailable);
    setLibrary(l.entries);
    setWorkstreams(ws.workstreams);
    setProjects(p);
    setCurrentKey((key) =>
      key && opened.some((x) => workflowKey(x) === key) ? key : first ? workflowKey(first) : null,
    );
  };
  useEffect(() => {
    reloadData().catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  // After a project is added or removed: its runs, the projects and the
  // other projects' workflow files. The open workflows of the three
  // locations stay as they are, since the listing can lack edits whose
  // working copy is still to be written.
  const refreshProjects = async () => {
    const [w, ws, p] = await Promise.all([api.workflows(), api.workstreams(), api.projects()]);
    setWorkflows((all) => mergeListed(all, w.workflows, (file) => openWorkflow(file)));
    setUnavailable(w.unavailable);
    setWorkstreams(ws.workstreams);
    setProjects(p);
  };

  // Escape closes the drawer, unless a dialog is open.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !modal) setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  const workflow = useMemo(() => workflows.find((w) => workflowKey(w) === currentKey) ?? null, [workflows, currentKey]);
  const steps = useMemo(() => (workflow ? stepViews(workflow) : []), [workflow]);
  const problems = useMemo(() => (workflow ? problemsForText(workflow.openText) : []), [workflow]);
  const byStep = useMemo(() => problemsByStep(problems), [problems]);
  const dirty = !!workflow && workflow.openText !== workflow.text;
  const disk = currentKey ? diskVersions[currentKey] : undefined;
  const runsForWorkflow = workflow ? workstreams.filter((item) => item.workflowPath === workflow.path) : [];
  const run = openRunKey ? runsForWorkflow.find((item) => runKey(item) === openRunKey) : undefined;
  // The workflow file of another project: shown with one of its runs, or
  // after a link to it was followed, and never edited or saved.
  const readOnly = workflow?.location === "run";
  // Shown, not edited: a run is open, or the file is read-only.
  const viewOnly = !!run || readOnly;
  const localWorkflows = useMemo(() => workflows.filter((w) => w.location !== "run"), [workflows]);
  const openedByLink = !!currentKey && linkedKey === currentKey;

  // A workflow that is no longer listed, or a read-only one whose run is gone
  // (closed, or no longer listed) and that no link opened, gives way to the
  // first workflow of the three locations.
  useEffect(() => {
    if (!localWorkflows[0]) return;
    if (givesWay({ listed: !!workflow, readOnly, hasRun: !!run, openedByLink })) openWorkflowKey(workflowKey(localWorkflows[0]));
  }, [!!workflow, readOnly, !!run, openedByLink, localWorkflows]);

  // Working copies are the crash-safe form of every edit; equal text removes it.
  useEffect(() => {
    if (!workflow || readOnly) return;
    const timer = window.setTimeout(() => {
      const op =
        workflow.openText === workflow.text
          ? api.deleteWorkingCopy(workflow.path)
          : api.putWorkingCopy(workflow.path, workflow.openText);
      op.catch((e) => showToast(e instanceof Error ? e.message : String(e)));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [workflow?.path, workflow?.openText, workflow?.text, readOnly]);

  // The review guides the engine gives the open text's agent gates. Asked
  // again shortly after each edit; a failed request leaves the last answer.
  const [guides, setGuides] = useState<{ path: string; result: ReviewGuides } | null>(null);
  const reviewGuides = guides && guides.path === workflow?.path ? guides.result : null;
  useEffect(() => {
    if (!workflow || readOnly) return;
    let current = true;
    const timer = window.setTimeout(() => {
      api
        .reviewGuides(workflow.path, workflow.openText)
        .then((result) => current && setGuides({ path: workflow.path, result }))
        .catch(() => {});
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [workflow?.path, workflow?.openText, readOnly]);

  // The workflows as last rendered, for handlers that finish after an await:
  // their closure may predate a save that completed meanwhile.
  const workflowsRef = useRef(workflows);
  workflowsRef.current = workflows;

  // Watch the open original. Clean files reload silently; dirty files retain
  // their text and get the conflict banner, unless the file now holds exactly
  // the open text, which is what Komposer's own Save produces. Only the
  // answer to the newest change is acted on (diskChangeWatcher).
  useEffect(() => {
    if (!workflow?.onDisk || readOnly) return;
    const key = workflowKey(workflow);
    const path = workflow.path;
    const watcher = diskChangeWatcher({
      open: () => workflowsRef.current.find((w) => workflowKey(w) === key),
      fetch: async () => (await api.workflows()).workflows.find((w) => w.path === path),
      apply: (action, open, listed) => {
        if (action === "conflict") {
          setDiskVersions((all) => ({
            ...all,
            [key]: {
              text: listed.text,
              hash: listed.hash,
              at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
          }));
          return;
        }
        replaceWorkflow(
          key,
          action === "reload"
            ? openWorkflow(listed)
            : openWorkflow({ ...open, text: listed.text, hash: listed.hash, workingCopy: undefined }, true),
        );
        setDiskVersions((all) => {
          if (!(key in all)) return all;
          const next = { ...all };
          delete next[key];
          return next;
        });
      },
    });
    const source = new EventSource(api.watchUrl(path));
    source.addEventListener("change", (event) => {
      const change = JSON.parse((event as MessageEvent).data) as { hash: string | null };
      void watcher.change(change.hash);
    });
    return () => {
      watcher.close();
      source.close();
    };
  }, [workflow?.path, workflow?.onDisk, readOnly]);

  // Compare mode's copy: edits any workflow, not only the open one, and
  // stores the result as copyWrite says.
  const applyTo = (key: string, list: Edit[], message: string) => {
    const target = workflows.find((w) => workflowKey(w) === key);
    if (!target) return;
    if (!list.length) return showToast(message);
    try {
      const next = editedWorkflow(target, list);
      replaceWorkflow(key, next);
      const write = copyWrite(next, currentKey);
      if (write === "autosave") return showToast(message);
      (write === "delete" ? api.deleteWorkingCopy(next.path) : api.putWorkingCopy(next.path, next.openText))
        .then(() => showToast(message))
        .catch((e) => showToast(e instanceof Error ? e.message : String(e)));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  // Applies one edit, or several in order as one change: either all apply or none.
  const apply = (edits: Edit | Edit[]) => {
    if (!workflow || !currentKey || readOnly) return;
    const list = Array.isArray(edits) ? edits : [edits];
    try {
      replaceWorkflow(currentKey, editedWorkflow(workflow, list));
      for (const edit of list) {
        if (edit.op === "insertStep") {
          setSelectedIndex(edit.at);
          showTab("step");
        }
        if (edit.op === "moveStep") setSelectedIndex(edit.to);
        if (edit.op === "deleteStep")
          setSelectedIndex((i) => Math.max(0, Math.min(i > edit.index ? i - 1 : i, steps.length - 2)));
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  // Adding an artifact pre-fills a generated instruction.
  const addArtifact = (step: number, mode: OutputMode, artifact: string, path = suggestPath(artifact)) => {
    if (!workflow) return;
    try {
      apply(addArtifactEdits(workflow.openText, step, mode, artifact, path, describeFrom(library)));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  const insertArtifactStep = (at: number, artifact: string) => {
    if (!workflow) return;
    try {
      apply(insertArtifactStepEdits(workflow.openText, at, artifact, suggestPath(artifact), describeFrom(library)));
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  const uniqueStepId = () => {
    let id = "new-step",
      n = 2;
    while (steps.some((s) => s.id === id)) id = `new-step-${n++}`;
    return id;
  };
  const openCompare = () => {
    const keys = compareOrder(workflows).map(workflowKey);
    const kept = comparePair.every((key) => key !== null && keys.includes(key));
    if (!kept) setComparePair(defaultComparePair(keys, currentKey));
    setDrawerOpen(false);
    setProblemsOpen(false);
    setMode("compare");
  };
  const switchMode = (next: Mode) => (next === "compare" ? openCompare() : setMode("edit"));
  const openWorkflowKey = (key: string) => {
    setMode("edit");
    setCurrentKey(key);
    setLinkedKey(key);
    setSelectedIndex(0);
    setTab("step");
    setDrawerOpen(false);
    setCompareRequest(0);
    setOpenRunKey(null);
    setProblemsOpen(false);
  };

  const discard = async () => {
    if (!workflow || !currentKey) return;
    await api.deleteWorkingCopy(workflow.path);
    const base = disk ? { text: disk.text, hash: disk.hash } : { text: workflow.text, hash: workflow.hash };
    replaceWorkflow(currentKey, openWorkflow({ ...workflow, ...base, workingCopy: undefined }, true));
    setDiskVersions((all) => {
      const next = { ...all };
      delete next[currentKey];
      return next;
    });
    showToast(`Discarded changes to ${workflow.file}`);
  };

  const openRun = (key: string) => {
    setOpenRunKey(key);
    showTab("run");
    setProblemsOpen(false);
  };
  // A run from the projects list: open the workflow file it follows with it.
  const openRunOfAnyWorkflow = (item: WorkstreamSummary) => {
    setMode("edit");
    const target = item.workflowPath ? workflows.find((w) => w.path === item.workflowPath) : undefined;
    if (!target) {
      showToast(`The workflow of ${item.slug}, ${item.workflow}, is not found in ${item.project}`);
      return;
    }
    if (workflowKey(target) !== currentKey) {
      setCurrentKey(workflowKey(target));
      setLinkedKey(null);
      setSelectedIndex(0);
      setCompareRequest(0);
    }
    openRun(runKey(item));
  };
  const closeRun = () => {
    setOpenRunKey(null);
    setCompareRequest(0);
    setTab("step");
  };
  const openWorkflowStep = (key: string, stepIndex: number) => {
    setMode("edit");
    setCurrentKey(key);
    setLinkedKey(key);
    setSelectedIndex(stepIndex);
    setOpenRunKey(null);
    setCompareRequest(0);
    showTab("step");
  };
  // A workflow reference of the open workflow (a hand-off, a workflow gate),
  // resolved the way fuse-flow resolves it: a name in the workflows of the
  // open run's project, else of the project the open file belongs to.
  const linkProject = run?.project ?? (readOnly ? workflow?.project : undefined) ?? session?.root;
  const linkDir = projects.projects.find((p) => p.path === linkProject)?.workflowsDir ?? session?.locations[0].path ?? "";
  const resolveLink = (ref: string) => linkTo(ref, workflow!, workflows, linkDir, unavailable);
  // Compare mode shows this project's workflows only, so their references resolve here.
  const localLinkDir = projects.projects.find((p) => p.path === session?.root)?.workflowsDir ?? session?.locations[0].path ?? "";
  const resolveLocalLink = (ref: string, from: OpenWorkflow) => linkTo(ref, from, workflows, localLinkDir, unavailable);
  // A linked run (the run a run came after, its parent, a child) is named by
  // slug, so it is looked up in the open run's project.
  const findRun = (slug: string) =>
    workstreams.find((item) => item.project === (run?.project ?? session?.root) && item.slug === slug);
  // Opens a linked run, in the workflow it follows.
  const openAnyRun = (slug: string) => {
    setMode("edit");
    const target = findRun(slug);
    if (!target) {
      showToast(`Workstream ${slug} is not one Komposer lists.`);
      return;
    }
    setProblemsOpen(false);
    openRunOfAnyWorkflow(target);
  };

  const createNew = () => setModal({ type: "new", location: "project", folder: "", name: "" });
  const confirmNew = () => {
    if (!session || modal?.type !== "new" || !/^[a-z0-9][a-z0-9-]*$/.test(modal.name)) return;
    const location = session.locations.find((x) => x.id === modal.location)!;
    const dir = modal.folder ? `${modal.folder.replace(/^\/+|\/+$/g, "")}/` : "";
    const file = `${modal.name}.yml`;

    if (workflows.some((w) => w.location === modal.location && w.dir === dir.replace(/\/$/, "") && w.file === file)) {
      setModal({ ...modal, error: "A workflow with this file name exists there." });
      return;
    }
    const text = `version: 1\nname: ${modal.name}\nsteps:\n  - id: new-step\n    instruction: >\n      \n`;
    const created = openWorkflow({
      location: modal.location,
      dir: dir.replace(/\/$/, ""),
      file,
      path: `${location.path}/${dir}${file}`,
      onDisk: false,
      text: "",
      hash: "",
      workingCopy: text,
    });
    setWorkflows((all) => [...all, created]);
    setMode("edit");
    setCurrentKey(workflowKey(created));
    setSelectedIndex(0);
    showTab("step");
    setModal(null);
  };

  const openSave = () =>
    workflow &&
    setModal({
      type: "save",
      asNew: !workflow.onDisk,
      location: workflow.location === "run" ? "project" : workflow.location,
      folder: workflow.dir,
      name: workflow.file.replace(/\.ya?ml$/, ""),
    });
  const save = async () => {
    if (!workflow || !currentKey || modal?.type !== "save") return;
    try {
      if (modal.asNew) {
        const result = await api.saveNewWorkflow(modal.location, modal.folder, modal.name, workflow.openText);
        await api.deleteWorkingCopy(workflow.path);
        const dir = modal.folder.replace(/^\/+|\/+$/g, "");
        const file = `${modal.name}.yml`;
        const saved = openWorkflow({
          location: modal.location,
          dir,
          file,
          path: result.path,
          onDisk: true,
          text: workflow.openText,
          hash: result.hash,
        });
        setWorkflows((all) =>
          all.flatMap((entry) => {
            if (workflowKey(entry) !== currentKey) return [entry];
            if (!workflow.onDisk) return [saved];
            // The original as it is on disk now: its disk version when the
            // file changed underneath the working copy.
            const base = disk ? { text: disk.text, hash: disk.hash } : {};
            const original = openWorkflow({ ...workflow, ...base, workingCopy: undefined }, true);
            return [original, saved];
          }),
        );
        setDiskVersions((all) => {
          const next = { ...all };
          delete next[currentKey];
          return next;
        });
        setCurrentKey(workflowKey(saved));
        showToast(`Saved ${result.path}`);
      } else {
        const result = await api.updateWorkflow(workflow.path, workflow.hash, workflow.openText);
        await api.deleteWorkingCopy(workflow.path);
        replaceWorkflow(
          currentKey,
          openWorkflow({ ...workflow, text: workflow.openText, hash: result.hash, workingCopy: undefined }, true),
        );
        setDiskVersions((all) => {
          const next = { ...all };
          delete next[currentKey];
          return next;
        });
        showToast(`Updated ${workflow.path}`);
      }
      setModal(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !modal.asNew) {
        const listed = (await api.workflows()).workflows.find((w) => w.path === workflow.path);
        if (listed)
          setDiskVersions((all) => ({
            ...all,
            [currentKey]: {
              text: listed.text,
              hash: listed.hash,
              at: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
            },
          }));
        setModal(null);
      } else setModal({ ...modal, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const loadDisk = async () => {
    if (!workflow || !currentKey || !disk) return;
    await api.deleteWorkingCopy(workflow.path);
    replaceWorkflow(
      currentKey,
      openWorkflow({ ...workflow, text: disk.text, hash: disk.hash, workingCopy: undefined }, true),
    );
    setDiskVersions((all) => {
      const next = { ...all };
      delete next[currentKey];
      return next;
    });
    showToast("Loaded disk version");
  };
  const keepEdits = () => {
    if (!workflow || !currentKey || !disk) return;
    replaceWorkflow(
      currentKey,
      openWorkflow({ ...workflow, text: disk.text, hash: disk.hash, workingCopy: workflow.openText }, true),
    );
    setDiskVersions((all) => {
      const next = { ...all };
      delete next[currentKey];
      return next;
    });
    showToast("Kept my edits");
  };

  if (error) return <div className="app-error">Failed to load Komposer: {error}</div>;
  if (!session || !workflow) return <div className="app-loading">Loading…</div>;
  const status = run
    ? "run · read-only"
    : readOnly
      ? "another project · read-only"
      : !workflow.onDisk
      ? "new · working copy"
      : dirty
        ? "modified · working copy"
        : "saved";
  const activeRuns = workstreams.filter((w) => w.workflowPath === workflow.path && w.summary?.status !== "COMPLETED");
  const structural = structureChanges(workflow, steps);

  return (
    <div className={`screen${drawerOpen && mode === "edit" ? " has-drawer" : ""}`}>
      <WorkflowList
        workflows={workflows}
        currentKey={mode === "compare" ? null : currentKey}
        onOpen={openWorkflowKey}
        workstreams={workstreams}
        onNew={createNew}
        footer={
          <ProjectList
            projects={projects.projects}
            error={projects.error}
            workstreams={workstreams}
            currentRun={run ? runKey(run) : null}
            onOpenRun={openRunOfAnyWorkflow}
            onChanged={() => refreshProjects().catch((e) => showToast(e instanceof Error ? e.message : String(e)))}
            onMessage={showToast}
          />
        }
        onCompare={openCompare}
        compareActive={mode === "compare"}
      />
      {mode === "compare" ? (
        <div className="center">
          <ComparePage
            workflows={workflows}
            library={library}
            leftKey={comparePair[0]}
            rightKey={comparePair[1]}
            onPick={(side, key) => setComparePair(([l, r]) => (side === "left" ? [key, r] : [l, key]))}
            onEdit={openWorkflowKey}
            onMode={switchMode}
            onSwap={() => setComparePair(swapPair)}
            onApply={applyTo}
            resolveLink={resolveLocalLink}
          />
        </div>
      ) : (
      <div className="center">
        <div className="center-header">
          <div className="center-header-main">
            <div className="center-header-title">{workflow.file}</div>
            <div className="center-header-sub">
              <span className={`center-header-status${dirty ? " is-dirty" : ""}`}>{status}</span>
              <span className="center-header-path mono">{workflow.path}</span>
            </div>
          </div>
          <ModeSwitch mode="edit" onMode={switchMode} />
          {!viewOnly && problems.length > 0 && (
            <button className="problems-chip" onClick={() => setProblemsOpen((v) => !v)}>
              {problems.length} problem{problems.length === 1 ? "" : "s"}
            </button>
          )}
          {!viewOnly && dirty && workflow.onDisk && (
            <button className="discard-btn" onClick={discard}>
              Discard changes
            </button>
          )}
          {!viewOnly && (
            <button
              className={`save-btn${dirty && !problems.length ? " is-enabled" : " is-disabled"}`}
              disabled={!dirty || !!problems.length}
              title={problems.length ? "Fix the problems to save" : ""}
              onClick={openSave}
            >
              Save…
            </button>
          )}
          {problemsOpen && (
            <div className="problems-popover">
              {problems.map((p, i) => (
                <button
                  key={i}
                  className="problems-popover-row"
                  onClick={() => {
                    if (p.stepIndex >= 0) {
                      setSelectedIndex(p.stepIndex);
                      showTab("step");
                    }
                    setProblemsOpen(false);
                  }}
                >
                  <span className="mono">
                    {p.stepIndex >= 0 ? `${p.stepIndex + 1} · ${steps[p.stepIndex]?.id ?? ""}` : "workflow"}
                  </span>
                  <span className="problems-popover-msg">{p.message}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        {disk && (
          <div className="disk-banner">
            <span>
              {workflow.file} changed on disk at {disk.at}. Your working copy has unsaved edits.
            </span>
            <button
              onClick={() => {
                showTab("yaml");
                setCompareRequest((request) => request + 1);
              }}
            >
              Compare
            </button>
            <button onClick={loadDisk}>Load disk version</button>
            <button className="keep" onClick={keepEdits}>
              Keep my edits
            </button>
          </div>
        )}
        <div className="toolbar">
          <span className="toolbar-counts">
            {steps.length} steps · {artifactCount(steps)} artifacts · {routeBackCount(steps)} routes back
          </span>
          <span className="grow" />
          <button className={`toggle-pill-btn${showPaths ? " is-on" : ""}`} onClick={() => setShowPaths((v) => !v)}>
            paths
          </button>
          <button
            className={`toggle-pill-btn${showDescriptions ? " is-on" : ""}`}
            onClick={() => setShowDescriptions((v) => !v)}
          >
            descriptions
          </button>
          <select
            className="runs-select"
            value={run ? runKey(run) : ""}
            onChange={(event) => (event.target.value ? openRun(event.target.value) : closeRun())}
          >
            <option value="">{runsForWorkflow.length ? `Runs · ${runsForWorkflow.length}` : "No runs"}</option>
            {runsForWorkflow.map((item) => (
              <option key={runKey(item)} value={runKey(item)}>
                {runOption(item, session.root)}
              </option>
            ))}
          </select>
        </div>
        {run && <RunBanner run={run} root={session.root} onClose={closeRun} findRun={findRun} onOpenRun={openAnyRun} />}
        <Flow
          steps={steps}
          selectedIndex={drawerOpen ? selectedIndex : -1}
          onSelect={(i) => {
            setSelectedIndex(i);
            showTab(run ? "run" : readOnly ? "yaml" : "step");
          }}
          problemsByStep={byStep}
          library={library}
          showPaths={showPaths}
          showDescriptions={showDescriptions}
          hoveredArtifact={hoveredArtifact}
          onHoverArtifact={setHoveredArtifact}
          onInsert={(at) => apply({ op: "insertStep", at, step: { id: uniqueStepId(), instruction: "" } })}
          onAppend={() => apply({ op: "insertStep", at: steps.length, step: { id: uniqueStepId(), instruction: "" } })}
          onMove={(from, to) => apply({ op: "moveStep", from, to })}
          onDelete={(index) => apply({ op: "deleteStep", index })}
          onDropArtifact={(step, artifact) => addArtifact(step, "produces", artifact)}
          onDropArtifactAt={insertArtifactStep}
          run={run}
          readOnly={readOnly}
          inputs={workflowInputs(workflow)}
          handOffs={workflowHandOffs(workflow)}
          linkTo={resolveLink}
          onOpenWorkflow={openWorkflowKey}
          findRun={findRun}
          onOpenRun={openAnyRun}
        />
        {!drawerOpen && (
          <div className="drawer-fabs">
            {(run || !readOnly) && (
              <button className="drawer-fab" title="Workflow settings and runs" onClick={() => showTab(run ? "run" : "workflow")}>
                <Settings2 size={16} /> {run ? "Run" : "Workflow"}
              </button>
            )}
            <button className="drawer-fab" title="The workflow file" onClick={() => showTab("yaml")}>
              <FileCode size={16} /> YAML
            </button>
            {!viewOnly && (
              <button className="drawer-fab is-primary" title="Artifact guides, templates and review guides" onClick={() => showTab("library")}>
                <BookOpen size={16} /> Library
              </button>
            )}
          </div>
        )}
      </div>
      )}
      {drawerOpen && mode === "edit" && (
      <Inspector
        tab={tab}
        onTab={(next) => {
          setTab(next);
          if (next !== "yaml") setCompareRequest(0);
          setProblemsOpen(false);
        }}
        workflow={workflow}
        steps={steps}
        selectedIndex={selectedIndex}
        problems={problems.filter((p) => p.stepIndex === selectedIndex)}
        library={library}
        workstreams={workstreams}
        root={session.root}
        diffBase={disk?.text ?? workflow.text}
        compareRequest={compareRequest}
        onEdit={apply}
        onAddArtifact={addArtifact}
        reviewGuides={reviewGuides}
        allWorkflows={localWorkflows}
        run={run}
        readOnly={readOnly}
        onOpenRun={openRun}
        onOpenAnyRun={openAnyRun}
        findRun={findRun}
        linkTo={resolveLink}
        onOpenWorkflow={openWorkflowKey}
        onOpenWorkflowStep={openWorkflowStep}
        onClose={() => setDrawerOpen(false)}
      />
      )}
      {modal && (
        <ModalView
          modal={modal}
          setModal={setModal}
          session={session}
          workflow={workflow}
          structural={structural}
          activeRuns={activeRuns}
          onConfirm={modal.type === "new" ? confirmNew : save}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function RunBanner({
  run,
  root,
  onClose,
  findRun,
  onOpenRun,
}: {
  run: WorkstreamSummary;
  root: string;
  onClose: () => void;
  findRun: (slug: string) => WorkstreamSummary | undefined;
  onOpenRun: (slug: string) => void;
}) {
  const info = RUN_STATE[runState(run.summary?.status)];
  const linked = run.after || run.parent || (run.startedAfter?.length ?? 0) > 0;
  return (
    <div className="run-banner">
      <div className="run-banner-head">
        <strong>{run.slug}</strong>
        <span className={`run-state-pill ${info.className}`}>{info.label}</span>
        <span>
          started {dateTime(run.summary?.started)} · {duration(runDuration(run))}
          {run.project !== root && <span title={run.project}> · in {projectName(run.project)}</span>}
        </span>
        <button onClick={onClose}>Close run</button>
      </div>
      {linked && (
        <div className="run-banner-links">
          {run.parent && (
            <span>
              child of step <span className="mono">{run.parent.step}</span> of
              <RunLinkButton slug={run.parent.slug} run={findRun(run.parent.slug)} onOpen={onOpenRun} />
            </span>
          )}
          {run.after && (
            <span>
              started after
              <RunLinkButton slug={run.after} run={findRun(run.after)} onOpen={onOpenRun} />
            </span>
          )}
          {(run.startedAfter?.length ?? 0) > 0 && (
            <span>
              started after it
              {run.startedAfter!.map((slug) => (
                <RunLinkButton key={slug} slug={slug} run={findRun(slug)} onOpen={onOpenRun} />
              ))}
            </span>
          )}
        </div>
      )}
      <div className="run-legend">
        {Object.values(RUN_STATE).map((state) => (
          <span key={state.className}>
            <i className={state.className} />
            {state.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function ModalView({
  modal,
  setModal,
  session,
  workflow,
  structural,
  activeRuns,
  onConfirm,
}: {
  modal: Modal;
  setModal: (m: Modal | null) => void;
  session: Session;
  workflow: OpenWorkflow;
  structural: string[];
  activeRuns: WorkstreamSummary[];
  onConfirm: () => void;
}) {
  const asNew = modal.type === "new" || modal.asNew;
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(modal.name);
  const location = session.locations.find((x) => x.id === modal.location)!;
  const preview = `${location.path}/${modal.folder ? `${modal.folder.replace(/^\/+|\/+$/g, "")}/` : ""}${modal.name || "…"}.yml`;
  const warning = modal.type === "save" && !modal.asNew && structural.length > 0 && activeRuns.length > 0;
  const patch = (fields: Partial<Modal>) => setModal({ ...modal, ...fields } as Modal);
  return (
    <div className="modal-backdrop" onClick={() => setModal(null)}>
      <div className="save-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2>{modal.type === "new" ? "New workflow" : `Save ${workflow.file}`}</h2>
          <button className="icon-mini" onClick={() => setModal(null)}>
            <X />
          </button>
        </div>
        {modal.type === "save" && (
          <div className="save-options">
            <button
              className={!modal.asNew ? "is-selected" : ""}
              onClick={() => patch({ asNew: false, error: undefined })}
            >
              <strong>Update original</strong>
              <small>{workflow.path}</small>
            </button>
            <button
              className={modal.asNew ? "is-selected" : ""}
              onClick={() => patch({ asNew: true, error: undefined })}
            >
              <strong>Save as new file</strong>
              <small>leaves {workflow.file} as it is</small>
            </button>
          </div>
        )}
        {asNew && (
          <>
            <div className="segmented">
              {session.locations.map((x) => (
                <button
                  key={x.id}
                  className={`segmented-opt${modal.location === x.id ? " is-active" : ""}`}
                  onClick={() => patch({ location: x.id })}
                >
                  {x.id === "fuse-flow" ? "fuse-flow" : x.id}
                </button>
              ))}
            </div>
            <label className="field">
              <span className="field-label-row">Folder</span>
              <input
                className="field-input"
                value={modal.folder}
                onChange={(e) => patch({ folder: e.target.value, error: undefined })}
              />
            </label>
            <label className="field">
              <span className="field-label-row">File name</span>
              <input
                className="field-input mono-input"
                value={modal.name}
                onChange={(e) => patch({ name: e.target.value, error: undefined })}
                data-error={!!modal.name && !valid}
              />
            </label>
            <div className="target-preview">{preview}</div>
            {modal.name && !valid && <div className="field-error">Lower-case letters, digits and hyphens.</div>}
          </>
        )}
        {warning && (
          <div className="workstream-warning">
            <strong>
              {activeRuns.length} workstream{activeRuns.length === 1 ? "" : "s"} in progress on this workflow. Progress
              is stored by step id.
            </strong>
            {activeRuns.map((run) => (
              <div key={run.slug}>
                {run.slug} · {run.summary?.status.toLowerCase().replaceAll("_", " ")}
                {run.summary?.currentStep ? ` at ${run.summary.currentStep}` : ""}
              </div>
            ))}
            <div>{structural.join(" · ")}</div>
          </div>
        )}
        {modal.error && <div className="field-error">{modal.error}</div>}
        <div className="modal-actions">
          <button onClick={() => setModal(null)}>Cancel</button>
          <button className="primary-button" disabled={asNew && !valid} onClick={onConfirm}>
            {modal.type === "new" ? "Create" : warning ? "Save anyway" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function structureChanges(workflow: OpenWorkflow, currentSteps: ReturnType<typeof stepViews>): string[] {
  const current = workflow.stepKeys.map((key, index) => ({ key, id: currentSteps[index]?.id ?? "", index }));
  const out: string[] = [];
  workflow.savedSteps.forEach((saved) => {
    const now = current.find((step) => step.key === saved.key);
    if (!now) {
      out.push(`deleted ${saved.id}`);
      return;
    }
    if (now.id !== saved.id) out.push(`renamed ${saved.id} → ${now.id}`);
  });
  current
    .filter((step) => !workflow.savedSteps.some((saved) => saved.key === step.key))
    .forEach((step) => out.push(`added ${step.id}`));

  const savedCommon = workflow.savedSteps.filter((saved) => current.some((step) => step.key === saved.key));
  const currentCommon = current.filter((step) => workflow.savedSteps.some((saved) => saved.key === step.key));
  savedCommon.forEach((saved, savedRank) => {
    const currentRank = currentCommon.findIndex((step) => step.key === saved.key);
    if (currentRank === savedRank) return;
    const now = currentCommon[currentRank];
    const savedIndex = workflow.savedSteps.findIndex((step) => step.key === saved.key);
    out.push(`moved ${now.id} ${savedIndex + 1} → ${now.index + 1}`);
  });
  return out;
}
