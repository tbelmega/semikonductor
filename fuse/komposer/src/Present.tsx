// SPDX-License-Identifier: Apache-2.0
// The Present page: the selected workflow's diagram, read-only, under its
// name and description, optionally next to a second workflow in the same
// scroll area. The workflow list and the Show panel are drawers: a 20px
// strip on each side that slides its panel in over the diagram on hover,
// stays open while focus is inside it, and pins open with its arrow.

import { useState, type FocusEvent, type MouseEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { LibraryEntry } from "./api.ts";
import { Flow } from "./Flow.tsx";
import { pickerLabel } from "./Compare.tsx";
import { ALL_SHOWN, SHOW_TOGGLES, STEPS_ONLY, drawerOpen, releasesFocus, type FlowShow } from "./model/present.ts";
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
// sits on a hidden control.
function useDrawer(pinned: boolean) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return {
    open: drawerOpen({ pinned, hovered, focused }),
    // After the pin was clicked: the drawer closes unless focus holds it.
    unhover: (drawer: Element | null) => {
      setHovered(false);
      if (drawer) releaseFocus(drawer);
    },
    props: {
      onMouseEnter: () => setHovered(true),
      onMouseLeave: (event: MouseEvent<HTMLElement>) => {
        setHovered(false);
        releaseFocus(event.currentTarget);
      },
      onFocus: () => setFocused(true),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      },
    },
  };
}

function DrawerStrip({
  side,
  label,
  open,
  tip,
  onPin,
}: {
  side: "left" | "right";
  label: string;
  open: boolean;
  tip: string;
  onPin: (drawer: Element | null) => void;
}) {
  // The arrow points the way the panel moves when it is clicked.
  const rotate = side === "left" ? (open ? 180 : 0) : open ? 0 : 180;
  return (
    <div className={`drawer-strip is-${side}`}>
      <button type="button" className="drawer-pin" data-tip={tip} aria-label={tip} aria-expanded={open} onClick={(event) => onPin(event.currentTarget.closest(".present-drawer"))}>
        <ChevronRight size={14} strokeWidth={2} style={{ transform: `rotate(${rotate}deg)` }} />
      </button>
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
  const left = useDrawer(leftPinned);
  const right = useDrawer(rightPinned);

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
        className={`present-drawer is-left${left.open ? " is-open" : ""}`}
        {...left.props}
      >
        {lane}
        <DrawerStrip
          side="left"
          label="Workflows"
          open={left.open}
          tip={leftPinned ? "Collapse workflows" : "Keep workflows open"}
          onPin={(drawer) => {
            onLeftPinned(!leftPinned);
            left.unhover(drawer);
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
        className={`present-drawer is-right${right.open ? " is-open" : ""}`}
        {...right.props}
      >
        <DrawerStrip
          side="right"
          label="Show"
          open={right.open}
          tip={rightPinned ? "Collapse" : "Keep open"}
          onPin={(drawer) => {
            onRightPinned(!rightPinned);
            right.unhover(drawer);
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
                onChange={(event) => onSecond(event.target.value || null)}
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
