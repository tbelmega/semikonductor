// SPDX-License-Identifier: Apache-2.0
// Komposer's one tooltip, drawn in a layer on the body. An element asks for a
// plain-text tip with a data-tip attribute, and the field info icons show
// richer content through useTooltip; both are drawn here, in the same dark
// box. When a tip opens and closes is decided by model/tooltip.ts; this file
// feeds it the page's events and draws what it shows. The browser's own
// title tooltip is not used: it opens late, not reliably, never on focus,
// and cannot be styled.

import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createTooltip, type TipShown, type Tooltip } from "./model/tooltip.ts";

const GAP = 6;
const EDGE = 8;
const TIP_ID = "komposer-tooltip";

type Shown = TipShown<Element, ReactNode>;
type Api = { show(anchor: Element, content: ReactNode): void; hide(anchor: Element): void };

const TooltipContext = createContext<Api | null>(null);

export function useTooltip(): Api {
  const api = useContext(TooltipContext);
  if (!api) throw new Error("useTooltip needs the TooltipLayer around the app");
  return api;
}

const tipOf = (target: EventTarget | null): Element | null =>
  target instanceof Element ? target.closest("[data-tip]") : null;
const onTip = (target: EventTarget | null) =>
  target instanceof Node && !!document.getElementById(TIP_ID)?.contains(target);

export function TooltipLayer({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState<Shown | null>(null);
  const tooltip = useRef<Tooltip<Element, ReactNode> | null>(null);

  useEffect(() => {
    let pointerAt: Element | null = null;
    const tip = createTooltip<Element, ReactNode>({
      now: () => Date.now(),
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (id) => window.clearTimeout(id),
      connected: (anchor) => anchor.isConnected,
      text: (anchor) => anchor.getAttribute("data-tip"),
      pointerHolds: (anchor) => !!pointerAt && (anchor.contains(pointerAt) || onTip(pointerAt)),
      focusHolds: (anchor) => {
        const active = document.activeElement;
        return !!active && anchor.contains(active) && active.matches(":focus-visible");
      },
      render: setShown,
    });
    tooltip.current = tip;
    const over = (event: PointerEvent) => {
      pointerAt = event.target instanceof Element ? event.target : null;
      tip.pointerOver(tipOf(event.target), onTip(event.target));
    };
    // Leaving the window: no pointerover follows.
    const out = (event: PointerEvent) => {
      if (event.relatedTarget) return;
      pointerAt = null;
      tip.pointerLeftWindow();
    };
    const down = (event: PointerEvent) => tip.press(tipOf(event.target), onTip(event.target));
    const focusIn = (event: FocusEvent) => {
      const el = tipOf(event.target);
      if (el && (event.target as Element).matches(":focus-visible")) tip.focus(el);
    };
    const key = (event: KeyboardEvent) => event.key === "Escape" && tip.dismiss();
    const scroll = (event: Event) => !onTip(event.target) && tip.dismiss();
    const resize = () => tip.dismiss();
    // An anchor leaving the page sends no leave or blur event, as when its
    // step is deleted; and a shown tip follows its anchor's text.
    const observer = new MutationObserver(() => tip.pageChanged());
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-tip"] });
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    document.addEventListener("pointerdown", down);
    document.addEventListener("focusin", focusIn);
    document.addEventListener("focusout", tip.blur);
    document.addEventListener("keydown", key);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("focusin", focusIn);
      document.removeEventListener("focusout", tip.blur);
      document.removeEventListener("keydown", key);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
      tip.stop();
      tooltip.current = null;
    };
  }, []);

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
    () => ({
      show: (anchor, content) => tooltip.current?.show(anchor, content),
      hide: (anchor) => tooltip.current?.hide(anchor),
    }),
    [],
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
