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
import { diskChangeWatcher, editorTakesEdits, restoredWorkingCopy, workingCopySaver } from "./model/diskChange.ts";
import { diskRecords, mergeListed, requestSequencer } from "./model/listedWorkflows.ts";
import { givesWay } from "./model/readOnlyView.ts";
import type { UnavailableWorkflow } from "./model/workflowLinks.ts";
import { editedWorkflow, movedRefEdits } from "./model/editWorkflow.ts";
import { selectionAfterMove } from "./model/stepSelection.ts";
import { followsWorkflow, plural, stateOf, workstreamLinkDir } from "./model/workstreams.ts";
import { addArtifactEdits, describeFrom, insertArtifactStepEdits } from "./model/artifactInstruction.ts";
import {
  artifactCount,
  linkTo,
  openWorkflow,
  routeBackCount,
  savedVersion,
  stepViews,
  structureChanges,
  workflowHandOffs,
  workflowInputs,
  workflowKey,
  type OpenWorkflow,
  type Session,
  type WorkflowFile,
} from "./workflowView.ts";
import { problemsByStep, problemsForText, type EngineValidation } from "./validate.ts";
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
import { entryIndex, entryProject, entryState, parseRoute, routePath, routedWorkflow } from "./model/route.ts";
import {
  abandoned,
  answered,
  changed,
  checkedAs,
  closed,
  confirmedAs,
  failedRequest,
  loaded,
  namesResolveIn,
  compareSelection,
  readingFrom,
  savingAs,
  stillConfirmed,
  textChanged,
  type Dialog,
  type LinkContext,
  type Loaded,
  type Reading,
  type SaveDialog,
} from "./model/appState.ts";

// The file on disk when it differs from the version the edits were made
// from; at is when that was seen, absent for a working copy restored after
// the file changed. unknownBase: the working copy records no version it was
// made from, as one written by an older Komposer.
type DiskVersion = { text: string; hash: string; at?: string; unknownBase?: true };

const timeNow = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// The save dialog's reading of the workstreams in progress on the workflow:
// the shared list, once it answers the dialog's request or a newer one.
function inProgressFor(d: Dialog, list: Loaded<WorkstreamSummary[]>, workflow: OpenWorkflow): Reading<WorkstreamSummary[]> {
  if (d.type !== "save") return { state: "ready", value: [] };
  const r = readingFrom(list, d.asked);
  return r.state === "ready" ? { state: "ready", value: r.value.filter((w) => followsWorkflow(w, workflow) && stateOf(w) !== "COMPLETED") } : r;
}

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
  // With the request it answers, so the save dialog can wait for an answer
  // newer than itself (appState).
  const [workstreamsLoaded, setWorkstreamsLoaded] = useState<Loaded<WorkstreamSummary[]>>(loaded([]));
  const workstreams = workstreamsLoaded.value;
  const [projects, setProjects] = useState<{ projects: ProjectSummary[]; error?: string }>({ projects: [] });
  // The page the URL named when the app loaded (route.ts). The workflow it
  // named, and the entry's project, wait in wantedRoute until the workflows
  // are listed; back or forward before that replaces them.
  const [page, setPage] = useState<Page>(() => parseRoute(location.pathname).page);
  const [loadedRoute] = useState(() => ({ workflow: parseRoute(location.pathname).workflow, project: entryProject(history.state) }));
  const wantedRoute = useRef<{ workflow: string | null; project?: string } | null>(loadedRoute);
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
  const [workstreamView, setWorkstreamView] = useState<WorkstreamView>("diagram");
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
  const [modal, setModal] = useState<Dialog | null>(null);
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

  // Working copies are the crash-safe form of every edit (workingCopySaver).
  // A workflow whose copy another tab changed is marked until the user picks
  // which edits to keep.
  const [copyConflicts, setCopyConflicts] = useState<Record<string, true>>({});
  // Why a workflow's edits could not be written to its working copy; they
  // stay pending and are tried again (workingCopySaver).
  const [copyFailures, setCopyFailures] = useState<Record<string, string>>({});
  const saverRef = useRef<ReturnType<typeof workingCopySaver> | null>(null);
  saverRef.current ??= workingCopySaver({
    put: (path, write, expected, urgent) => api.putWorkingCopy(path, write.text, write.base, expected, urgent),
    remove: (path, expected, urgent) => api.deleteWorkingCopy(path, expected, urgent),
    isConflict: (e) => e instanceof ApiError && e.status === 409,
    conflict: (path) => setCopyConflicts((all) => ({ ...all, [path]: true })),
    error: (e) => showToast(e instanceof Error ? e.message : String(e)),
    failed: (path, reason) =>
      setCopyFailures((all) => {
        const next = { ...all };
        if (reason === null) delete next[path];
        else next[path] = reason;
        return next;
      }),
    delay: 350,
  });
  const saver = saverRef.current;
  const clearCopyConflict = (path: string) =>
    setCopyConflicts((all) => {
      if (!(path in all)) return all;
      const next = { ...all };
      delete next[path];
      return next;
    });
  // A listed file, opened: the tab now knows its working copy, and one made
  // from another version of the file than the one on disk is a conflict,
  // recorded in found for the disk-change banner.
  const openListed = (file: WorkflowFile, found: Record<string, DiskVersion>) => {
    saver.known(file.path, file.workingCopyHash ?? null);
    const restored = restoredWorkingCopy(file);
    if (restored.disk) found[workflowKey(file)] = restored.disk;
    return openWorkflow(restored.file);
  };
  // Counts saves, discards and loads, so a listing read while one happened
  // is known to be stale.
  const localChanges = useRef(0);
  // Saves confirmed and not yet done. A listing read meanwhile is not taken
  // up: it may hold another tab's working copy, which the editor would show
  // and the save's completion would replace.
  const savesInFlight = useRef(0);
  // Counts refreshes, so the review guides are asked again after each.
  const [refreshes, setRefreshes] = useState(0);
  // Every read of the server's data goes through one sequencer: an answer is
  // taken up only while it answers the newest request of its kind, and a
  // workflows listing only while no newer version of a file was installed
  // since it was asked for (the watcher, a save, a discard or a load).
  const requests = useRef(requestSequencer<"workflows" | "workstreams" | "projects" | "library">());
  // Reads the workstreams for request `asked`, the answer or the failure
  // taken up only while that is the newest request (appState). A failure is
  // passed on to the caller.
  const readWorkstreams = async (asked: number) => {
    try {
      const ws = await api.workstreams();
      const newest = requests.current.current("workstreams", asked);
      setWorkstreamsLoaded((l) => answered(l, asked, ws.workstreams, newest));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const newest = requests.current.current("workstreams", asked);
      setWorkstreamsLoaded((l) => failedRequest(l, asked, error, newest));
      throw e;
    }
  };
  // Everything read from disk, read again: on load, when the window regains
  // focus, after a save, on the Workstreams page, and after a project is
  // added or removed, so workstreams, the library, policies and files changed
  // outside this tab show as they are now. Open workflows with unsaved edits
  // stay as they are (mergeListed). A listing read while this tab wrote a
  // working copy or saved can predate that write, so its workflows are left
  // as they are. A file that changed on disk under unsaved edits gets the
  // disk-change banner, also when it is not the selected one (diskRecords).
  const refresh = async () => {
    const before = saver.writes() + localChanges.current;
    const asked = {
      workflows: requests.current.begin("workflows"),
      workstreams: requests.current.begin("workstreams"),
      projects: requests.current.begin("projects"),
      library: requests.current.begin("library"),
    };
    // The workstreams are taken up, or their failure recorded, on their own,
    // so a save dialog waiting for them is answered whatever the other reads do.
    const ws = readWorkstreams(asked.workstreams);
    const [w, p, l] = await Promise.all([api.workflows(), api.projects(), api.library(), ws]);
    if (requests.current.current("projects", asked.projects)) setProjects(p);
    if (requests.current.current("library", asked.library)) setLibrary(l.entries);
    setRefreshes((n) => n + 1);
    if (
      saver.writes() + localChanges.current !== before ||
      savesInFlight.current > 0 ||
      !requests.current.current("workflows", asked.workflows)
    )
      return;
    setUnavailable(w.unavailable);
    // React runs these updaters in the order the states were declared, so
    // merged and found are complete when the selection and the disk versions
    // are updated, and the first selection is made when the link context is.
    const found: Record<string, DiskVersion> = {};
    let merged: OpenWorkflow[] = [];
    let wanted: { key: string; project: string } | null = null;
    setWorkflows((all) => (merged = mergeListed(all, w.workflows, (file) => openListed(file, found))));
    setCurrentKey((key) => {
      if (key !== null) return key;
      const route = wantedRoute.current;
      const routed = routedWorkflow(merged, route?.workflow ?? null);
      if (routed && route?.project) wanted = { key: workflowKey(routed), project: route.project };
      const first = routed ?? merged.find((x) => x.location !== "run");
      return first ? workflowKey(first) : null;
    });
    // The entry's project, with the first selection, so the URL is written
    // once with both.
    setLinkContext((context) => wanted ?? context);
    const at = timeNow();
    setDiskVersions((all) => diskRecords(all, merged, w.workflows, workflowKey, found, at));
  };
  useEffect(() => {
    api
      .session()
      .then((s) => {
        setSession(s);
        return refresh();
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const refreshNow = () => refreshRef.current().catch((e) => showToast(e instanceof Error ? e.message : String(e)));
  // Pending working copies are written when the page is hidden, closed or
  // reloaded; the data is read again when the page is shown.
  useEffect(() => {
    const onFocus = () => void refreshNow();
    const onVisibility = () => (document.visibilityState === "hidden" ? void saver.flush(true) : onFocus());
    const onHide = () => void saver.flush(true);
    // An edit that cannot be written before the page unloads: the browser asks.
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      void saver.flush(true);
      if (!saver.busy()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);

  const workflow = useMemo(() => workflows.find((w) => workflowKey(w) === currentKey) ?? null, [workflows, currentKey]);
  const steps = useMemo(() => (workflow ? stepViews(workflow) : []), [workflow]);
  const dirty = !!workflow && workflow.openText !== workflow.text;
  const disk = currentKey ? diskVersions[currentKey] : undefined;
  // Another project's workflow file, which a workstream follows or a link
  // leads to.
  const isRun = workflow?.location === "run";
  // Shown, never edited or saved: another project's file, and a file of the
  // three locations that is a link leading outside them, whose save the
  // server refuses.
  const readOnly = isRun || !!workflow?.leadsTo;
  const localWorkflows = useMemo(() => workflows.filter((w) => w.location !== "run"), [workflows]);
  // The Workstreams page shows each workflow as saved, since that is what
  // fuse-flow reads for its workstreams; unsaved edits are not part of them,
  // and a file that changed on disk under them is shown as it is on disk.
  const savedWorkflows = useMemo(
    () => workflows.map((w) => savedVersion(w, diskVersions[workflowKey(w)])),
    [workflows, diskVersions],
  );
  const savedWorkflow = useMemo(() => (workflow ? savedVersion(workflow, disk) : null), [workflow, disk]);
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

  // Every edit is written to the workflow's working copy shortly after;
  // equal text removes it. Selecting another workflow meanwhile does not
  // cancel the write (workingCopySaver).
  useEffect(() => {
    if (!workflow || readOnly) return;
    saver.want(workflow.path, workflow.openText === workflow.text ? null : { text: workflow.openText, base: workflow.hash });
  }, [workflow?.path, workflow?.openText, workflow?.text, workflow?.hash, readOnly]);

  // The review guides the engine gives the open text's agent gates. Asked
  // again shortly after each edit and after each refresh, since a policy or
  // a guide can change on disk; a failed request leaves the last answer.
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
  }, [workflow?.path, workflow?.openText, readOnly, refreshes]);

  // The engine's checks that need other files (POST /api/validate), asked
  // like the review guides. Each answer is kept with the path and text it
  // was given for, and counts only while the open text is that text; until
  // then Save waits, since fuse-flow would refuse a file these checks fail.
  const [engineCheck, setEngineCheck] = useState<{ path: string; text: string; result?: EngineValidation; error?: string } | null>(
    null,
  );
  useEffect(() => {
    if (!workflow || readOnly) return;
    let current = true;
    const { path, openText: text } = workflow;
    const timer = window.setTimeout(() => {
      api
        .validate(path, text)
        .then((result) => current && setEngineCheck({ path, text, result }))
        .catch((e) => current && setEngineCheck({ path, text, error: e instanceof Error ? e.message : String(e) }));
    }, 300);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [workflow?.path, workflow?.openText, readOnly, refreshes]);
  const engineAnswer =
    workflow && engineCheck && engineCheck.path === workflow.path && engineCheck.text === workflow.openText ? engineCheck : null;
  const problems = useMemo(
    () => (workflow ? problemsForText(workflow.openText, engineAnswer?.result ?? null) : []),
    [workflow, engineAnswer],
  );
  const byStep = useMemo(() => problemsByStep(problems), [problems]);
  // Why Save is not offered now, or null.
  const saveBlocked = problems.length
    ? "Fix the problems to save"
    : workflow?.parsed && !readOnly && !engineAnswer?.result
      ? engineAnswer?.error
        ? `Cannot check the workflow: ${engineAnswer.error}`
        : "Checking the workflow…"
      : null;

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
        requests.current.invalidate("workflows");
        if (action === "conflict") {
          setDiskVersions((all) => ({
            ...all,
            [key]: {
              text: listed.text,
              hash: listed.hash,
              at: timeNow(),
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
      // A deleted file: the refresh drops it unless it has unsaved edits.
      if (change.hash === null) void refreshNow();
      void watcher.change(change.hash);
    });
    return () => {
      watcher.close();
      source.close();
    };
  }, [workflow?.path, workflow?.onDisk, readOnly]);

  // Whether an edit is taken now: not while a save writes the file
  // (editorTakesEdits), read from the dialog as it is, not as last rendered.
  const takesEdits = () => editorTakesEdits({ readOnly, dialog: modalRef.current });
  // Applies one edit, or several in order as one change: either all apply or none.
  const apply = (edits: Edit | Edit[]) => {
    if (!workflow || !currentKey || !takesEdits()) return;
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
    if (!list.length || !workflow || !currentKey || !takesEdits()) return showToast(message);
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
  // The project the selected workflow's names resolve in, recorded with the
  // link navigation that selected it (appState, namesResolveIn): another
  // project's file, or a shared personal or shipped one, can be reached from
  // workstreams of several projects, and names in it resolve in the project
  // of the one it was reached from, as fuse-flow runs it there.
  const [linkContext, setLinkContext] = useState<LinkContext>(null);
  // The URL follows the page and the selected workflow (route.ts), so back
  // and forward move between them and a link opens the same view. A change
  // the user makes is a new history entry; one the app makes by itself (the
  // first selection, a workflow that gives way, a save as a new file, going
  // back or forward) replaces the entry. Each entry keeps its place in the
  // tab's history and the project the workflow's names resolve in when it
  // was opened by following a link, so going back to it, or reloading it,
  // reads it for the same project.
  const urlWrite = useRef<"push" | "replace">("push");
  const shownRoute = useRef<string | null>(null);
  const entryAt = useRef(entryIndex(history.state) ?? 0);
  // While a refused back or forward is undone (goToEntry), the browser is on
  // another entry than the app's, so the URL is not written until it is back.
  const restoring = useRef(false);
  const route = workflow ? routePath(page, workflow) : null;
  const routeProject = linkContext && linkContext.key === currentKey ? linkContext.project : undefined;
  const shown = useRef({ route, routeProject });
  shown.current = { route, routeProject };
  // The workflow the URL named, and the entry's project, are selected with
  // the first listing (refresh); after that they are no longer wanted.
  useEffect(() => {
    if (workflow) wantedRoute.current = null;
  }, [workflow]);
  // The entry already names the route when it has the same path and the same
  // project; following a link to the workflow shown, or selecting it again
  // after a link led to it, changes only the project, and is a new entry.
  useEffect(() => {
    if (route === null || restoring.current) return;
    const same = route === location.pathname && routeProject === entryProject(history.state);
    const replace = urlWrite.current === "replace" || shownRoute.current === null || same;
    urlWrite.current = "push";
    shownRoute.current = route;
    if (!replace) entryAt.current++;
    const state = entryState(entryAt.current, routeProject);
    if (replace) history.replaceState(state, "", route);
    else history.pushState(state, "", route);
  }, [route, routeProject]);
  // Selects a workflow for every page. The step selection belongs to the
  // workflow it was made in, so it is cleared, and a panel that needs it
  // closes. `project` is where its names resolve, for a selection made by
  // following a link; any other selection records none.
  const selectWorkflow = (key: string, project?: string) => {
    setLinkContext(project ? { key, project } : null);
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
    if (givesWay({ listed: !!workflow, readOnly: isRun, hasRun: false, openedByLink: true })) {
      urlWrite.current = "replace";
      selectWorkflow(workflowKey(localWorkflows[0]));
    }
  }, [currentKey, !!workflow, isRun, localWorkflows]);
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
    const select = compareSelection(side, next.select, currentKey);
    if (select !== null) selectWorkflow(select);
  };
  const goPage = (next: Page) => {
    if (next === "compare") return openCompare();
    if (next === "workstreams") void refreshNow();
    setPage(next);
  };
  // A workflow opened from the Workstreams page: selected, on the Edit page,
  // read for the project of the workstream whose link was followed. That is
  // the workstream the page shows, which is not always the one selected (the
  // page shows the first one when none is), so it is the one whose links
  // were last resolved (resolveWorkstreamLink).
  const shownWorkstream = useRef<WorkstreamSummary | null>(null);
  const editWorkflow = (key: string) => {
    selectWorkflow(key, shownWorkstream.current?.project);
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
    showTab("step");
  };
  // A workflow reference of the open workflow (a hand-off, a workflow gate),
  // resolved the way fuse-flow resolves it: a name in the workflows of the
  // project namesResolveIn names.
  const linkProject = namesResolveIn({
    context: linkContext,
    currentKey,
    ownProject: isRun ? workflow?.project : undefined,
    root: session?.root,
  });
  const linkDir = projects.projects.find((p) => p.path === linkProject)?.workflowsDir ?? session?.locations[0].path ?? "";
  const resolveLink = (ref: string) => linkTo(ref, workflow!, workflows, linkDir, unavailable);
  // A link of the open workflow, followed: its target is read for the same project.
  const followLink = (key: string) => selectWorkflow(key, linkProject);
  const localLinkDir = projects.projects.find((p) => p.path === session?.root)?.workflowsDir ?? session?.locations[0].path ?? "";
  // A link of Present's second diagram, followed. Present offers no run as
  // the second workflow, so its names resolve in this project (localLinkDir),
  // and its target is read for this project too, not for the project of the
  // first diagram (rvk-state-2).
  const followSecondLink = (key: string) => selectWorkflow(key, session?.root);
  // A workstream's workflow references resolve in the workstream's own project.
  const resolveWorkstreamLink = (item: WorkstreamSummary, from: OpenWorkflow) => {
    shownWorkstream.current = item;
    return (ref: string) => linkTo(ref, from, workflows, workstreamLinkDir(item, projects.projects, localLinkDir), unavailable);
  };

  // A workstream chosen on the Workstreams page, or from the Workflow tab.
  // When it follows another workflow than the selected one, that workflow
  // becomes the selected one, so the workstream stays in the list.
  const showWorkstream = (item: WorkstreamSummary) => {
    setWorkstreamKeySelected(runKey(item));
    if (allWorkstreams || (workflow && followsWorkflow(item, workflow))) return;
    const target = item.workflowPath
      ? (workflows.find((w) => w.path === item.workflowPath) ?? workflows.find((w) => followsWorkflow(item, w)))
      : undefined;
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
    if (!window.confirm(`Discard your unsaved changes to ${workflow.file}? They cannot be restored.`)) return;
    localChanges.current++;
    requests.current.invalidate("workflows");
    await saver.drop(workflow.path);
    clearCopyConflict(workflow.path);
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

  // The save dialog as last rendered, for a save that finishes after an await.
  const modalRef = useRef(modal);
  modalRef.current = modal;
  // Back or forward: the page and workflow of the entry gone to, its
  // workflow read for the project the entry recorded. The URL then already
  // shows them, so the entry is not written again. An open dialog closes;
  // one that is writing a file cannot, so the move is undone (history.go)
  // and the app stays where it is. URL writes wait until the browser is back
  // on the app's entry (a move on meanwhile is undone too), which then names
  // what the app shows by then (a save that finished meanwhile shows the
  // saved file). Before the workflows are
  // listed, the entry's workflow is selected once they are. When it is no
  // longer listed, the selection stays, and the entry is corrected to name it.
  const goToEntry = (state: unknown) => {
    const at = entryIndex(state);
    if (restoring.current && at !== undefined && at !== entryAt.current) return void history.go(entryAt.current - at);
    if (restoring.current) {
      restoring.current = false;
      urlWrite.current = "push";
      const now = shown.current;
      if (at !== undefined && now.route) {
        shownRoute.current = now.route;
        history.replaceState(entryState(entryAt.current, now.routeProject), "", now.route);
        return;
      }
    }
    if (modalRef.current) {
      if (closed(modalRef.current) !== null) {
        if (at !== undefined && at !== entryAt.current) {
          restoring.current = true;
          history.go(entryAt.current - at);
        }
        return;
      }
      setModal(null);
    }
    if (at !== undefined) entryAt.current = at;
    const next = parseRoute(location.pathname);
    const target = routedWorkflow(workflows, next.workflow);
    if (target) selectWorkflow(workflowKey(target), entryProject(state));
    else if (!workflow) wantedRoute.current = { workflow: next.workflow, project: entryProject(state) };
    else {
      shownRoute.current = routePath(next.page, workflow);
      history.replaceState(entryState(entryAt.current, routeProject), "", shownRoute.current);
    }
    if (next.page === "workstreams" && page !== "workstreams") void refreshNow();
    setPage(next.page);
  };
  const goToEntryRef = useRef(goToEntry);
  goToEntryRef.current = goToEntry;
  useEffect(() => {
    const onPop = (event: PopStateEvent) => goToEntryRef.current(event.state);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const dialogs = useRef(0);
  const openSave = () => {
    if (!workflow) return;
    // The warning names the workstreams in progress now, not at page load:
    // the dialog reads the shared list once it answers this request or a
    // newer one, so Update original waits for that (ModalView).
    const asked = requests.current.begin("workstreams");
    readWorkstreams(asked).catch(() => {});
    setModal({
      type: "save",
      asked,
      asNew: !workflow.onDisk,
      location: workflow.location === "run" ? "project" : workflow.location,
      folder: workflow.dir,
      name: workflow.file.replace(/\.ya?ml$/, ""),
    });
  };
  // One save: the text and the dialog's choice as they are when the user
  // presses Save. Its checks may answer after the user cancelled or changed
  // the dialog or the text; then it writes nothing. While it writes, the
  // dialog cannot be closed, so nothing can be edited until it is done.
  const save = async () => {
    if (!workflow || !currentKey || modal?.type !== "save" || modal.confirmed || modal.saving) return;
    // Update original writes the open text where the engine last checked it.
    if (!modal.asNew && saveBlocked) return;
    const confirmed = ++dialogs.current;
    const dialog = confirmedAs(modal, confirmed);
    setModal(dialog);
    // The pressed Save still holds: the dialog was not changed or closed, and
    // the text is the one it was pressed for.
    const holds = () => {
      const open = workflowsRef.current.find((w) => workflowKey(w) === currentKey);
      return stillConfirmed(modalRef.current, confirmed) && open?.openText === workflow.openText;
    };
    const update = (fields: Partial<SaveDialog>) => setModal((m) => checkedAs(m, confirmed, fields));
    // The text changed under a dialog still open: the dialog is offered again.
    const abandon = () => setModal((m) => abandoned(m, confirmed));
    localChanges.current++;
    // The working copy this tab knows now is the one the save's cleanup may
    // remove; a listing read meanwhile does not change it (workingCopySaver).
    const path = workflow.path;
    saver.hold(path);
    savesInFlight.current++;
    try {
      if (dialog.asNew) {
        // The file as it will be at the new place: relative guides, workflow
        // gates and hand-offs written again so they name the same files,
        // checked there by the engine. Errors refuse; warnings are shown
        // once, then Save writes it.
        const location = session!.locations.find((x) => x.id === dialog.location)!;
        const folder = dialog.folder.replace(/^\/+|\/+$/g, "");
        const destination = `${location.path}/${folder ? `${folder}/` : ""}${dialog.name}.yml`;
        const text = editedWorkflow(workflow, movedRefEdits(workflow.openText, workflow.path, destination)).openText;
        const check = await api.validate(destination, text);
        if (!holds()) return abandon();
        if (check.errors.length) return update({ error: `fuse-flow would refuse the file there: ${check.errors.join(" · ")}` });
        const checked = `${destination}\n${text}`;
        if (check.warnings.length && dialog.checked !== checked) return update({ warnings: check.warnings, checked });
        setModal((m) => savingAs(m, confirmed));
        const result = await api.saveNewWorkflow(dialog.location, dialog.folder, dialog.name, text);
        requests.current.invalidate("workflows");
        await saver.drop(workflow.path);
        clearCopyConflict(workflow.path);
        const file = `${dialog.name}.yml`;
        const saved = openWorkflow({
          location: dialog.location,
          dir: folder,
          file,
          path: result.path,
          onDisk: true,
          text,
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
        if (workflowKey(saved) !== currentKey) urlWrite.current = "replace";
        setCurrentKey(workflowKey(saved));
        showToast(`Saved ${result.path}`);
      } else {
        setModal((m) => savingAs(m, confirmed));
        const result = await api.updateWorkflow(workflow.path, workflow.hash, workflow.openText);
        requests.current.invalidate("workflows");
        await saver.drop(workflow.path);
        clearCopyConflict(workflow.path);
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
      void refreshNow();
    } catch (e) {
      if (!holds()) return abandon();
      if (e instanceof ApiError && e.status === 409 && !dialog.asNew) {
        const listed = (await api.workflows()).workflows.find((w) => w.path === workflow.path);
        if (listed)
          setDiskVersions((all) => ({
            ...all,
            [currentKey]: {
              text: listed.text,
              hash: listed.hash,
              at: timeNow(),
            },
          }));
        setModal(null);
      } else update({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      // A save that removed the copy ended the hold already (drop).
      saver.release(path);
      savesInFlight.current--;
    }
  };

  const loadDisk = async () => {
    if (!workflow || !currentKey || !disk) return;
    localChanges.current++;
    requests.current.invalidate("workflows");
    await saver.drop(workflow.path);
    clearCopyConflict(workflow.path);
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
  // Another tab changed this workflow's working copy: load that copy, or
  // write this tab's edits over it.
  const resolveCopy = async (keepMine: boolean) => {
    if (!workflow || !currentKey) return;
    const path = workflow.path;
    try {
      const listed = (await api.workflows()).workflows.find((w) => w.path === path);
      if (!keepMine && listed) {
        const found: Record<string, DiskVersion> = {};
        replaceWorkflow(currentKey, openListed(listed, found));
        setDiskVersions((all) => {
          const next = { ...all };
          delete next[currentKey];
          return { ...next, ...found };
        });
      }
      clearCopyConflict(path);
      await saver.resolve(path, listed?.workingCopyHash ?? null, keepMine);
      showToast(keepMine ? "Kept my edits" : "Loaded the other tab's edits");
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e));
    }
  };

  if (error) return <div className="app-error">Failed to load Komposer: {error}</div>;
  if (!session) return <div className="app-loading">Loading…</div>;
  // After projects were added or removed; open workflows and their edits stay.
  const projectsChanged = () => void refreshNow();
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
    workflow && !readOnly && (disk || copyConflicts[workflow.path]) ? (
      <>
        {copyConflicts[workflow.path] && (
          <CopyBanner file={workflow.file} onLoadOther={() => resolveCopy(false)} onKeepMine={() => resolveCopy(true)} />
        )}
        {disk && (
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
        )}
      </>
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
          onOpenWorkflow={followLink}
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
      {/* While a save writes the file, the page behind its dialog takes no
          focus and no input (editorTakesEdits). */}
      <div style={{ display: "contents" }} inert={!editorTakesEdits({ readOnly: false, dialog: modal })}>
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
          onOpenWorkflow={followLink}
          onOpenSecondWorkflow={followSecondLink}
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
            workflows={savedWorkflows}
            workstreams={workstreams}
            projects={projects.projects}
            projectsError={projects.error}
            filter={allWorkstreams ? null : savedWorkflow}
            selectedKey={workstreamKeySelected}
            onSelect={showWorkstream}
            view={workstreamView}
            onView={setWorkstreamView}
            onChanged={projectsChanged}
            onMessage={showToast}
            linkTo={resolveWorkstreamLink}
            onOpenWorkflow={editWorkflow}
            unavailable={unavailable}
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
              status={workflowStatus(workflow, readOnly, dirty, copyFailures[workflow.path])}
              dirty={dirty && !readOnly}
              saveBlocked={saveBlocked}
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
              notWritten={copyFailures[workflow.path]}
              steps={steps}
              readOnly={readOnly}
              dirty={dirty}
              diskBanner={diskBanner}
              problemsChip={problemsChip}
              saveBlocked={saveBlocked}
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
                onOpenWorkflow={followLink}
              />
            </EditCenter>
          ) : (
            <div className="center center-empty">No workflow selected.</div>
          )}
          {rail}
        </div>
      )}
      </div>
      {modal && workflow && (
        <ModalView
          modal={modal}
          setModal={setModal}
          session={session}
          workflow={workflow}
          structural={structureChanges(workflow)}
          inProgress={inProgressFor(modal, workstreamsLoaded, workflow)}
          saveBlocked={saveBlocked}
          onSetName={(name) => {
            apply({ op: "setWorkflowField", key: "name", value: name });
            setModal(textChanged);
          }}
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
        {disk.unknownBase
          ? `${file} may have changed on disk since this working copy was made: an older Komposer wrote it without the version it was made from.`
          : `${file} changed on disk ${disk.at ? `at ${disk.at}` : "after this working copy was made"}.`}{" "}
        Your working copy has unsaved edits.
      </span>
      <button onClick={onCompare}>Compare</button>
      <button onClick={onLoadDisk}>Load disk version</button>
      <button className="keep" onClick={onKeepEdits}>
        Keep my edits
      </button>
    </div>
  );
}

// The banner of the Edit and Compare pages when another tab changed the
// selected workflow's working copy, so this tab's edits are not written
// until the user picks which ones to keep.
function CopyBanner({ file, onLoadOther, onKeepMine }: { file: string; onLoadOther: () => void; onKeepMine: () => void }) {
  return (
    <div className="disk-banner">
      <span>
        Another tab changed the working copy of {file}. Your edits in this tab are not kept until you choose.
      </span>
      <button onClick={onLoadOther}>Load the other tab's edits</button>
      <button className="keep" onClick={onKeepMine}>
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

// A workflow's status line in the Edit and Compare headers. notWritten: why
// its edits could not be written to its working copy.
function workflowStatus(workflow: OpenWorkflow, readOnly: boolean, dirty: boolean, notWritten?: string): string {
  if (readOnly && workflow.leadsTo) return `read-only · a link to ${workflow.leadsTo}, outside the workflow locations`;
  if (readOnly) return `read-only · ${projectName(workflow.project ?? "")}'s own workflow`;
  if (notWritten) return `${workflow.onDisk ? "modified" : "new"} · not written: ${notWritten}`;
  if (!workflow.onDisk) return "new · working copy";
  return dirty ? "modified · working copy" : "saved";
}

// The Edit page's centre column: the header with the file, its status and
// Save, the disk-change banner, the toolbar, and the diagram.
function EditCenter({
  workflow,
  notWritten,
  steps,
  readOnly,
  dirty,
  diskBanner,
  problemsChip,
  saveBlocked,
  onDiscard,
  onSave,
  showPaths,
  setShowPaths,
  showDescriptions,
  setShowDescriptions,
  children,
}: {
  workflow: OpenWorkflow;
  // Why the edits could not be written to the working copy.
  notWritten?: string;
  steps: ReturnType<typeof stepViews>;
  readOnly: boolean;
  dirty: boolean;
  diskBanner: React.ReactNode;
  problemsChip: React.ReactNode;
  // Why Save is not offered, or null.
  saveBlocked: string | null;
  onDiscard: () => void;
  onSave: () => void;
  showPaths: boolean;
  setShowPaths: (update: (on: boolean) => boolean) => void;
  showDescriptions: boolean;
  setShowDescriptions: (update: (on: boolean) => boolean) => void;
  children: React.ReactNode;
}) {
  const status = workflowStatus(workflow, readOnly, dirty, notWritten);
  return (
    <div className="center">
      <div className="center-header">
        <div className="center-header-main">
          <div className="center-header-title">{workflow.file}</div>
          <div className="center-header-sub">
            <span className={`center-header-status${dirty && !readOnly ? " is-dirty" : ""}`}>{status}</span>
            <span className="center-header-path mono" data-tip={workflow.path}>
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
            className={`save-btn${dirty && !saveBlocked ? " is-enabled" : " is-disabled"}`}
            disabled={!dirty || !!saveBlocked}
            data-tip={saveBlocked ?? ""}
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
  inProgress,
  saveBlocked,
  onSetName,
  onConfirm,
}: {
  modal: Dialog;
  setModal: (update: (m: Dialog | null) => Dialog | null) => void;
  session: Session;
  workflow: OpenWorkflow;
  structural: string[];
  // The workstreams in progress on the workflow, as the dialog reads them
  // (inProgressFor).
  inProgress: Reading<WorkstreamSummary[]>;
  // Why the open text cannot be saved where it is, or null (the editor's Save).
  saveBlocked: string | null;
  // Sets the open workflow's name, as a warning about the file name offers.
  onSetName: (name: string) => void;
  onConfirm: () => void;
}) {
  const asNew = modal.type === "new" || modal.asNew;
  const valid = /^[a-z0-9][a-z0-9-]*$/.test(modal.name);
  const location = session.locations.find((x) => x.id === modal.location)!;
  const preview = `${location.path}/${modal.folder ? `${modal.folder.replace(/^\/+|\/+$/g, "")}/` : ""}${modal.name || "…"}.yml`;
  // Update original with changes a workstream depends on waits until the
  // workstreams in progress are known, so the warning is not missed.
  const updating = modal.type === "save" && !modal.asNew && structural.length > 0;
  const waiting = updating && inProgress.state !== "ready";
  const activeWorkstreams = inProgress.state === "ready" ? inProgress.value : [];
  const warning = updating && activeWorkstreams.length > 0;
  const engineWarnings = modal.type === "save" && modal.asNew ? (modal.warnings ?? []) : [];
  // Update original writes the open text where it is, so the editor's checks apply.
  const blocked = modal.type === "save" && !modal.asNew ? saveBlocked : null;
  // A pressed Save: its checks run (a change drops it), then the file is written.
  const confirmed = modal.type === "save" && !!modal.confirmed;
  const saving = modal.type === "save" && !!modal.saving;
  const close = () => setModal(closed);
  // A change of destination drops the warnings given for the old one; any
  // change drops a Save whose checks are still running (appState, changed).
  const patch = (fields: Partial<SaveDialog>) => setModal((m) => (m ? changed(m, fields as Partial<typeof m>) : m));
  return (
    <div className="modal-backdrop" onClick={close}>
      <div className="save-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title-row">
          <h2>{modal.type === "new" ? "New workflow" : `Save ${workflow.file}`}</h2>
          <button className="icon-mini" data-tip="Close" aria-label="Close" disabled={saving} onClick={close}>
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
                disabled={saving}
                onChange={(e) => patch({ folder: e.target.value, error: undefined })}
              />
            </label>
            <label className="field">
              <span className="field-label-row">File name</span>
              <input
                className="field-input mono-input"
                value={modal.name}
                disabled={saving}
                onChange={(e) => patch({ name: e.target.value, error: undefined })}
                data-error={!!modal.name && !valid}
              />
            </label>
            <div className="target-preview">{preview}</div>
            {modal.name && !valid && <div className="field-error">Lower-case letters, digits and hyphens.</div>}
          </>
        )}
        {modal.type === "save" && waiting && (
          <div className="workstream-warning">
            {inProgress.state === "failed"
              ? `Cannot read the workstreams in progress, so this save cannot warn about them: ${inProgress.error}. Close and try again, or save as a new file.`
              : "Reading the workstreams in progress on this workflow…"}
          </div>
        )}
        {warning && (
          <div className="workstream-warning">
            <strong>
              {activeWorkstreams.length} workstream{activeWorkstreams.length === 1 ? "" : "s"} in progress on this workflow. Progress
              is stored by step id.
            </strong>
            {activeWorkstreams.map((run) => (
              <div key={run.slug}>
                {run.slug} · {stateOf(run).toLowerCase().replaceAll("_", " ")}
                {run.summary?.currentStep ? ` at ${run.summary.currentStep}` : ""}
              </div>
            ))}
            <div>{structural.join(" · ")}</div>
            {structural.some((change) => change.startsWith("changed gates of ")) && (
              <div>
                fuse-flow takes back an owner's accepted review whose gate changed, and runs a changed or added gate on
                work already recorded before approving it.
              </div>
            )}
          </div>
        )}
        {engineWarnings.length > 0 && (
          <div className="workstream-warning">
            <strong>fuse-flow warns about the file there:</strong>
            {engineWarnings.map((line) => (
              <div key={line}>{line}</div>
            ))}
            {engineWarnings.some((line) => line.includes("differs from the file name")) && (
              <button className="secondary-button" disabled={saving} onClick={() => onSetName(modal.name)}>
                Name the workflow {modal.name}
              </button>
            )}
          </div>
        )}
        {blocked && <div className="field-error">{blocked}</div>}
        {modal.error && <div className="field-error">{modal.error}</div>}
        <div className="modal-actions">
          <button className="secondary-button" disabled={saving} onClick={close}>
            Cancel
          </button>
          <button
            className="primary-button"
            disabled={(asNew && !valid) || waiting || !!blocked || confirmed || saving}
            onClick={onConfirm}
          >
            {modal.type === "new"
              ? "Create"
              : saving
                ? "Saving…"
                : confirmed
                  ? "Checking…"
                  : warning || engineWarnings.length
                    ? "Save anyway"
                    : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
