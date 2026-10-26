// SPDX-License-Identifier: Apache-2.0
// One round of an exploration board as a canvas of its own: the round's
// options as frames side by side at the chosen width, each as tall as its
// design, on a surface the owner pans and zooms.
//
//   - the mouse wheel, or a pinch, zooms around the pointer, also over a
//     frame: the bridge in each frame passes its wheel events up;
//   - dragging the empty canvas pans it, and so does dragging anywhere while
//     Space is held;
//   - the zoom buttons, and +, -, 0 and the arrow keys on the focused canvas,
//     do the same without a mouse; 0 and Fit show every option.
//
// The canvas fits its options until the owner pans or zooms it, and again
// when the width changes. Hold Alt to scroll a design itself.
//
// Prototype (workstream kanvas): the view is not kept across reloads.

import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import type { BoardRound, FrameMessage } from "./model.ts";

// Canvas units, which are CSS pixels at 100%.
const GAP = 96;
const DEFAULT_HEIGHT = 900;
const MAX_HEIGHT = 6000;
// Screen pixels around the options when fitted; the top leaves room for the
// options' labels above their frames.
const PAD = 24;
const PAD_TOP = 48;
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 3;
const STEP = 1.25;

interface View {
  x: number;
  y: number;
  z: number;
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

// How much a wheel event zooms: lines and pages count as many pixels.
const wheelFactor = (dy: number, mode: number) => Math.exp(-(mode === 1 ? dy * 16 : mode === 2 ? dy * 400 : dy) * 0.002);

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

export function RoundCanvas({
  round,
  width,
  reloads,
  openCount,
  register,
}: {
  round: BoardRound;
  width: number;
  reloads: Record<string, number>;
  openCount: (target: string) => number;
  // Every frame, so the page can send it pins and recognise its messages.
  register: (target: string, el: HTMLIFrameElement | null) => void;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const own = useRef(new Map<string, HTMLIFrameElement>());
  const [heights, setHeights] = useState<Record<string, number>>({});
  const [view, setView] = useState<View>({ x: PAD, y: PAD_TOP, z: 0.5 });
  const viewRef = useRef(view);
  viewRef.current = view;
  // Whether the owner has panned or zoomed since the last fit.
  const touched = useRef(false);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; id: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const options = round.options;
  const heightOf = (target: string) => heights[target] ?? DEFAULT_HEIGHT;
  const contentW = Math.max(1, options.length * width + Math.max(0, options.length - 1) * GAP);
  const contentH = Math.max(DEFAULT_HEIGHT, ...options.map((o) => heightOf(o.target)));

  const fit = useCallback(() => {
    const el = viewport.current;
    if (!el || el.clientWidth === 0) return;
    const z = clampZoom(Math.min((el.clientWidth - 2 * PAD) / contentW, (el.clientHeight - PAD - PAD_TOP) / contentH, 1));
    touched.current = false;
    setView({ z, x: Math.max(PAD, (el.clientWidth - contentW * z) / 2), y: PAD_TOP });
  }, [contentW, contentH]);
  const fitRef = useRef(fit);
  fitRef.current = fit;

  // Keep fitting while the owner has not moved the view: frames report their
  // heights after they load, and the viewport changes size with the window.
  useLayoutEffect(() => {
    if (!touched.current) fit();
  }, [fit]);
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      if (!touched.current) fitRef.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  // A new width is a new layout: show all of it.
  const firstWidth = useRef(true);
  useEffect(() => {
    if (firstWidth.current) {
      firstWidth.current = false;
      return;
    }
    touched.current = false;
    fitRef.current();
  }, [width]);

  // Zoom by `factor` around a point given relative to the viewport.
  const zoomAt = (px: number, py: number, factor: number) => {
    touched.current = true;
    setView((v) => {
      const z = clampZoom(v.z * factor);
      const k = z / v.z;
      return { z, x: px - (px - v.x) * k, y: py - (py - v.y) * k };
    });
  };
  const zoomAtRef = useRef(zoomAt);
  zoomAtRef.current = zoomAt;
  const zoomCentre = (factor: number) => {
    const el = viewport.current;
    if (el) zoomAt(el.clientWidth / 2, el.clientHeight / 2, factor);
  };
  const panBy = (dx: number, dy: number) => {
    touched.current = true;
    setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
  };

  // The wheel over the canvas itself. React's onWheel is passive, so it
  // cannot keep the page from scrolling; a native listener can.
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAtRef.current(event.clientX - r.left, event.clientY - r.top, wheelFactor(event.deltaY, event.deltaMode));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // What this canvas's own frames send: their heights, their wheel events and
  // Space, which the bridge passes up because a frame has the keyboard focus
  // after a click in it.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const entry = [...own.current.entries()].find(([, f]) => f.contentWindow === event.source);
      if (!entry) return;
      const [target, frame] = entry;
      const data = event.data as FrameMessage;
      if (!data || typeof data !== "object") return;
      if (data.type === "kanvas:size") {
        const h = Math.min(MAX_HEIGHT, Math.max(200, Math.ceil(data.height)));
        setHeights((hs) => (hs[target] === h ? hs : { ...hs, [target]: h }));
      } else if (data.type === "kanvas:wheel") {
        const el = viewport.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const f = frame.getBoundingClientRect();
        const z = viewRef.current.z;
        zoomAtRef.current(f.left + data.x * z - r.left, f.top + data.y * z - r.top, wheelFactor(data.dy, data.mode));
      } else if (data.type === "kanvas:space") setSpaceHeld(data.down);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || isTyping(event.target) || event.target instanceof HTMLButtonElement) return;
      event.preventDefault();
      setSpaceHeld(event.type === "keydown");
    };
    const release = () => setSpaceHeld(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
      window.removeEventListener("blur", release);
    };
  }, []);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    if ((event.target as HTMLElement).closest(".kv-zoom")) return;
    event.preventDefault();
    viewport.current?.focus({ preventScroll: true });
    drag.current = { x: event.clientX, y: event.clientY, vx: view.x, vy: view.y, id: event.pointerId };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    touched.current = true;
    setView((v) => ({ ...v, x: d.vx + event.clientX - d.x, y: d.vy + event.clientY - d.y }));
  };
  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== event.pointerId) return;
    drag.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = 80;
    const actions: Record<string, () => void> = {
      "+": () => zoomCentre(STEP),
      "=": () => zoomCentre(STEP),
      "-": () => zoomCentre(1 / STEP),
      "0": () => fit(),
      ArrowLeft: () => panBy(step, 0),
      ArrowRight: () => panBy(-step, 0),
      ArrowUp: () => panBy(0, step),
      ArrowDown: () => panBy(0, -step),
    };
    const action = actions[event.key];
    if (!action || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    action();
  };

  // Labels keep a readable size on screen at any zoom.
  const labelScale = 1 / view.z;

  return (
    <div className="kv-canvas-wrap">
      <div
        ref={viewport}
        className={`kv-canvas${spaceHeld ? " is-space" : ""}${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-label={`Round ${round.n} canvas. Drag to pan, wheel to zoom; plus, minus, 0 and the arrow keys when focused.`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
      >
        <div className="kv-stage" style={{ width: contentW, height: contentH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }}>
          {options.map((option, i) => {
            const open = openCount(option.target);
            return (
              <div key={option.target} className="kv-node" style={{ left: i * (width + GAP), width }}>
                <div className="kv-node-head" style={{ transform: `scale(${labelScale})` }}>
                  <span className="kv-label-chip mono">{option.label}</span>
                  <span className="kv-node-title">{option.title}</span>
                  {open > 0 && <span className="kv-open-count">{open} open</span>}
                </div>
                {option.frame ? (
                  <iframe
                    ref={(el) => {
                      if (el) own.current.set(option.target, el);
                      else own.current.delete(option.target);
                      register(option.target, el);
                    }}
                    className="kv-frame"
                    src={`${option.frame}?b=${reloads[option.target] ?? 0}`}
                    sandbox="allow-scripts"
                    aria-label={`Option ${option.label}: ${option.title}`}
                    style={{ width, height: heightOf(option.target) }}
                  />
                ) : (
                  <div className="kv-frame-missing" style={{ width, height: DEFAULT_HEIGHT }}>
                    No Option.tsx for {option.label} yet.
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="kv-zoom" role="group" aria-label={`Zoom of round ${round.n}`}>
        <button type="button" className="kv-icon-btn" aria-label="Zoom out" data-tip="Zoom out (-)" onClick={() => zoomCentre(1 / STEP)}>
          <Minus size={14} aria-hidden="true" />
        </button>
        <span className="kv-zoom-value mono" aria-live="polite">
          {Math.round(view.z * 100)}%
        </span>
        <button type="button" className="kv-icon-btn" aria-label="Zoom in" data-tip="Zoom in (+)" onClick={() => zoomCentre(STEP)}>
          <Plus size={14} aria-hidden="true" />
        </button>
        <button type="button" className="kv-btn" data-tip="Show every option (0)" onClick={fit}>
          <Maximize size={14} aria-hidden="true" /> Fit
        </button>
      </div>
    </div>
  );
}
