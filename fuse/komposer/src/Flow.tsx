// SPDX-License-Identifier: Apache-2.0
// The centre diagram: the workflow's inputs, phase headings, step cards
// (number tile, title, id, condition row, description, artifact chips, gate
// pills, error line), Append step, the workflows it hands off to, and the
// SVG edge overlay. Present shows it read-only: without selection, problem
// highlights or editing controls, with the element types its Show toggles
// leave, and next to a second diagram in one scroll area.

import { useId, useLayoutEffect, useRef, useState, type DragEvent, type ReactNode } from "react";
import { ArrowDown, ArrowUp, Bot, Cog, User, X, type LucideIcon } from "lucide-react";
import { DEFAULT_CHILD_SLUG, type Gate } from "../../flow/src/schemas/gate.ts";
import type { HandOff, WorkflowInput } from "../../flow/src/schemas/workflow.ts";
import type { LibraryEntry } from "./api.ts";
import { ARTIFACT_DRAG, resolveLibrary } from "./api.ts";
import { gatesInRunOrder, modeBadge, type ArtifactRole, type ModeGlyph, type StepView, type WorkflowLink } from "./workflowView.ts";
import { drawnBuses, layoutEdges } from "./layout.ts";
import { WorkflowLinkButton } from "./Links.tsx";
import type { Problem } from "./validate.ts";
import { ALL_SHOWN, legendEntries, type FlowShow } from "./model/present.ts";

type Rect = { t: number; b: number; l: number; r: number };

const FWD = "var(--text-faint)";
const SEL = "var(--accent)";
const BACK = "var(--sem-route-back)";
const BADGE_X = 24;

export const GATE_STYLE: Record<Gate["kind"], { label: string; bg: string; fg: string }> = {
  workflow: { label: "workflow", bg: "var(--surface-sunken)", fg: "var(--accent-text)" },
  check: { label: "check", bg: "var(--accent-soft)", fg: "var(--accent-text)" },
  script: { label: "script", bg: "var(--surface-sunken)", fg: "var(--text-strong)" },
  agent: { label: "agent", bg: "var(--sem-agent-bg)", fg: "var(--sem-agent-text)" },
  "owner-action": { label: "owner", bg: "var(--sem-amber-bg)", fg: "var(--sem-amber-text)" },
};

// The slug a workflow gate's child gets in its first pass, with the step
// filled in, and the parent workstream's slug when there is one.
export const childSlug = (gate: Gate, stepId: string, parent?: string) => {
  const withStep = (gate.slug ?? DEFAULT_CHILD_SLUG).replaceAll("{step}", stepId);
  return parent ? withStep.replaceAll("{slug}", parent) : withStep;
};

// What a workflow gate does, for its pill's tooltip: the child's workflow,
// its slug, what it is given and what it returns.
// A gate kind's glyph, in the gate's own colour: the owner, the agent, or a
// cog for the mechanical kinds. A workflow gate has none.
export const GATE_ICON: Record<Gate["kind"], LucideIcon | undefined> = {
  workflow: undefined,
  check: Cog,
  script: Cog,
  agent: Bot,
  "owner-action": User,
};

// A gate or condition kind as its pill shows it: the glyph, then the keyword.
export function GateKindLabel({ kind, className = "gate-kind" }: { kind: Gate["kind"]; className?: string }) {
  const Icon = GATE_ICON[kind];
  return (
    <span className={`${className} kind-label`.trim()}>
      {Icon && <Icon className="kind-icon" aria-hidden="true" />}
      {GATE_STYLE[kind].label}
    </span>
  );
}

// A step card's mode badge, on every page that draws step cards: one glyph
// segment per actor, coloured like that actor's gates, and no words; the
// tooltip explains the mode. An invalid mode is shown as written. Compare
// marks it changed when the other side's mode differs. Inside the Mode
// select, where the select's own text gives the word, it is decorative.
const MODE_KIND: Record<ModeGlyph, Gate["kind"]> = { owner: "owner-action", agent: "agent" };
export function ModeBadge({ mode, changed, decorative }: { mode: string | undefined; changed?: boolean; decorative?: boolean }) {
  const badge = modeBadge(mode);
  return (
    <span
      className={`step-mode${badge.glyphs.length ? "" : " is-invalid"}${changed ? " is-chg" : ""}`}
      {...(decorative ? { "aria-hidden": true } : { "data-tip": badge.title, role: "img", "aria-label": badge.title })}
    >
      {badge.glyphs.map((glyph) => {
        const Icon = GATE_ICON[MODE_KIND[glyph]]!;
        const style = GATE_STYLE[MODE_KIND[glyph]];
        return (
          <span key={glyph} className="step-mode-glyph" style={{ background: style.bg, color: style.fg }}>
            <Icon className="kind-icon" aria-hidden="true" />
          </span>
        );
      })}
      {badge.glyphs.length === 0 && badge.label}
    </span>
  );
}

export function delegationTip(gate: Gate, link: WorkflowLink): string {
  const pairs = (map: Record<string, string> | undefined, arrow: string) =>
    Object.entries(map ?? {}).map(([a, b]) => (a === b ? a : `${a} ${arrow} ${b}`)).join(", ");
  return [
    `workflow: ${gate.text}`,
    link.ok ? `opens ${link.path}` : link.reason,
    `child slug: ${gate.slug ?? DEFAULT_CHILD_SLUG}`,
    gate.inputs && `gives: ${pairs(gate.inputs, "←")}`,
    gate.returns && `returns: ${pairs(gate.returns, "←")}`,
    gate.route_back_to.length ? `route back to: ${gate.route_back_to.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const ROLE_PREFIX: Record<ArtifactRole, string> = { produces: "", optional_produces: "", updates: "~" };
const ROLE_SUFFIX: Record<ArtifactRole, string> = { produces: "", optional_produces: "?", updates: "" };
const NO_PROBLEMS = new Map<number, Problem[]>();

export function Flow({
  steps,
  selectedIndex,
  onSelect,
  problemsByStep,
  library,
  showPaths,
  showDescriptions,
  hoveredArtifact,
  onHoverArtifact,
  onInsert,
  onMove,
  onDelete,
  onAppend,
  onDropArtifact,
  onDropArtifactAt,
  readOnly,
  inputs,
  handOffs,
  linkTo,
  onOpenWorkflow,
  show = ALL_SHOWN,
  scroll = true,
  header,
  legend = true,
  className,
  consumesOnHover = false,
}: {
  steps: StepView[];
  selectedIndex: number;
  // Selecting a step by clicking its card. Without it, as on Present, a
  // card is not a control: no click, no pointer cursor, no select button.
  onSelect?: (i: number) => void;
  // Without it, as on Present, no step shows a problem.
  problemsByStep?: Map<number, Problem[]>;
  library: LibraryEntry[];
  showPaths: boolean;
  showDescriptions: boolean;
  hoveredArtifact: string | null;
  onHoverArtifact: (id: string | null) => void;
  // The editing actions; a read-only diagram needs none of them.
  onInsert?: (at: number) => void;
  onMove?: (from: number, to: number) => void;
  onDelete?: (index: number) => void;
  onAppend?: () => void;
  onDropArtifact?: (step: number, artifact: string) => void;
  // A library entry dropped between steps, or on "Append step", becomes a new step at `at`.
  onDropArtifactAt?: (at: number, artifact: string) => void;
  // Another project's own workflow, or Present: no insert seams (a 14px
  // gap instead), moves, deletes or Append step, and drops are ignored.
  readOnly: boolean;
  // The documents the workflow expects from outside, and the workflows it hands off to.
  inputs: WorkflowInput[];
  handOffs: HandOff[];
  // Where a workflow reference leads, and opening a listed workflow by key.
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  // The element types shown; everything unless given. The Inputs and
  // Hands-off cards always show. Hidden lines keep their gutters, so the
  // cards stay where they are.
  show?: FlowShow;
  // False renders the diagram without its own scroll area, for a page that
  // scrolls two diagrams together.
  scroll?: boolean;
  // Shown above the diagram, aligned with the card column.
  header?: ReactNode;
  // False leaves the legend out, as under Present's second diagram.
  legend?: boolean;
  // An extra class on the diagram's column.
  className?: string;
  // True draws only the hovered artifact's consumes lines, and none while
  // nothing is hovered. The edit page sets it; Present draws them all.
  consumesOnHover?: boolean;
}) {
  const [dropAt, setDropAt] = useState<number | null>(null);
  const dropProps = (at: number) => ({
    onDragOver: (event: DragEvent) => {
      if (!event.dataTransfer.types.includes(ARTIFACT_DRAG)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropAt(at);
    },
    onDragLeave: () => setDropAt((current) => (current === at ? null : current)),
    onDrop: (event: DragEvent) => {
      const artifact = event.dataTransfer.getData(ARTIFACT_DRAG);
      setDropAt(null);
      if (!artifact) return;
      event.preventDefault();
      event.stopPropagation();
      onDropArtifactAt?.(at, artifact);
    },
  });
  const flowRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Rect[]>([]);
  const layout = layoutEdges(steps);
  const maxCardWidth = 820;
  const leftPad = 24 + 8 * layout.leftLanes;
  const rightPad = 24 + 8 * layout.rightLanes;
  const flowMaxWidth = maxCardWidth + 48 + 8 * layout.leftLanes + 8 * layout.rightLanes;
  const legendShows = legendEntries(show);
  const hasLegend = legend && Object.values(legendShows).some(Boolean);
  // Toggles change card heights, so the edges are measured again after them.
  const shownKey = `${JSON.stringify(show)}|${showDescriptions}|${showPaths}`;

  useLayoutEffect(() => {
    const element = flowRef.current;
    if (!element) return;
    let key = "";
    const measure = () => {
      const box = element.getBoundingClientRect();
      const rects = Array.from(element.querySelectorAll("[data-node]")).map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          t: Math.round(rect.top - box.top),
          b: Math.round(rect.bottom - box.top),
          l: Math.round(rect.left - box.left),
          r: Math.round(rect.right - box.left),
        };
      });
      const next = JSON.stringify(rects);
      if (next !== key) {
        key = next;
        setGeo(rects);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [steps, shownKey]);

  const diagram = (
      <div className={`diagram-inner${className ? ` ${className}` : ""}`} style={{ maxWidth: `${flowMaxWidth}px` }}>
        {header && (
          <div className="flow-header" style={{ margin: `0 ${rightPad}px 18px ${leftPad}px` }}>
            {header}
          </div>
        )}
        <div className="flow" ref={flowRef} style={{ padding: `0 ${rightPad}px 0 ${leftPad}px` }}>
          <Edges
            steps={steps}
            geo={geo}
            layout={layout}
            selectedIndex={selectedIndex}
            hoveredArtifact={hoveredArtifact}
            show={show}
            onlyHovered={consumesOnHover}
          />
          {inputs.length > 0 && (
            <div className="flow-card workflow-inputs">
              <span className="flow-card-kicker">Inputs</span>
              {inputs.map((input) => (
                <span
                  key={input.artifact}
                  className={`chip chip-input${hoveredArtifact === input.artifact ? " is-hovered" : ""}`}
                  data-tip={[`input ${input.artifact}, ${input.required ? "required" : "optional"}`, input.description ?? ""]
                    .filter(Boolean)
                    .join("\n")}
                  onMouseEnter={() => onHoverArtifact(input.artifact)}
                  onMouseLeave={() => onHoverArtifact(null)}
                >
                  {input.artifact}
                  <span className={input.required ? "chip-required" : "chip-optional"}>
                    {input.required ? "required" : "optional"}
                  </span>
                </span>
              ))}
            </div>
          )}
          {steps.map((step, i) => (
            <div key={`${step.id}-${i}`}>
              {readOnly ? (
                <div className="step-gap" />
              ) : (
                <div
                  className={`step-seam${dropAt === i ? " is-drop-target" : ""}`}
                  onClick={() => onInsert?.(i)}
                  {...dropProps(i)}
                >
                  <span>{dropAt === i ? "+ new step" : "+ insert"}</span>
                </div>
              )}
              {show.phases && step.phase && (i === 0 || steps[i - 1].phase !== step.phase) && (
                <div className="phase-heading">
                  <span className="phase-pill">{step.phase}</span>
                  <span className="phase-line" />
                </div>
              )}
              <StepCard
                step={step}
                num={i + 1}
                selected={i === selectedIndex}
                onSelect={onSelect && (() => onSelect(i))}
                problems={(problemsByStep ?? NO_PROBLEMS).get(i) ?? []}
                library={library}
                showPaths={showPaths}
                showDescriptions={showDescriptions}
                show={show}
                hoveredArtifact={hoveredArtifact}
                onHoverArtifact={onHoverArtifact}
                canMoveUp={i > 0}
                canMoveDown={i < steps.length - 1}
                onMoveUp={() => onMove?.(i, i - 1)}
                onMoveDown={() => onMove?.(i, i + 1)}
                onDelete={() => onDelete?.(i)}
                onDropArtifact={(artifact) => onDropArtifact?.(i, artifact)}
                readOnly={readOnly}
                inputIds={inputs.map((input) => input.artifact)}
                linkTo={linkTo}
                onOpenWorkflow={onOpenWorkflow}
              />
            </div>
          ))}
        </div>
        {!readOnly && (
          <button
            className={`append-step-btn${dropAt === steps.length ? " is-drop-target" : ""}`}
            style={{ margin: `14px ${rightPad}px 0 ${leftPad}px` }}
            onClick={onAppend}
            {...dropProps(steps.length)}
          >
            + Append step
          </button>
        )}
        {handOffs.length > 0 && (
          <div className="flow-card handoff-box" style={{ margin: `14px ${rightPad}px 0 ${leftPad}px` }}>
            <span className="flow-card-kicker">Hands off to</span>
            {handOffs.map((handOff, k) => (
              <WorkflowLinkButton
                key={`${handOff.workflow}-${k}`}
                refText={handOff.workflow}
                link={linkTo(handOff.workflow)}
                onOpen={onOpenWorkflow}
                when={handOff.when}
              />
            ))}
          </div>
        )}
        {hasLegend && (
          <div className="flow-legend" style={{ margin: `18px ${rightPad}px 0 ${leftPad}px` }}>
            {legendShows.consumes && (
              <span className="flow-legend-item">
                <span className="flow-legend-line" /> consumes
              </span>
            )}
            {legendShows.routes && (
              <span className="flow-legend-item">
                <span className="flow-legend-line-dashed" /> route back
              </span>
            )}
            {legendShows.artifacts && (
              <>
                <span>~ updates</span>
                <span>id? may produce</span>
                <span>G T R guide · template · review</span>
              </>
            )}
            {legendShows.gates && <span>↳ child workflow</span>}
          </div>
        )}
      </div>
  );
  return scroll ? <div className="diagram-scroll">{diagram}</div> : diagram;
}

function StepCard({
  step,
  num,
  selected,
  onSelect,
  problems,
  library,
  showPaths,
  showDescriptions,
  show,
  hoveredArtifact,
  onHoverArtifact,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  onDropArtifact,
  readOnly,
  inputIds,
  linkTo,
  onOpenWorkflow,
}: {
  step: StepView;
  num: number;
  selected: boolean;
  onSelect?: () => void;
  problems: Problem[];
  library: LibraryEntry[];
  showPaths: boolean;
  showDescriptions: boolean;
  show: FlowShow;
  hoveredArtifact: string | null;
  onHoverArtifact: (id: string | null) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onDropArtifact: (artifact: string) => void;
  readOnly: boolean;
  inputIds: string[];
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
}) {
  const hasProblems = problems.length > 0;
  const badConsumes = new Set(
    problems.filter((p) => p.field === "consumes" && p.itemIndex !== undefined).map((p) => step.consumes[p.itemIndex!]),
  );
  const order = gatesInRunOrder(step.gates);
  const firstError = problems[0];

  return (
    <div
      data-node={num}
      className={`step-card${step.condition ? " is-optional" : ""}${selected ? " is-selected" : ""}${hasProblems ? " has-problems" : ""}${onSelect ? "" : " is-static"}`}
      onClick={onSelect}
      onDragOver={(event) => {
        if (!readOnly && event.dataTransfer.types.includes(ARTIFACT_DRAG)) event.preventDefault();
      }}
      onDrop={(event) => {
        const artifact = event.dataTransfer.getData(ARTIFACT_DRAG);
        if (artifact && !readOnly) {
          event.preventDefault();
          onDropArtifact(artifact);
        }
      }}
    >
      <div className={`step-badge${selected ? " is-selected" : ""}`}>{num}</div>
      <div className="step-main">
        <div className="step-title-row">
          {/* The card selects on click; this button is its keyboard control.
              Enter or Space clicks it, and the click reaches the card. */}
          {onSelect ? (
            <button
              type="button"
              className="step-title"
              aria-label={`Select step ${step.id}${step.title ? `: ${step.title}` : ""}`}
              aria-current={selected ? "true" : undefined}
            >
              {step.title || step.id}
            </button>
          ) : (
            <span className="step-title">{step.title || step.id}</span>
          )}
          {step.title && <span className="step-id">{step.id}</span>}
          <ModeBadge mode={step.mode} />
        </div>
        {show.conditions && step.condition && (
          <div className="step-condition" data-tip={`${step.condition.kind}: ${step.condition.text}`}>
            <span className="step-condition-label">only if</span>
            <span
              className="step-condition-kind"
              style={{ background: GATE_STYLE[step.condition.kind].bg, color: GATE_STYLE[step.condition.kind].fg }}
            >
              <GateKindLabel kind={step.condition.kind} className="" />
            </span>
            <span className="step-condition-text">{step.condition.text || "…"}</span>
          </div>
        )}
        {showDescriptions && show.descriptions && step.description && <div className="step-description">{step.description}</div>}
        {show.artifacts && (step.consumes.length > 0 || step.artifacts.length > 0) && (
          <div className="step-chips">
            {step.consumes.map((id) => {
              const bad = badConsumes.has(id);
              const hovered = hoveredArtifact === id;
              return (
                <span
                  key={id}
                  className={`chip chip-consumes${bad ? " is-bad" : ""}${hovered ? " is-hovered" : ""}`}
                  data-tip={
                    bad ? "Not produced by an earlier step" : inputIds.includes(id) ? `consumes ${id}, an input of the workflow` : `consumes ${id}`
                  }
                  onMouseEnter={() => onHoverArtifact(id)}
                  onMouseLeave={() => onHoverArtifact(null)}
                >
                  <span className="chip-arrow">←</span>
                  {id}
                </span>
              );
            })}
            {step.artifacts.map((a, idx) => {
              const entry = resolveLibrary(library, a.artifact);
              const hovered = hoveredArtifact === a.artifact;
              const label = `${a.artifact}${ROLE_SUFFIX[a.role]}`;
              return (
                <span
                  key={`${a.role}-${a.artifact}-${idx}`}
                  className={`chip chip-produces role-${a.role}${hovered ? " is-hovered" : ""}`}
                  data-tip={`${{ produces: "produces", optional_produces: "may produce", updates: "updates" }[a.role]} · ${a.path}${
                    entry ? ` · library: ${entry.level}` : " · no library entry"
                  }`}
                  onMouseEnter={() => onHoverArtifact(a.artifact)}
                  onMouseLeave={() => onHoverArtifact(null)}
                >
                  {ROLE_PREFIX[a.role] && <span className="chip-tilde">{ROLE_PREFIX[a.role]}</span>}
                  <span className="chip-id">{label}</span>
                  {showPaths && <span className="chip-path">{a.path}</span>}
                  {entry ? (
                    <span className="chip-gtr">
                      <span className={entry.g ? "lit" : "dim"}>G</span>
                      <span className={entry.t ? "lit" : "dim"}>T</span>
                      <span className={entry.r ? "lit" : "dim"}>R</span>
                    </span>
                  ) : (
                    <span className="chip-nolib">no guide</span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {show.gates && step.gates.length > 0 && (
          <div className="step-gates">
            {order.map(({ gate }, k) => {
              const style = GATE_STYLE[gate.kind];
              if (gate.kind === "workflow") {
                // A delegation: the pill links to the child's workflow.
                const link = linkTo(gate.text);
                return (
                  <button
                    key={k}
                    type="button"
                    className={`gate-pill gate-pill-link${link.ok ? "" : " is-unresolved"}`}
                    data-tip={delegationTip(gate, link)}
                    style={{ background: style.bg, color: style.fg }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (link.ok) onOpenWorkflow(link.key);
                    }}
                  >
                    <span className="gate-num">{k + 1}</span>
                    <GateKindLabel kind={gate.kind} />
                    <span className="gate-text">{gate.text}</span>
                    <span className="gate-extra">{link.ok ? `↳ ${childSlug(gate, step.id)}` : link.unavailable ? "unavailable" : "not found"}</span>
                    {gate.route_back_to.length > 0 && (
                      <span className="gate-route">↩ {gate.route_back_to.join(", ")}</span>
                    )}
                  </button>
                );
              }
              const extra = gate.kind === "agent" ? `×${gate.max_rounds ?? 2}${gate.guide ? " · guide" : ""}` : "";
              const tip = `${gate.kind}: ${gate.text}${gate.guide ? `\nguide: ${gate.guide}` : ""}${gate.route_back_to.length ? `\nroute back to: ${gate.route_back_to.join(", ")}` : ""}`;
              return (
                <span key={k} className="gate-pill" data-tip={tip} style={{ background: style.bg, color: style.fg }}>
                  <span className="gate-num">{k + 1}</span>
                  <GateKindLabel kind={gate.kind} />
                  {gate.text && <span className="gate-text">{gate.text}</span>}
                  {extra && <span className="gate-extra">{extra}</span>}
                  {gate.route_back_to.length > 0 && (
                    <span className="gate-route">↩ {gate.route_back_to.join(", ")}</span>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {hasProblems && (
          <div className="step-error">
            {firstError.message}
            {problems.length > 1 && `  +${problems.length - 1} more`}
          </div>
        )}
      </div>
      {readOnly ? (
        <span />
      ) : (
        <div className="step-actions" onClick={(event) => event.stopPropagation()}>
          <button data-tip="Move up" aria-label="Move up" disabled={!canMoveUp} onClick={onMoveUp}>
            <ArrowUp size={13} strokeWidth={1.75} />
          </button>
          <button data-tip="Move down" aria-label="Move down" disabled={!canMoveDown} onClick={onMoveDown}>
            <ArrowDown size={13} strokeWidth={1.75} />
          </button>
          <button data-tip="Delete step" aria-label="Delete step" onClick={onDelete}>
            <X size={15} strokeWidth={1.75} />
          </button>
        </div>
      )}
    </div>
  );
}

function Edges({
  steps,
  geo,
  layout,
  selectedIndex,
  hoveredArtifact,
  show,
  onlyHovered,
}: {
  steps: StepView[];
  geo: Rect[];
  layout: ReturnType<typeof layoutEdges>;
  selectedIndex: number;
  hoveredArtifact: string | null;
  show: FlowShow;
  onlyHovered: boolean;
}) {
  // Marker ids of this diagram, so two diagrams on a page do not share them.
  const id = useId().replace(/:/g, "");
  const arrow = `kp-a-${id}`,
    arrowSelected = `kp-s-${id}`,
    arrowBack = `kp-b-${id}`;
  if (geo.length !== steps.length || geo.length === 0) return null;
  const left = geo[0]?.l ?? 0;
  const right = geo[0]?.r ?? 0;

  return (
    <svg className="flow-svg">
      <defs>
        <marker
          id={arrow}
          viewBox="0 0 6 6"
          refX={5}
          refY={3}
          markerWidth={6}
          markerHeight={6}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0 L6 3 L0 6 z" style={{ fill: FWD }} />
        </marker>
        <marker
          id={arrowSelected}
          viewBox="0 0 6 6"
          refX={5}
          refY={3}
          markerWidth={6}
          markerHeight={6}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0 L6 3 L0 6 z" style={{ fill: SEL }} />
        </marker>
        <marker
          id={arrowBack}
          viewBox="0 0 6 6"
          refX={5}
          refY={3}
          markerWidth={6}
          markerHeight={6}
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0 L6 3 L0 6 z" style={{ fill: BACK }} />
        </marker>
      </defs>
      {/* sequence edges between consecutive cards */}
      {geo.slice(1).map((_, idx) => {
        const i = idx + 1;
        const x = geo[i - 1].l + BADGE_X;
        return (
          <path
            key={`seq-${i}`}
            d={`M${x} ${geo[i - 1].b} V${geo[i].t - 1}`}
            fill="none"
            markerEnd={`url(#${arrow})`}
            style={{ stroke: FWD, strokeWidth: 1.25 }}
          />
        );
      })}
      {/* data-flow buses, left gutter */}
      {show.consumes && drawnBuses(layout, { hoveredArtifact, selectedIndex, onlyHovered }).map(({ bus, highlighted }) => {
        const x = left - 14 - bus.lane * 8;
        const y0 = geo[bus.producerIndex].b - 14;
        const ys = bus.consumerIndices.map(
          (c) => geo[c].t + 15 + Math.min(Math.max(steps[c].consumes.indexOf(bus.artifact), 0), 3) * 5,
        );
        const color = highlighted ? SEL : FWD;
        const strokeWidth = highlighted ? 1.6 : 1;
        const marker = `url(#${highlighted ? arrowSelected : arrow})`;
        return (
          <g key={`bus-${bus.producerIndex}-${bus.artifact}`}>
            <path d={`M${left} ${y0} H${x} V${Math.max(...ys)}`} fill="none" style={{ stroke: color, strokeWidth }} />
            <circle cx={left} cy={y0} r={2.5} style={{ fill: color }} />
            {ys.map((y, k) => (
              <path
                key={k}
                d={`M${x} ${y} H${left - 1}`}
                fill="none"
                markerEnd={marker}
                style={{ stroke: color, strokeWidth }}
              />
            ))}
          </g>
        );
      })}
      {/* route-back edges, right gutter */}
      {show.routes && layout.routes.map((route, k) => {
        const highlighted = selectedIndex === route.fromIndex || selectedIndex === route.toIndex;
        const x = right + 14 + route.lane * 8;
        const yOut = geo[route.fromIndex].b - 14;
        const yIn = geo[route.toIndex].t + 15;
        return (
          <path
            key={`route-${k}`}
            d={`M${right} ${yOut} H${x} V${yIn} H${right + 1}`}
            fill="none"
            markerEnd={`url(#${arrowBack})`}
            style={{
              stroke: BACK,
              strokeWidth: highlighted ? 1.6 : 1.1,
              strokeDasharray: "4 3",
              opacity: highlighted ? 1 : 0.7,
            }}
          />
        );
      })}
    </svg>
  );
}
