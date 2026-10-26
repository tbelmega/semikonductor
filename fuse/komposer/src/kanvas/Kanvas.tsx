// SPDX-License-Identifier: Apache-2.0
// The Kanvas page: the exploration board of a project's design/ folder,
// each option of a round framed side by side at a chosen width, and the
// comments the owner pins to elements of the options. A click in a frame
// selects the element under the pointer with its source location; a comment
// is written against it. The agent reads the comments from
// design/.kanvas/comments.json and may mark them addressed there.
//
// The project picker lists the projects of the Workstreams page, after the
// --kanvas folder when Komposer was started with one; the choice is kept in
// localStorage.
//
// Prototype (workstream kanvas): the board view and comments only.

import { Check, ChevronDown, Copy, ChevronRight, MessageSquarePlus, MousePointerClick, RotateCcw, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AskDialog } from "../Compare.tsx";
import { projectName } from "../runView.ts";
import { kanvasApi } from "./api.ts";
import { anchorSrc, type Anchor, type Board, type BoardOption, type BuildState, type CommentState, type FrameMessage, type KanvasComment, type KanvasProjects, type KanvasState, type ShowMessage, startBoardPrompt } from "./model.ts";
import "./kanvas.css";

// "fit" gives each frame its column's own width, unscaled.
const WIDTHS = ["fit", 375, 768, 1280] as const;
type Width = (typeof WIDTHS)[number];
const FRAME_HEIGHT = 760;

type Filter = CommentState | "all";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "addressed", label: "Addressed" },
  { id: "resolved", label: "Resolved" },
  { id: "all", label: "All" },
];

const fileName = (path: string) => path.split("/").pop() ?? path;
const labelOf = (target: string) => target.split("/").pop() ?? target;

// The options whose folders every changed file lies in, or null when a change
// lies outside every option (tokens, board.md): then every frame reloads.
function changedTargets(board: Board | undefined, changed: string[] | undefined): Set<string> | null {
  if (!board || !changed || changed.length === 0) return null;
  const targets = new Set<string>();
  for (const path of changed) {
    const m = new RegExp(`^design/apps/${board.app}/boards/${board.feature}/round-\\d+/([^/]+)/`).exec(path);
    if (!m) return null;
    targets.add(`${board.app}/${board.feature}/${m[1]}`);
  }
  return targets;
}

const PROJECT_KEY = "komposer-kanvas-project";

export function Kanvas({ onMessage }: { onMessage: (message: string) => void }) {
  const [projects, setProjects] = useState<KanvasProjects | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [project, setProject] = useState<string | null>(null);

  useEffect(() => {
    kanvasApi
      .projects()
      .then((p) => {
        setProjects(p);
        const kept = localStorage.getItem(PROJECT_KEY);
        setProject(kept && p.projects.some((x) => x.path === kept) ? kept : p.first);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="screen is-kanvas"><div className="center center-empty">Kanvas could not load: {error}</div></div>;
  if (!projects || !project) return <div className="screen is-kanvas"><div className="center center-empty">Loading Kanvas…</div></div>;

  const pick = (path: string) => {
    localStorage.setItem(PROJECT_KEY, path);
    setProject(path);
  };
  const picker = (
    <label className="kv-project">
      <span className="kv-project-label">Project</span>
      <select aria-label="Project" data-tip={project} value={project} onChange={(e) => pick(e.target.value)}>
        {projects.projects.map((p) => (
          <option key={p.path} value={p.path}>
            {projectName(p.path)}
            {p.hasDesign ? "" : " (no design folder)"}
          </option>
        ))}
      </select>
    </label>
  );
  // A new key starts the project's page afresh: its comments, frames and events.
  return <KanvasProject key={project} project={project} picker={picker} onMessage={onMessage} />;
}

function KanvasProject({ project, picker, onMessage }: { project: string; picker: ReactNode; onMessage: (message: string) => void }) {
  const [state, setState] = useState<KanvasState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comments, setComments] = useState<KanvasComment[]>([]);
  const [build, setBuild] = useState<BuildState | null>(null);
  const [reloads, setReloads] = useState<Record<string, number>>({});
  const [width, setWidth] = useState<Width>("fit");
  const [filter, setFilter] = useState<Filter>("open");
  const [selection, setSelection] = useState<{ target: string; anchor: Anchor } | null>(null);
  const [draft, setDraft] = useState("");
  const [active, setActive] = useState<number | null>(null);
  const [openRounds, setOpenRounds] = useState<Record<number, boolean>>({});
  const frames = useRef(new Map<string, HTMLIFrameElement>());
  const draftBox = useRef<HTMLTextAreaElement>(null);

  const board = state?.boards[0];
  const boardRef = useRef(board);
  boardRef.current = board;

  const load = () =>
    kanvasApi
      .state(project)
      .then((s) => {
        setState(s);
        setComments(s.comments);
        setBuild(s.build);
        setError(null);
      })
      .catch((e: Error) => setError(e.message));

  useEffect(() => {
    void load();
    const source = new EventSource(kanvasApi.eventsUrl(project));
    source.addEventListener("build", (event) => {
      const next = JSON.parse((event as MessageEvent).data) as BuildState;
      setBuild(next);
      const targets = changedTargets(boardRef.current, next.changed);
      setReloads((r) => {
        const out = { ...r };
        for (const option of boardRef.current?.rounds.flatMap((round) => round.options) ?? [])
          if (!targets || targets.has(option.target)) out[option.target] = next.id;
        return out;
      });
      // board.md may have changed: read the boards again.
      if (!targets) void load();
    });
    source.addEventListener("comments", (event) => setComments((JSON.parse((event as MessageEvent).data) as { comments: KanvasComment[] }).comments));
    return () => source.close();
  }, []);

  // Messages from frames this page created, recognised by their window.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = [...frames.current.entries()].find(([, f]) => f.contentWindow === event.source)?.[0];
      if (!target) return;
      const data = event.data as FrameMessage;
      if (!data || typeof data !== "object") return;
      if (data.type === "kanvas:ready") showIn(target);
      else if (data.type === "kanvas:select") {
        setSelection({ target, anchor: data.anchor });
        setActive(null);
        void kanvasApi.select(project, target, data.anchor).catch(() => {});
        setTimeout(() => draftBox.current?.focus(), 0);
      } else if (data.type === "kanvas:pin") {
        setActive(data.id);
        setSelection(null);
        if (filter !== "all") {
          const c = comments.find((x) => x.id === data.id);
          if (c && c.state !== filter) setFilter("all");
        }
        setTimeout(() => document.getElementById(`kv-comment-${data.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }), 0);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  });

  const pinned = (c: KanvasComment) => (filter === "all" || filter === "resolved" ? true : c.state !== "resolved");

  const showIn = (target: string) => {
    const frame = frames.current.get(target);
    if (!frame?.contentWindow) return;
    const activeComment = comments.find((c) => c.id === active);
    const selected =
      selection?.target === target
        ? { selector: selection.anchor.selector, src: anchorSrc(selection.anchor) }
        : activeComment?.target === target
          ? { selector: activeComment.anchor.selector, src: anchorSrc(activeComment.anchor) }
          : null;
    const message: ShowMessage = {
      type: "kanvas:show",
      pins: comments
        .filter((c) => c.target === target && pinned(c))
        .map((c) => ({ id: c.id, n: c.id, state: c.state, selector: c.anchor.selector, src: anchorSrc(c.anchor) })),
      selected,
    };
    // The frame's origin is opaque, so "*" is the only target that reaches it.
    frame.contentWindow.postMessage(message, "*");
  };

  useEffect(() => {
    for (const target of frames.current.keys()) showIn(target);
  }, [comments, selection, active, filter]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && (selection || active !== null)) {
        setSelection(null);
        setActive(null);
        void kanvasApi.select(project, null, null).catch(() => {});
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selection, active]);

  const submit = async () => {
    if (!selection || !draft.trim()) return;
    try {
      const comment = await kanvasApi.addComment(project, selection.target, selection.anchor, draft);
      setComments((cs) => (cs.some((c) => c.id === comment.id) ? cs : [...cs, comment]));
      setDraft("");
      setSelection(null);
      setActive(comment.id);
      if (filter !== "open" && filter !== "all") setFilter("open");
    } catch (e) {
      onMessage(`The comment was not saved: ${(e as Error).message}`);
    }
  };

  const changeState = async (id: number, next: CommentState) => {
    try {
      const updated = await kanvasApi.setState(project, id, next);
      setComments((cs) => cs.map((c) => (c.id === id ? updated : c)));
    } catch (e) {
      onMessage((e as Error).message);
    }
  };

  const remove = async (id: number) => {
    try {
      await kanvasApi.deleteComment(project, id);
      setComments((cs) => cs.filter((c) => c.id !== id));
      if (active === id) setActive(null);
    } catch (e) {
      onMessage((e as Error).message);
    }
  };

  const counts = useMemo(() => {
    const out: Record<Filter, number> = { open: 0, addressed: 0, resolved: 0, all: comments.length };
    for (const c of comments) out[c.state]++;
    return out;
  }, [comments]);
  const listed = comments.filter((c) => filter === "all" || c.state === filter).sort((a, b) => b.id - a.id);

  if (error) return <div className="screen is-kanvas"><div className="center center-empty">Kanvas could not load: {error}</div></div>;
  if (!state) return <div className="screen is-kanvas"><div className="center center-empty">Loading Kanvas…</div></div>;
  if (!state.hasDesign || !board)
    return (
      <div className="screen is-kanvas">
        <section className="kv-main">
          <div className="toolbar kv-toolbar">{picker}</div>
          <div className="center center-empty kv-empty-state">
            <p>
              {state.hasDesign ? `No exploration board in ${state.root}/design/apps/ yet.` : `${projectName(state.root)} has no design/ folder yet.`} Pick another
              project, or ask your agent to start a board in this one.
            </p>
            <StartBoard root={state.root} example={state.example} />
          </div>
        </section>
      </div>
    );

  return (
    <div className="screen is-kanvas">
      <section className="kv-main">
        <div className="toolbar kv-toolbar">
          {picker}
          <div className="kv-heading">
            <span className="kv-app mono">{board.app}</span>
            <span className="kv-title">{board.title}</span>
          </div>
          <div className="segmented" role="group" aria-label="Frame width">
            {WIDTHS.map((w) => (
              <button key={w} type="button" className={`segmented-opt${width === w ? " is-active" : ""}`} aria-pressed={width === w} onClick={() => setWidth(w)}>
                {w === "fit" ? "Fit" : `${w}px`}
              </button>
            ))}
          </div>
          <BuildStatus build={build} />
        </div>
        {build && !build.ok && <pre className="kv-build-error mono">{build.error}</pre>}
        <div className="kv-rounds">
          {board.rounds.map((round, i) => {
            const open = openRounds[round.n] ?? i === 0;
            return (
              <section key={round.n} className="kv-round">
                <button
                  type="button"
                  className="kv-round-head"
                  aria-expanded={open}
                  onClick={() => setOpenRounds((r) => ({ ...r, [round.n]: !open }))}
                >
                  {open ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                  <span className="kv-round-n">Round {round.n}</span>
                  {round.fidelity && <span className="kv-fidelity">{round.fidelity}</span>}
                  <span className="kv-question">{round.question}</span>
                </button>
                {round.outcome && <p className="kv-outcome">Outcome: {round.outcome}</p>}
                {open && (
                  <div className="kv-options">
                    {round.options.map((option) => (
                      <OptionFrame
                        key={option.target}
                        option={option}
                        width={width}
                        reload={reloads[option.target] ?? 0}
                        openCount={comments.filter((c) => c.target === option.target && c.state === "open").length}
                        register={(el) => {
                          if (el) frames.current.set(option.target, el);
                          else frames.current.delete(option.target);
                        }}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </section>
      <aside className="kv-side" aria-label="Comments">
        <div className="kv-side-head">
          <div className="kv-side-title">Comments</div>
          <p className="kv-hint">
            <MousePointerClick size={14} aria-hidden="true" /> Click an element in an option to comment on it. Hold <kbd>Alt</kbd> to use the design normally.
          </p>
        </div>
        {selection && (
          <form
            className="kv-composer"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="kv-composer-anchor">
              <span className="kv-label-chip mono">{labelOf(selection.target)}</span>
              <span className="mono">&lt;{selection.anchor.tag}&gt;</span>
              <span className="kv-anchor-file mono" data-tip={selection.anchor.file}>
                {fileName(selection.anchor.file)}:{selection.anchor.line}
              </span>
              <button type="button" className="kv-icon-btn" aria-label="Cancel the selection" data-tip="Cancel (Esc)" onClick={() => setSelection(null)}>
                <X size={14} aria-hidden="true" />
              </button>
            </div>
            {selection.anchor.text && <div className="kv-excerpt">“{selection.anchor.text}”</div>}
            <textarea
              ref={draftBox}
              className="kv-textarea"
              rows={3}
              placeholder="What should change here?"
              aria-label="Comment"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="kv-composer-actions">
              <span className="kv-hint-small">Ctrl+Enter</span>
              <button type="submit" className="kv-btn is-primary" disabled={!draft.trim()}>
                <MessageSquarePlus size={14} aria-hidden="true" /> Comment
              </button>
            </div>
          </form>
        )}
        <div className="kv-filter">
          <div className="segmented" role="group" aria-label="Show comments">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" className={`segmented-opt${filter === f.id ? " is-active" : ""}`} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} {counts[f.id]}
              </button>
            ))}
          </div>
        </div>
        <ol className="kv-list">
          {listed.length === 0 && <li className="kv-empty">No {filter === "all" ? "" : `${filter} `}comments.</li>}
          {listed.map((c) => (
            <li
              key={c.id}
              id={`kv-comment-${c.id}`}
              className={`kv-comment state-${c.state}${active === c.id ? " is-active" : ""}`}
              onClick={() => {
                setActive(active === c.id ? null : c.id);
                setSelection(null);
              }}
            >
              <div className="kv-comment-head">
                <span className={`kv-pin state-${c.state}`}>{c.id}</span>
                <span className="kv-label-chip mono">{labelOf(c.target)}</span>
                <span className="mono kv-tag">&lt;{c.anchor.tag}&gt;</span>
                <span className="kv-anchor-file mono" data-tip={`${c.anchor.file}:${c.anchor.line}:${c.anchor.column}`}>
                  {fileName(c.anchor.file)}:{c.anchor.line}
                </span>
                <span className={`kv-state state-${c.state}`}>{c.state}</span>
              </div>
              {c.anchor.text && <div className="kv-excerpt">“{c.anchor.text}”</div>}
              <div className="kv-body">{c.body}</div>
              {c.note && (
                <div className="kv-note">
                  <span className="kv-note-label">Agent:</span> {c.note}
                </div>
              )}
              <div className="kv-comment-actions" onClick={(e) => e.stopPropagation()}>
                {c.state !== "resolved" ? (
                  <button type="button" className="kv-btn" onClick={() => void changeState(c.id, "resolved")}>
                    <Check size={14} aria-hidden="true" /> Resolve
                  </button>
                ) : null}
                {c.state !== "open" ? (
                  <button type="button" className="kv-btn" onClick={() => void changeState(c.id, "open")}>
                    <RotateCcw size={14} aria-hidden="true" /> Reopen
                  </button>
                ) : null}
                <button type="button" className="kv-btn is-quiet" onClick={() => void remove(c.id)}>
                  <Trash2 size={14} aria-hidden="true" /> Delete
                </button>
              </div>
            </li>
          ))}
        </ol>
        <p className="kv-footnote">
          The agent reads these from <span className="mono" data-tip={`${state.root}/design/.kanvas/comments.json`}>design/.kanvas/comments.json</span> in{" "}
          {projectName(state.root)}. Tell it in the chat when you have commented.
        </p>
      </aside>
    </div>
  );
}

// Copies a prompt that has the owner's agent start a board in this project,
// and shows it in a dialog that says so.
function StartBoard({ root, example }: { root: string; example: string }) {
  const [shown, setShown] = useState<{ prompt: string; copied: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const ask = async () => {
    const prompt = startBoardPrompt(root, example);
    let copied = false;
    try {
      await navigator.clipboard.writeText(prompt);
      copied = true;
    } catch {
      // No clipboard access: the dialog shows the prompt selected, to copy by hand.
    }
    setShown({ prompt, copied });
  };
  return (
    <>
      <button ref={button} type="button" className="kv-btn is-primary" data-tip="Copy a prompt that has your agent start a board here" onClick={ask}>
        <Copy size={14} aria-hidden="true" /> Ask your agent
      </button>
      {shown &&
        createPortal(
          <AskDialog
            {...shown}
            edited={[]}
            noun="prompt"
            about="it names this project's folder and the format Kanvas reads, so the agent can start the board."
            returnFocus={button.current}
            onClose={() => setShown(null)}
          />,
          document.body,
        )}
    </>
  );
}

function BuildStatus({ build }: { build: BuildState | null }) {
  if (!build || build.id === 0) return <span className="kv-build">Building…</span>;
  if (!build.ok) return <span className="kv-build is-error">Build failed</span>;
  const at = build.finished ? new Date(build.finished).toLocaleTimeString() : "";
  return (
    <span className="kv-build" data-tip="Time from the first file change to the finished build; the frames reload after it">
      Updated {at}, {build.ms} ms after the change
    </span>
  );
}

function OptionFrame({
  option,
  width,
  reload,
  openCount,
  register,
}: {
  option: BoardOption;
  width: Width;
  reload: number;
  openCount: number;
  register: (el: HTMLIFrameElement | null) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState(0);
  useEffect(() => {
    if (!box.current) return;
    const observer = new ResizeObserver(([entry]) => setRoom(entry.contentRect.width));
    observer.observe(box.current);
    return () => observer.disconnect();
  }, []);
  // A fixed width wider than the column is scaled down to fit it; a
  // narrower one is centred in it.
  const px = width === "fit" ? Math.max(room, 1) : width;
  const scale = room > 0 ? Math.min(1, room / px) : 1;
  const left = Math.max(0, (room - px * scale) / 2);
  return (
    <article className="kv-option">
      <header className="kv-option-head">
        <span className="kv-label-chip is-large mono">{option.label}</span>
        <span className="kv-option-title">{option.title}</span>
        {openCount > 0 && <span className="kv-open-count" data-tip="Open comments on this option">{openCount} open</span>}
      </header>
      <p className="kv-direction">{option.direction}</p>
      <div className="kv-frame-box" ref={box} style={{ height: FRAME_HEIGHT * scale }}>
        {option.frame ? (
          <iframe
            ref={register}
            className="kv-frame"
            src={`${option.frame}?b=${reload}`}
            sandbox="allow-scripts"
            aria-label={`Option ${option.label}: ${option.title}`}
            style={{ width: px, height: FRAME_HEIGHT, marginLeft: left, transform: `scale(${scale})` }}
          />
        ) : (
          <div className="kv-frame-missing">No Option.tsx for {option.label} yet.</div>
        )}
      </div>
      <div className="kv-scale mono">
        {width === "fit" ? `${Math.round(room)}px, the column's width` : scale < 1 ? `${Math.round(scale * 100)}% of ${px}px` : `${px}px`}
      </div>
    </article>
  );
}
