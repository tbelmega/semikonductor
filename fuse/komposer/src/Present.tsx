// SPDX-License-Identifier: Apache-2.0
// The Present page: the selected workflow's diagram, read-only, under its
// name and description, optionally next to a second workflow in the same
// scroll area. The workflow list and the Show panel are drawers: a strip on
// each side that slides its panel in over the diagram on hover, stays open
// while focus is inside it and for a moment after the pointer leaves, and
// pins open with its pin button. Both drawers open together on hover, and
// the diagram stays where it is under them.

import { useEffect, useRef, useState, type FocusEvent, type ReactNode, type RefObject } from "react";
import { Pin, PinOff } from "lucide-react";
import type { LibraryEntry } from "./api.ts";
import { Flow } from "./Flow.tsx";
import { pickerLabel } from "./Compare.tsx";
import {
  ALL_SHOWN,
  SHOW_TOGGLES,
  STEPS_ONLY,
  createDrawerHover,
  drawerOpen,
  drawerPointer,
  releasesFocus,
  type FlowShow,
} from "./model/present.ts";
import { onTip, useTooltip } from "./Tooltip.tsx";
import {
  stem,
  stepViews,
  workflowDescription,
  workflowHandOffs,
  workflowInputs,
  workflowKey,
  type OpenWorkflow,
  type WorkflowLink,
} from "./workflowView.ts";

// Moves focus out of a drawer that is about to close, when the focused
// element inside it is a control clicked with the mouse (releasesFocus).
// Its blur then clears the drawer's focus, so the drawer closes.
function releaseFocus(drawer: Element) {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !drawer.contains(active)) return;
  const field = ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
  if (releasesFocus({ field, keyboard: active.matches(":focus-visible") })) active.blur();
}

// A drawer is open while any element inside it has focus, so focus never
// sits on a hidden control. A pin clicked with the mouse does not count: it
// takes focus on mouse-down, and opening the drawer then would slide the
// button away before the click completes.
function useDrawerFocus() {
  const [focused, setFocused] = useState(false);
  return {
    focused,
    props: {
      onFocus: (event: FocusEvent<HTMLElement>) => {
        const target = event.target;
        if (target.classList.contains("drawer-pin") && !target.matches(":focus-visible")) return;
        setFocused(true);
      },
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      },
    },
  };
}

// One hover for both drawers, so they open and close together. It is followed
// on the whole page, not with mouseenter and mouseleave, because the pointer
// on the tooltip of a row in a drawer counts as on the drawers
// (drawerPointer), and leaving starts a delay instead of closing
// (createDrawerHover).
function useDrawersHover(drawers: RefObject<HTMLDivElement | null>[]) {
  const [hovered, setHovered] = useState(false);
  const hover = useRef<ReturnType<typeof createDrawerHover> | null>(null);
  const tooltip = useTooltip();
  useEffect(() => {
    const els = () => drawers.map((ref) => ref.current).filter((el): el is HTMLDivElement => !!el);
    const h = createDrawerHover({
      setTimer: (run, ms) => window.setTimeout(run, ms),
      clearTimer: (id) => window.clearTimeout(id),
      render: (next) => {
        setHovered(next);
        if (!next) els().forEach(releaseFocus);
      },
    });
    hover.current = h;
    const over = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      const anchor = tooltip.anchor();
      const zone = target instanceof Element ? target.closest(".drawer-pin-zone") : null;
      const next = drawerPointer({
        inDrawer: !!target && els().some((el) => el.contains(target)),
        onTip: onTip(target),
        tipAnchorInDrawer: !!anchor && els().some((el) => el.contains(anchor)),
        onPinZone: !!zone && els().some((el) => el.contains(zone)),
      });
      if (next === "keep") h.hold();
      else h.pointer(next === "on");
    };
    // Leaving the window: no pointerover follows.
    const out = (event: PointerEvent) => {
      if (!event.relatedTarget) h.pointer(false);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerout", out);
    return () => {
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerout", out);
      h.stop();
      hover.current = null;
    };
  }, [tooltip]);
  return {
    hovered,
    // After a pin was clicked: both drawers close unless pinned or holding
    // focus. The click focused the pin, so focus is released here every time,
    // not only when the hover changes.
    release: () => {
      hover.current?.release();
      drawers.forEach((ref) => ref.current && releaseFocus(ref.current));
    },
  };
}

function DrawerStrip({
  side,
  label,
  open,
  pinned,
  tip,
  onPin,
}: {
  side: "left" | "right";
  label: string;
  open: boolean;
  pinned: boolean;
  tip: string;
  onPin: () => void;
}) {
  // The button pins the drawer open, or un-pins it; the icon shows which.
  // The zone around it does not react to hover (drawerPointer).
  return (
    <div className={`drawer-strip is-${side}`}>
      <div className="drawer-pin-zone">
        <button type="button" className="drawer-pin" data-tip={tip} aria-label={tip} aria-pressed={pinned} aria-expanded={open} onClick={onPin}>
          {pinned ? <PinOff size={14} strokeWidth={2} /> : <Pin size={14} strokeWidth={2} />}
        </button>
      </div>
      <span className="drawer-label" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

const title = (w: OpenWorkflow) => w.parsed?.name || w.rawWorkflow.name || stem(w.file);

export function Present({
  lane,
  workflow,
  second,
  secondOptions,
  onSecond,
  linkTo,
  secondLinkTo,
  onOpenWorkflow,
  onOpenSecondWorkflow,
  library,
  show,
  onShow,
  hoveredArtifact,
  onHoverArtifact,
  leftPinned,
  rightPinned,
  onLeftPinned,
  onRightPinned,
}: {
  // The workflow list, shown in the left drawer.
  lane: ReactNode;
  workflow: OpenWorkflow | null;
  // The workflow shown next to it, and the ones the picker offers.
  second: OpenWorkflow | null;
  secondOptions: OpenWorkflow[];
  onSecond: (key: string | null) => void;
  // Where each diagram's workflow references lead; following one selects
  // that workflow and stays on Present. Each diagram has its own callback,
  // because a followed link records the project its diagram's names
  // resolved in, and the two diagrams can resolve in different projects.
  linkTo: (ref: string) => WorkflowLink;
  secondLinkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  onOpenSecondWorkflow: (key: string) => void;
  library: LibraryEntry[];
  show: FlowShow;
  onShow: (show: FlowShow) => void;
  // One hovered artifact for both diagrams, so a name lights up in each.
  hoveredArtifact: string | null;
  onHoverArtifact: (id: string | null) => void;
  leftPinned: boolean;
  rightPinned: boolean;
  onLeftPinned: (pinned: boolean) => void;
  onRightPinned: (pinned: boolean) => void;
}) {
  const leftRef = useRef<HTMLDivElement>(null);
  const rightRef = useRef<HTMLDivElement>(null);
  const left = useDrawerFocus();
  const right = useDrawerFocus();
  const { hovered, release } = useDrawersHover([leftRef, rightRef]);
  const leftOpen = drawerOpen({ pinned: leftPinned, hovered, focused: left.focused });
  const rightOpen = drawerOpen({ pinned: rightPinned, hovered, focused: right.focused });

  const header = (w: OpenWorkflow) => (
    <>
      <h1 className="present-title">{title(w)}</h1>
      {show.descriptions && workflowDescription(w) && <p className="present-description">{workflowDescription(w)}</p>}
    </>
  );
  const diagram = (
    w: OpenWorkflow,
    links: (ref: string) => WorkflowLink,
    open: (key: string) => void,
    isSecond: boolean,
  ) => (
    <Flow
      key={workflowKey(w)}
      steps={stepViews(w)}
      selectedIndex={-1}
      library={library}
      showPaths={false}
      showDescriptions
      show={show}
      hoveredArtifact={hoveredArtifact}
      onHoverArtifact={onHoverArtifact}
      readOnly
      inputs={workflowInputs(w)}
      handOffs={workflowHandOffs(w)}
      linkTo={links}
      onOpenWorkflow={open}
      scroll={false}
      header={header(w)}
      legend={!isSecond}
      className={isSecond ? "is-second" : undefined}
    />
  );

  return (
    <div className="screen is-present">
      <div
        ref={leftRef}
        className={`present-drawer is-left${leftOpen ? " is-open" : ""}`}
        {...left.props}
      >
        {lane}
        <DrawerStrip
          side="left"
          label="Workflows"
          open={leftOpen}
          pinned={leftPinned}
          tip={leftPinned ? "Unpin workflows" : "Keep workflows open"}
          onPin={() => {
            onLeftPinned(!leftPinned);
            release();
          }}
        />
      </div>
      <main className="present-main">
        {workflow ? (
          <div className={`present-scroll${second ? " has-second" : ""}`}>
            {diagram(workflow, linkTo, onOpenWorkflow, false)}
            {second && diagram(second, secondLinkTo, onOpenSecondWorkflow, true)}
          </div>
        ) : (
          <div className="center-empty">No workflow selected.</div>
        )}
      </main>
      <div
        ref={rightRef}
        className={`present-drawer is-right${rightOpen ? " is-open" : ""}`}
        {...right.props}
      >
        <DrawerStrip
          side="right"
          label="Show"
          open={rightOpen}
          pinned={rightPinned}
          tip={rightPinned ? "Unpin" : "Keep open"}
          onPin={() => {
            onRightPinned(!rightPinned);
            release();
          }}
        />
        <div className="show-panel">
          <div className="show-panel-head">
            <span className="show-panel-title">Show</span>
            <span className="show-panel-file">{workflow?.file ?? ""}</span>
          </div>
          <label className="compare-picker">
            <span className="compare-picker-kicker">Side by side with</span>
            <span className="compare-picker-field">
              <span className="compare-picker-value">{second ? pickerLabel(second) : "none"}</span>
              <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
                <path d="M6 9l6 6 6-6" />
              </svg>
              <select
                data-tip="Show a second workflow next to this one"
                value={second ? workflowKey(second) : ""}
                onChange={(event) => {
                  onSecond(event.target.value || null);
                  // The choice is made; the select must not hold the drawer open.
                  event.target.blur();
                }}
              >
                <option value="">none</option>
                {secondOptions.map((w) => (
                  <option key={workflowKey(w)} value={workflowKey(w)}>
                    {pickerLabel(w)}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <div className="show-toggles">
            {SHOW_TOGGLES.map(({ key, label }) => (
              <button
                key={key}
                type="button"
                role="checkbox"
                aria-checked={show[key]}
                className={`show-toggle${show[key] ? " is-on" : ""}`}
                onClick={() => onShow({ ...show, [key]: !show[key] })}
              >
                <span className="show-toggle-box" aria-hidden="true">
                  {show[key] ? "✓" : ""}
                </span>
                {label}
              </button>
            ))}
          </div>
          <div className="show-actions">
            <button type="button" onClick={() => onShow(ALL_SHOWN)}>
              Show all
            </button>
            <button type="button" onClick={() => onShow(STEPS_ONLY)}>
              Steps only
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
