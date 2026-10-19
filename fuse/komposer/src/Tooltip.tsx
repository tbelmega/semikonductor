// SPDX-License-Identifier: Apache-2.0
// Komposer's one tooltip. An element asks for a plain-text tip with a
// data-tip attribute, and the field info icons show richer content through
// useTooltip; both are drawn by the one layer here, in the same dark box.
// A tip opens after a short delay on hover, at once on click or keyboard
// focus, and soon when another tip is shown or has just closed, so moving
// along a row of pills does not wait at each one. It stays open while the pointer is on
// the anchor or on the tip itself, or keyboard focus is on the anchor, and
// closes a moment after they leave, at once on Escape, on scrolling, and
// when its anchor leaves the page. The browser's own title tooltip is
// not used: it opens late, not reliably, never on focus, and cannot be
// styled.

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const OPEN_DELAY = 150;
const CLOSE_DELAY = 120;
const WARM_MS = 400;
const GAP = 6;
const EDGE = 8;
const TIP_ID = "komposer-tooltip";

type Source = "attr" | "api";
type Shown = { anchor: Element; content: ReactNode; source: Source };
type Api = { show(anchor: Element, content: ReactNode): void; hide(anchor: Element): void };

const TooltipContext = createContext<Api | null>(null);

export function useTooltip(): Api {
  const api = useContext(TooltipContext);
  if (!api) throw new Error("useTooltip needs the TooltipLayer around the app");
  return api;
}

const tipOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest("[data-tip]") : null;

// Whether keyboard focus is on the anchor or inside it.
const keyboardFocused = (anchor: Element) => {
  const active = document.activeElement;
  return !!active && anchor.contains(active) && active.matches(":focus-visible");
};

export function TooltipLayer({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const current = useRef<Shown | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const closedAt = useRef(0);

  const open = useCallback((next: Shown, immediate: boolean) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(closeTimer.current);
    const go = () => {
      // A plain-text tip reads its attribute again when it opens, so a tip
      // whose text changed, or whose anchor went, during the delay is right.
      if (!next.anchor.isConnected) return;
      const content = next.source === "attr" ? next.anchor.getAttribute("data-tip") : next.content;
      if (!content) return;
      const shownNow = { ...next, content };
      current.current = shownNow;
      setShown(shownNow);
    };
    // Moving on from a shown tip switches after a short pause, so the
    // pointer can cross another element on its way onto the tip.
    if (immediate || (!current.current && Date.now() - closedAt.current < WARM_MS)) go();
    else timer.current = window.setTimeout(go, current.current ? CLOSE_DELAY : OPEN_DELAY);
  }, []);

  const close = useCallback((anchor?: Element) => {
    window.clearTimeout(timer.current);
    window.clearTimeout(closeTimer.current);
    if (anchor && current.current && current.current.anchor !== anchor) return;
    if (current.current) closedAt.current = Date.now();
    current.current = null;
    setShown(null);
  }, []);

  // The pointer leaving a tip's anchor closes it after a moment, so the
  // pointer can cross onto the tip to read or select its text, and not
  // while keyboard focus is still on the anchor.
  const leave = useCallback(
    (anchor?: Element) => {
      window.clearTimeout(timer.current);
      const now = current.current;
      if (!now || (anchor && now.anchor !== anchor)) return;
      if (keyboardFocused(now.anchor)) return;
      window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => close(now.anchor), CLOSE_DELAY);
    },
    [close],
  );
  const stay = useCallback(() => {
    window.clearTimeout(timer.current);
    window.clearTimeout(closeTimer.current);
  }, []);

  // Plain-text tips, for every element with data-tip, through delegated
  // listeners on the document.
  useEffect(() => {
    const attrTip = (el: Element): Shown | null => {
      const text = el.getAttribute("data-tip");
      return text ? { anchor: el, content: text, source: "attr" } : null;
    };
    const onTip = (target: EventTarget | null) => target instanceof Node && !!document.getElementById(TIP_ID)?.contains(target);
    const over = (event: PointerEvent) => {
      const now = current.current;
      if (now && !now.anchor.isConnected) close();
      if (onTip(event.target)) return stay();
      const el = tipOf(event.target);
      if (el && el === current.current?.anchor) stay();
      else if (el) {
        const next = attrTip(el);
        if (next) open(next, false);
      } else {
        window.clearTimeout(timer.current);
        if (current.current?.source === "attr") leave();
      }
    };
    const out = (event: PointerEvent) => {
      if (onTip(event.target) && !onTip(event.relatedTarget)) {
        const anchor = current.current?.anchor;
        if (anchor && !anchor.contains(event.relatedTarget as Node | null)) leave(anchor);
        return;
      }
      const el = tipOf(event.target);
      if (!el || el.contains(event.relatedTarget as Node | null) || onTip(event.relatedTarget)) return;
      if (current.current?.anchor === el) leave(el);
      else window.clearTimeout(timer.current);
    };
    const down = (event: PointerEvent) => {
      if (onTip(event.target)) return;
      const el = tipOf(event.target);
      const next = el && attrTip(el);
      if (next) open(next, true);
    };
    const focusIn = (event: FocusEvent) => {
      const el = tipOf(event.target);
      if (!el || !(event.target as Element).matches(":focus-visible")) return;
      const next = attrTip(el);
      if (next) open(next, true);
    };
    const focusOut = (event: FocusEvent) => {
      const el = tipOf(event.target);
      if (el && current.current?.anchor === el) close(el);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && close();
    const scroll = (event: Event) => !onTip(event.target) && close();
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", down);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", focusOut);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", focusOut);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
      window.clearTimeout(timer.current);
      window.clearTimeout(closeTimer.current);
    };
  }, [open, close, leave, stay]);

  // A shown plain-text tip follows its attribute: it updates when the text
  // changes, as on a save button whose reason changes, and closes when the
  // attribute goes. Any shown tip closes when its anchor leaves the page, as
  // when its step is deleted, since no leave or blur event comes then.
  useEffect(() => {
    if (!shown) return;
    const observer = new MutationObserver(() => {
      if (!shown.anchor.isConnected) return close();
      if (shown.source !== "attr") return;
      const text = shown.anchor.getAttribute("data-tip");
      if (!text) close();
      else if (text !== shown.content) open({ ...shown, content: text }, true);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    if (shown.source === "attr") observer.observe(shown.anchor, { attributes: true, attributeFilter: ["data-tip"] });
    return () => observer.disconnect();
  }, [shown, open, close]);

  // While shown, the tip describes its anchor for assistive technology.
  useEffect(() => {
    if (!shown) return;
    const anchor = shown.anchor;
    const before = anchor.getAttribute("aria-describedby");
    if (!before) anchor.setAttribute("aria-describedby", TIP_ID);
    return () => {
      if (!before) anchor.removeAttribute("aria-describedby");
    };
  }, [shown]);

  const api = useMemo<Api>(
    () => ({ show: (anchor, content) => open({ anchor, content, source: "api" }, true), hide: (anchor) => leave(anchor) }),
    [open, leave],
  );

  return (
    <TooltipContext.Provider value={api}>
      {children}
      {shown && createPortal(<TooltipBox shown={shown} />, document.body)}
    </TooltipContext.Provider>
  );
}

// The box: below its anchor and centred on it, above when there is no room
// below, and kept inside the window.
function TooltipBox({ shown }: { shown: Shown }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const a = shown.anchor.getBoundingClientRect();
    const b = el.getBoundingClientRect();
    const below = a.bottom + GAP + b.height <= window.innerHeight - EDGE;
    const top = below ? a.bottom + GAP : Math.max(EDGE, a.top - GAP - b.height);
    const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - EDGE - b.width));
    setPos({ left, top });
  }, [shown]);
  return (
    <div
      ref={box}
      id={TIP_ID}
      role="tooltip"
      className={`tooltip${shown.source === "attr" ? " is-text" : ""}`}
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
    >
      {shown.content}
    </div>
  );
}
