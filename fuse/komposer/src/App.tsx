// SPDX-License-Identifier: Apache-2.0
// The app: the top bar, the page switcher's pages, and the state they share.
// One workflow is selected for every page; the Edit page edits it, and the
// Workstreams page shows its workstreams. The Compare page shows it on the
// left, against any other workflow on the right, and edits it there. The
// Present page shows it read-only, optionally next to a second workflow.

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
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
import { editedWorkflow } from "./model/editWorkflow.ts";
import { selectionAfterMove } from "./model/stepSelection.ts";
import { plural, workstreamLinkDir } from "./model/workstreams.ts";
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
import { LOCATION_ROOT, WorkflowList } from "./WorkflowList.tsx";
import { Compare } from "./Compare.tsx";
import { compareOrder, comparePair, comparePick } from "./model/compare.ts";
import { Flow } from "./Flow.tsx";
import { RailPanel, RailStrip, type RailTab, type WorkflowView } from "./Inspector.tsx";
import { TopBar, PAGES, type Page } from "./TopBar.tsx";
import { Workstreams, type WorkstreamView } from "./Workstreams.tsx";
import { Present } from "./Present.tsx";
import { ALL_SHOWN, escapeAction, secondOptions, shownSecond, type FlowShow } from "./model/present.ts";
import { projectName } from "./runView.ts";

type SaveModal = { type: "save"; asNew: boolean; location: LocationId; folder: string; name: string; error?: string };
type NewModal = { type: "new"; location: LocationId; folder: string; name: string; error?: string };
type Modal = SaveModal | NewModal;
type DiskVersion = { text: string; hash: string; at: string };

// Whether a key press goes to a text field rather than to the page.
const typingIn = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [workflows, setWorkflows] = useState<OpenWorkflow[]>([]);
  // Another project's workflow files and folders that cannot be read; a link
  // to a name they hold leads to them, shown as unavailable.
  const [unavailable, setUnavailable] = useState<UnavailableWorkflow[]>([]);
  const [library, setLibrary] = useState<LibraryEntry[]>([]);
  const [workstreams, setWorkstreams] = useState<WorkstreamSummary[]>([]);
  const [projects, setProjects] = useState<{ projects: ProjectSummary[]; error?: string }>({ projects: [] });
  const [page, setPage] = useState<Page>("edit");
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  // The Edit page's right rail: closed until a strip button or a step opens it.
  const [railOpen, setRailOpen] = useState(false);
  const [railTab, setRailTab] = useState<RailTab>("workflow");
  const [workflowView, setWorkflowView] = useState<WorkflowView>("form");
  const showTab = (next: RailTab) => {
    setRailTab(next);
    setRailOpen(true);
  };
  // The Workstreams page: every workflow's workstreams or the selected one's,
  // the selected workstream by runKey, and how it is shown.
  const [allWorkstreams, setAllWorkstreams] = useState(false);
  const [workstreamKeySelected, setWorkstreamKeySelected] = useState<string | null>(null);
  const [workstreamView, setWorkstreamView] = useState<WorkstreamView>("summary");
  // The Compare page: its right workflow by key (the left one is the
  // selected workflow), and its two toggles.
  const [compareRight, setCompareRight] = useState<string | null>(null);
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  // A step Compare must bring into view (a problem was picked); n tells
  // repeated picks of the same step apart.
  const [compareReveal, setCompareReveal] = useState<{ index: number; n: number } | null>(null);
  const [allInstructions, setAllInstructions] = useState(false);
  // The Present page: what its diagrams show, the workflow chosen to show
  // next to the selected one, and which drawers are pinned open.
  const [presentShow, setPresentShow] = useState<FlowShow>(ALL_SHOWN);
  const [presentSecond, setPresentSecond] = useState<string | null>(null);
  const [leftPinned, setLeftPinned] = useState(false);
  const [rightPinned, setRightPinned] = useState(false);
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
  // After a project is added or removed: its workstreams, the projects and
  // the other projects' workflow files. The open workflows of the three
  // locations stay as they are, since the listing can lack edits whose
  // working copy is still to be written.
  const refreshProjects = async () => {
    const [w, ws, p] = await Promise.all([api.workflows(), api.workstreams(), api.projects()]);
    setWorkflows((all) => mergeListed(all, w.workflows, (file) => openWorkflow(file)));
    setUnavailable(w.unavailable);
    setWorkstreams(ws.workstreams);
    setProjects(p);
  };

  const workflow = useMemo(() => workflows.find((w) => workflowKey(w) === currentKey) ?? null, [workflows, currentKey]);
  const steps = useMemo(() => (workflow ? stepViews(workflow) : []), [workflow]);
  const problems = useMemo(() => (workflow ? problemsForText(workflow.openText) : []), [workflow]);
  const byStep = useMemo(() => problemsByStep(problems), [problems]);
  const dirty = !!workflow && workflow.openText !== workflow.text;
  const disk = currentKey ? diskVersions[currentKey] : undefined;
  // The workflow file a workstream of another project follows: shown, never
  // edited or saved.
  const readOnly = workflow?.location === "run";
  const localWorkflows = useMemo(() => workflows.filter((w) => w.location !== "run"), [workflows]);
  const selected = selectedIndex !== null && selectedIndex < steps.length ? selectedIndex : null;

  // Keys 1 to 4 switch pages, when focus is not in a field. Escape does what
  // escapeAction says: leave a field, close the rail, clear the selection,
  // or on Present un-pin the drawers.
  const pinned = leftPinned || rightPinned;
  const keyState = useRef({ modal, railOpen, selected, page, pinned, goPage: (_: Page) => {} });
  keyState.current = { modal, railOpen, selected, page, pinned, goPage: (next: Page) => goPage(next) };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const now = keyState.current;
      if (now.modal || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") {
        const action = escapeAction({ ...now, typing: typingIn(event.target) });
        if (action === "blur") (event.target as HTMLElement).blur();
        if (action === "close-rail") setRailOpen(false);
        if (action === "clear-selection") setSelectedIndex(null);
        if (action === "unpin") {
          setLeftPinned(false);
          setRightPinned(false);
        }
        return;
      }
      if (typingIn(event.target)) return;
      const target = PAGES[Number(event.key) - 1];
      if (/^[1-4]$/.test(event.key) && target?.built) now.goPage(target.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
        if (edit.op === "moveStep") setSelectedIndex((i) => selectionAfterMove(i, edit.from, edit.to));
        if (edit.op === "deleteStep")
          setSelectedIndex((i) => (i === null || i === edit.index ? null : i > edit.index ? i - 1 : i));
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  // An apply on the Compare page: edits of the selected (left) workflow as one
  // change, which the autosave stores like any other edit, and its message.
  // No edits shows only the message, the reason it was refused. After a step
  // was added, removed or moved, the step selection is cleared.
  const applyCompare = (list: Edit[], message: string, clearSelection: boolean) => {
    if (!list.length || !workflow || !currentKey || readOnly) return showToast(message);
    try {
      replaceWorkflow(currentKey, editedWorkflow(workflow, list));
      if (clearSelection) {
        setSelectedIndex(null);
        if (railTab === "step") setRailOpen(false);
      }
      showToast(message);
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
  // Selects a workflow for every page. The step selection belongs to the
  // workflow it was made in, so it is cleared, and a panel that needs it closes.
  const selectWorkflow = (key: string) => {
    if (key === currentKey) return;
    setCurrentKey(key);
    setSelectedIndex(null);
    setProblemsOpen(false);
    const next = workflows.find((w) => workflowKey(w) === key);
    if (railTab === "step" || (railTab === "library" && next?.location === "run")) setRailOpen(false);
  };
  // A selected workflow that is no longer listed, as after its project was
  // removed, gives way to the first workflow of the three locations. Another
  // project's file is selected by itself here (from the lane or a link),
  // never with a workstream open, so it otherwise stays until something else
  // is selected.
  useEffect(() => {
    if (!currentKey || !localWorkflows[0]) return;
    if (givesWay({ listed: !!workflow, readOnly, hasRun: false, openedByLink: true })) selectWorkflow(workflowKey(localWorkflows[0]));
  }, [currentKey, !!workflow, readOnly, localWorkflows]);
  // The Compare page's two workflows: the selected workflow on the left, and
  // its own right side, kept while it is listed.
  const compareList = useMemo(() => compareOrder(workflows), [workflows]);
  const shownPair = comparePair(compareList.map(workflowKey), currentKey, compareRight);
  // A selected workflow that Compare does not offer (another project's)
  // gives way to the left side Compare shows, so the rail edits that one.
  const openCompare = () => {
    setCompareRight(shownPair[1]);
    if (shownPair[0] !== null && shownPair[0] !== currentKey) selectWorkflow(shownPair[0]);
    setProblemsOpen(false);
    setPage("compare");
  };
  const pickCompare = (side: "left" | "right" | "swap", key?: string) => {
    const next = comparePick(shownPair, side, key);
    setCompareRight(next.right);
    if (next.select !== null) selectWorkflow(next.select);
  };
  const goPage = (next: Page) => (next === "compare" ? openCompare() : setPage(next));
  // A workflow opened from another page: selected, on the Edit page.
  const editWorkflow = (key: string) => {
    selectWorkflow(key);
    setPage("edit");
  };
  const openWorkflowStep = (key: string, stepIndex: number) => {
    selectWorkflow(key);
    setSelectedIndex(stepIndex);
    showTab("step");
  };
  const selectStep = (index: number) => {
    setSelectedIndex(index);
    setProblemsOpen(false);
    if (readOnly) return;
    setRailTab((tab) => (!railOpen || tab === "workflow" ? "step" : tab));
    setRailOpen(true);
  };
  // A workflow reference of the open workflow (a hand-off, a workflow gate),
  // resolved the way fuse-flow resolves it: a name in the workflows of the
  // project the open file belongs to when it is another project's file, else
  // of this project.
  const linkProject = (readOnly ? workflow?.project : undefined) ?? session?.root;
  const linkDir = projects.projects.find((p) => p.path === linkProject)?.workflowsDir ?? session?.locations[0].path ?? "";
  const resolveLink = (ref: string) => linkTo(ref, workflow!, workflows, linkDir, unavailable);
  const localLinkDir = projects.projects.find((p) => p.path === session?.root)?.workflowsDir ?? session?.locations[0].path ?? "";
  // A workstream's workflow references resolve in the workstream's own project.
  const resolveWorkstreamLink = (item: WorkstreamSummary, from: OpenWorkflow) => (ref: string) =>
    linkTo(ref, from, workflows, workstreamLinkDir(item, projects.projects, localLinkDir), unavailable);

  // A workstream chosen on the Workstreams page, or from the Workflow tab.
  // When it follows another workflow than the selected one, that workflow
  // becomes the selected one, so the workstream stays in the list.
  const showWorkstream = (item: WorkstreamSummary) => {
    setWorkstreamKeySelected(runKey(item));
    if (allWorkstreams || item.workflowPath === workflow?.path) return;
    const target = item.workflowPath ? workflows.find((w) => w.path === item.workflowPath) : undefined;
    if (target) selectWorkflow(workflowKey(target));
    else setAllWorkstreams(true);
  };
  const openWorkstreamPage = (item: WorkstreamSummary) => {
    setAllWorkstreams(false);
    setWorkstreamKeySelected(runKey(item));
    setPage("workstreams");
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
    setCurrentKey(workflowKey(created));
    setSelectedIndex(0);
    setPage("edit");
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
  if (!session) return <div className="app-loading">Loading…</div>;
  // After projects were added or removed; open workflows and their edits stay.
  const projectsChanged = () => refreshProjects().catch((e) => showToast(e instanceof Error ? e.message : String(e)));
  const lane = (
    <WorkflowList
      mode={page === "workstreams" ? "workstreams" : "edit"}
      workflows={workflows}
      currentKey={page === "workstreams" && allWorkstreams ? null : currentKey}
      compareRight={page === "compare" ? shownPair[1] : undefined}
      onCompareRight={(key) => pickCompare("right", key)}
      onOpen={(key) => {
        // On Compare a row picks the left workflow and stays on Compare.
        if (page === "compare") return pickCompare("left", key);
        selectWorkflow(key);
        if (page === "workstreams") {
          setAllWorkstreams(false);
          setWorkstreamKeySelected(null);
        }
      }}
      workstreams={workstreams}
      unavailable={unavailable.filter((u) => u.location !== "run")}
      locationPaths={Object.fromEntries(session.locations.map((x) => [x.id, x.path]))}
      onNew={createNew}
      allWorkstreams={allWorkstreams}
      onAllWorkstreams={() => {
        setAllWorkstreams(true);
        setWorkstreamKeySelected(null);
      }}
    />
  );

  // The problems chip and its list on the Edit and Compare pages, for the
  // selected workflow. A problem of a step selects it and opens the Step tab
  // (on Compare also bringing its card into view); one of the workflow opens
  // the Workflow tab on Compare.
  const pickProblem = (stepIndex: number) => {
    if (stepIndex >= 0) {
      setSelectedIndex(stepIndex);
      showTab("step");
      if (page === "compare") setCompareReveal((r) => ({ index: stepIndex, n: (r?.n ?? 0) + 1 }));
    } else if (page === "compare") showTab("workflow");
    setProblemsOpen(false);
  };
  const problemsChip =
    workflow && !readOnly ? (
      <ProblemsChip
        problems={problems}
        steps={steps}
        open={problemsOpen}
        onToggle={() => setProblemsOpen((v) => !v)}
        onProblem={pickProblem}
      />
    ) : null;
  // The disk-change banner of the Edit and Compare pages, for the selected workflow.
  const diskBanner =
    workflow && disk && !readOnly ? (
      <DiskBanner
        file={workflow.file}
        disk={disk}
        onCompare={() => {
          setWorkflowView("changes");
          showTab("workflow");
        }}
        onLoadDisk={loadDisk}
        onKeepEdits={keepEdits}
      />
    ) : null;
  // The right rail of the Edit and Compare pages, for the selected workflow.
  const rail = (
    <>
      {railOpen && workflow && (
        <RailPanel
          tab={railTab}
          workflowView={workflowView}
          onWorkflowView={setWorkflowView}
          onTab={showTab}
          workflow={workflow}
          readOnly={readOnly}
          steps={steps}
          selectedIndex={selected}
          problems={problems.filter((p) => p.stepIndex === selected)}
          library={library}
          workstreams={workstreams}
          root={session.root}
          diffBase={disk?.text ?? workflow.text}
          onEdit={apply}
          onAddArtifact={addArtifact}
          reviewGuides={reviewGuides}
          allWorkflows={localWorkflows}
          onOpenWorkstream={openWorkstreamPage}
          linkTo={resolveLink}
          onOpenWorkflow={selectWorkflow}
          onOpenWorkflowStep={openWorkflowStep}
          onClose={() => setRailOpen(false)}
        />
      )}
      {workflow && (
        <RailStrip
          open={railOpen}
          tab={railTab}
          stepEnabled={selected !== null && !readOnly}
          libraryEnabled={!readOnly}
          stepProblem={selected !== null && byStep.has(selected)}
          dirty={dirty && !readOnly}
          onPick={(tab) => {
            setProblemsOpen(false);
            if (tab) showTab(tab);
            else setRailOpen(false);
          }}
        />
      )}
    </>
  );

  // The Present page's second workflow, while its picker offers it.
  const presentSecondKey = shownSecond(workflows, currentKey, presentSecond);
  const presentSecondWorkflow = workflows.find((w) => workflowKey(w) === presentSecondKey) ?? null;

  return (
    <div className="app">
      <TopBar project={projectName(session.root)} page={page} onPage={goPage} />
      {page === "present" ? (
        <Present
          lane={lane}
          workflow={workflow}
          second={presentSecondWorkflow}
          secondOptions={secondOptions(workflows, currentKey)}
          onSecond={setPresentSecond}
          linkTo={resolveLink}
          secondLinkTo={(ref) => linkTo(ref, presentSecondWorkflow!, workflows, localLinkDir, unavailable)}
          onOpenWorkflow={selectWorkflow}
          library={library}
          show={presentShow}
          onShow={setPresentShow}
          hoveredArtifact={hoveredArtifact}
          onHoverArtifact={setHoveredArtifact}
          leftPinned={leftPinned}
          rightPinned={rightPinned}
          onLeftPinned={setLeftPinned}
          onRightPinned={setRightPinned}
        />
      ) : page === "workstreams" ? (
        <div className="screen is-workstreams">
          {lane}
          <Workstreams
            workflows={workflows}
            workstreams={workstreams}
            projects={projects.projects}
            projectsError={projects.error}
            filter={allWorkstreams ? null : workflow}
            selectedKey={workstreamKeySelected}
            onSelect={showWorkstream}
            view={workstreamView}
            onView={setWorkstreamView}
            onChanged={projectsChanged}
            onMessage={showToast}
            linkTo={resolveWorkstreamLink}
            onOpenWorkflow={editWorkflow}
          />
        </div>
      ) : page === "compare" ? (
        <div className={`screen is-compare${railOpen && workflow ? " has-panel" : ""}`}>
          {lane}
          {workflow ? (
            <Compare
              workflows={compareList}
              left={workflow}
              right={compareList.find((w) => workflowKey(w) === shownPair[1]) ?? null}
              library={library}
              selectedIndex={selected}
              onSelectStep={selectStep}
              onPick={pickCompare}
              onSwap={() => pickCompare("swap")}
              onlyDifferences={onlyDifferences}
              onOnlyDifferences={setOnlyDifferences}
              allInstructions={allInstructions}
              onAllInstructions={setAllInstructions}
              status={workflowStatus(workflow, readOnly, dirty)}
              dirty={dirty && !readOnly}
              saveBlocked={problems.length ? "Fix the problems to save" : null}
              onSave={openSave}
              onApply={applyCompare}
              diskBanner={diskBanner}
              problemsChip={problemsChip}
              problemSteps={byStep}
              reveal={compareReveal}
            />
          ) : (
            <div className="center center-empty">No workflow to compare.</div>
          )}
          {rail}
        </div>
      ) : (
        <div className={`screen is-edit${railOpen && workflow ? " has-panel" : ""}`}>
          {lane}
          {workflow ? (
            <EditCenter
              workflow={workflow}
              steps={steps}
              readOnly={readOnly}
              dirty={dirty}
              diskBanner={diskBanner}
              problemsChip={problemsChip}
              problems={problems}
              onDiscard={discard}
              onSave={openSave}
              showPaths={showPaths}
              setShowPaths={setShowPaths}
              showDescriptions={showDescriptions}
              setShowDescriptions={setShowDescriptions}
            >
              <Flow
                steps={steps}
                selectedIndex={selected ?? -1}
                onSelect={selectStep}
                problemsByStep={readOnly ? new Map() : byStep}
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
                readOnly={readOnly}
                inputs={workflowInputs(workflow)}
                handOffs={workflowHandOffs(workflow)}
                linkTo={resolveLink}
                onOpenWorkflow={selectWorkflow}
              />
            </EditCenter>
          ) : (
            <div className="center center-empty">No workflow selected.</div>
          )}
          {rail}
        </div>
      )}
      {modal && workflow && (
        <ModalView
          modal={modal}
          setModal={setModal}
          session={session}
          workflow={workflow}
          structural={structureChanges(workflow, steps)}
          activeWorkstreams={workstreams.filter(
            (w) => w.workflowPath === workflow.path && w.summary?.status !== "COMPLETED",
          )}
          onConfirm={modal.type === "new" ? confirmNew : save}
        />
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

// The banner of the Edit and Compare pages when the selected workflow's file
// changed on disk under unsaved edits (also after Save found it changed).
// "Compare" opens the rail's Workflow tab on Changes.
function DiskBanner({
  file,
  disk,
  onCompare,
  onLoadDisk,
  onKeepEdits,
}: {
  file: string;
  disk: DiskVersion;
  onCompare: () => void;
  onLoadDisk: () => void;
  onKeepEdits: () => void;
}) {
  return (
    <div className="disk-banner">
      <span>
        {file} changed on disk at {disk.at}. Your working copy has unsaved edits.
      </span>
      <button onClick={onCompare}>Compare</button>
      <button onClick={onLoadDisk}>Load disk version</button>
      <button className="keep" onClick={onKeepEdits}>
        Keep my edits
      </button>
    </div>
  );
}

// The chip that counts the workflow's problems, and the list it opens, each
// problem a button that leads to its step (or to the workflow). The list is
// positioned against the bar the chip sits in.
function ProblemsChip({
  problems,
  steps,
  open,
  onToggle,
  onProblem,
}: {
  problems: ReturnType<typeof problemsForText>;
  steps: ReturnType<typeof stepViews>;
  open: boolean;
  onToggle: () => void;
  onProblem: (stepIndex: number) => void;
}) {
  return (
    <>
      {problems.length > 0 && (
        <button className="problems-chip" onClick={onToggle}>
          {problems.length} problem{problems.length === 1 ? "" : "s"}
        </button>
      )}
      {open && (
        <div className="problems-popover">
          {problems.map((p, i) => (
            <button key={i} className="problems-popover-row" onClick={() => onProblem(p.stepIndex)}>
              <span className="mono">{p.stepIndex >= 0 ? `${p.stepIndex + 1} · ${steps[p.stepIndex]?.id ?? ""}` : "workflow"}</span>
              <span className="problems-popover-msg">{p.message}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// A workflow's status line in the Edit and Compare headers.
function workflowStatus(workflow: OpenWorkflow, readOnly: boolean, dirty: boolean): string {
  if (readOnly) return `read-only · ${projectName(workflow.project ?? "")}'s own workflow`;
  if (!workflow.onDisk) return "new · working copy";
  return dirty ? "modified · working copy" : "saved";
}

// The Edit page's centre column: the header with the file, its status and
// Save, the disk-change banner, the toolbar, and the diagram.
function EditCenter({
  workflow,
  steps,
  readOnly,
  dirty,
  diskBanner,
  problemsChip,
  problems,
  onDiscard,
  onSave,
  showPaths,
  setShowPaths,
  showDescriptions,
  setShowDescriptions,
  children,
}: {
  workflow: OpenWorkflow;
  steps: ReturnType<typeof stepViews>;
  readOnly: boolean;
  dirty: boolean;
  diskBanner: React.ReactNode;
  problemsChip: React.ReactNode;
  problems: ReturnType<typeof problemsForText>;
  onDiscard: () => void;
  onSave: () => void;
  showPaths: boolean;
  setShowPaths: (update: (on: boolean) => boolean) => void;
  showDescriptions: boolean;
  setShowDescriptions: (update: (on: boolean) => boolean) => void;
  children: React.ReactNode;
}) {
  const status = workflowStatus(workflow, readOnly, dirty);
  return (
    <div className="center">
      <div className="center-header">
        <div className="center-header-main">
          <div className="center-header-title">{workflow.file}</div>
          <div className="center-header-sub">
            <span className={`center-header-status${dirty && !readOnly ? " is-dirty" : ""}`}>{status}</span>
            <span className="center-header-path mono" title={workflow.path}>
              {readOnly ? workflow.path : `${LOCATION_ROOT[workflow.location]}${workflow.dir ? `${workflow.dir}/` : ""}${workflow.file}`}
            </span>
          </div>
        </div>
        {problemsChip}
        {!readOnly && dirty && workflow.onDisk && (
          <button className="discard-btn" onClick={onDiscard}>
            Discard changes
          </button>
        )}
        {!readOnly && (
          <button
            className={`save-btn${dirty && !problems.length ? " is-enabled" : " is-disabled"}`}
            disabled={!dirty || !!problems.length}
            title={problems.length ? "Fix the problems to save" : ""}
            onClick={onSave}
          >
            Save…
          </button>
        )}
      </div>
      {diskBanner}
      <div className="toolbar">
        <span className="toolbar-counts">
          {plural(steps.length, "step")} · {plural(artifactCount(steps), "artifact")} ·{" "}
          {plural(routeBackCount(steps), "route")} back
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
      </div>
      {children}
    </div>
  );
}

function ModalView({
  modal,
  setModal,
  session,
  workflow,
  structural,
  activeWorkstreams,
  onConfirm,
}: {
  modal: Modal;
  setModal: (m: Modal | null) => void;
  session: Session;
  workflow: OpenWorkflow;
  structural: string[];
  activeWorkstreams: WorkstreamSummary[];
  onConfirm: () => void;
}) {
  const asNew = modal.type === "new" || modal.asNew;
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(modal.name);
  const location = session.locations.find((x) => x.id === modal.location)!;
  const preview = `${location.path}/${modal.folder ? `${modal.folder.replace(/^\/+|\/+$/g, "")}/` : ""}${modal.name || "…"}.yml`;
  const warning = modal.type === "save" && !modal.asNew && structural.length > 0 && activeWorkstreams.length > 0;
  const patch = (fields: Partial<Modal>) => setModal({ ...modal, ...fields } as Modal);
  return (
    <div className="modal-backdrop" onClick={() => setModal(null)}>
      <div className="save-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2>{modal.type === "new" ? "New workflow" : `Save ${workflow.file}`}</h2>
          <button className="icon-mini" title="Close" aria-label="Close" onClick={() => setModal(null)}>
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
              {activeWorkstreams.length} workstream{activeWorkstreams.length === 1 ? "" : "s"} in progress on this workflow. Progress
              is stored by step id.
            </strong>
            {activeWorkstreams.map((run) => (
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
          <button className="secondary-button" onClick={() => setModal(null)}>
            Cancel
          </button>
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
