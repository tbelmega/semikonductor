// SPDX-License-Identifier: Apache-2.0
// The tooltip's behaviour, apart from the page: when a tip opens, which one
// it is, and when it closes. Tooltip.tsx feeds it the page's pointer, focus
// and keyboard events and draws what it shows.
//
// A tip opens after a short delay on hover, at once on a press or on
// keyboard focus, and at once just after another tip closed, so moving along
// a row of pills does not wait at each one. Moving on from a shown tip to
// another anchor waits as long as a close does, so the pointer can cross
// another anchor on its way onto the tip. A shown tip is held while its
// anchor is on the page and the pointer is on the anchor or on the tip, or
// keyboard focus is on the anchor. Every way of leaving it (the pointer, the
// focus, the window) checks a moment later whether something still holds it,
// and closes it if not. Escape, scrolling and the anchor leaving the page
// close it at once.

export const OPEN_DELAY = 150;
export const CLOSE_DELAY = 120;
export const WARM_MS = 400;

export type TipSource = "attr" | "api";
export type TipShown<A, C> = { anchor: A; content: C | string; source: TipSource };

export interface TipEnv<A, C> {
  now(): number;
  setTimer(run: () => void, ms: number): number;
  clearTimer(id: number | undefined): void;
  // The anchor is still on the page.
  connected(anchor: A): boolean;
  // The anchor's data-tip text, or null when it has none.
  text(anchor: A): string | null;
  // The pointer is on the anchor or on the tip.
  pointerHolds(anchor: A): boolean;
  // Keyboard focus is on the anchor or inside it.
  focusHolds(anchor: A): boolean;
  render(shown: TipShown<A, C> | null): void;
}

export interface Tooltip<A, C> {
  // The pointer moved onto an element: inside the anchor given, or none; on
  // the tip itself.
  pointerOver(anchor: A | null, onTip: boolean): void;
  pointerLeftWindow(): void;
  press(anchor: A | null, onTip: boolean): void;
  // Keyboard focus reached an anchor.
  focus(anchor: A): void;
  blur(): void;
  dismiss(): void;
  // The page changed: an anchor may have left, or its text changed.
  pageChanged(): void;
  // A tip with rich content, opened and left by its own anchor's events.
  show(anchor: A, content: C): void;
  hide(anchor: A): void;
  shown(): TipShown<A, C> | null;
  stop(): void;
}

export function createTooltip<A, C>(env: TipEnv<A, C>): Tooltip<A, C> {
  let current: TipShown<A, C> | null = null;
  let pending: A | null = null;
  let openTimer: number | undefined;
  let checkTimer: number | undefined;
  let closedAt = -Infinity;

  const set = (next: TipShown<A, C> | null) => {
    current = next;
    env.render(next);
  };
  const cancelOpen = () => {
    env.clearTimer(openTimer);
    openTimer = undefined;
    pending = null;
  };
  const close = () => {
    cancelOpen();
    env.clearTimer(checkTimer);
    checkTimer = undefined;
    if (current) closedAt = env.now();
    if (current) set(null);
  };
  const held = (now: TipShown<A, C>) => env.connected(now.anchor) && (env.pointerHolds(now.anchor) || env.focusHolds(now.anchor));
  const check = () => {
    if (!current) return;
    env.clearTimer(checkTimer);
    checkTimer = env.setTimer(() => {
      checkTimer = undefined;
      if (current && !held(current)) close();
    }, CLOSE_DELAY);
  };
  // A plain-text tip reads its text when it opens, so a tip whose text
  // changed, or whose anchor went, during the delay is right.
  const open = (anchor: A, source: TipSource, content: C | undefined, immediate: boolean) => {
    cancelOpen();
    const go = () => {
      openTimer = undefined;
      pending = null;
      if (!env.connected(anchor)) return;
      const shown = source === "attr" ? env.text(anchor) : content;
      if (shown === null || shown === undefined || shown === "") return;
      set({ anchor, content: shown, source });
    };
    if (immediate || (!current && env.now() - closedAt < WARM_MS)) return go();
    pending = anchor;
    openTimer = env.setTimer(go, current ? CLOSE_DELAY : OPEN_DELAY);
  };

  return {
    pointerOver(anchor, onTip) {
      if (current && !env.connected(current.anchor)) close();
      if (onTip || (anchor !== null && anchor === current?.anchor)) return cancelOpen();
      if (anchor === null) cancelOpen();
      else if (anchor !== pending && env.text(anchor)) open(anchor, "attr", undefined, false);
      check();
    },
    pointerLeftWindow() {
      cancelOpen();
      check();
    },
    press(anchor, onTip) {
      if (!onTip && anchor !== null && env.text(anchor)) open(anchor, "attr", undefined, true);
    },
    focus(anchor) {
      if (env.text(anchor)) open(anchor, "attr", undefined, true);
    },
    blur: check,
    dismiss: close,
    pageChanged() {
      if (!current) return;
      if (!env.connected(current.anchor)) return close();
      if (current.source !== "attr") return;
      const text = env.text(current.anchor);
      if (!text) close();
      else if (text !== current.content) set({ ...current, content: text });
    },
    show(anchor, content) {
      open(anchor, "api", content, true);
    },
    hide(anchor) {
      if (current?.anchor === anchor) check();
    },
    shown: () => current,
    stop() {
      env.clearTimer(openTimer);
      env.clearTimer(checkTimer);
    },
  };
}
