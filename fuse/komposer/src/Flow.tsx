// SPDX-License-Identifier: Apache-2.0
// The centre diagram: phase headings, step cards (number tile, title, id,
// condition row, description, artifact chips, gate pills, error line) and
// the SVG edge overlay.

import { useLayoutEffect, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import type { Gate } from "../../flow/src/schemas/gate.ts";
import type { HandOff, WorkflowInput } from "../../flow/src/schemas/workflow.ts";
import type { LibraryEntry, WorkstreamSummary } from "./api.ts";
import { duration, RUN_STATE, runState } from "./runView.ts";
import { ARTIFACT_DRAG, resolveLibrary } from "./api.ts";
import { gatesInRunOrder, type ArtifactRole, type StepView, type WorkflowLink } from "./workflowView.ts";
import { layoutEdges } from "./layout.ts";
import { RunLinkButton, WorkflowLinkButton } from "./Links.tsx";
import type { Problem } from "./validate.ts";
import type { StepCompare } from "./model/compare.ts";

type Rect = { t: number; b: number; l: number; r: number };

const FWD = "var(--text-faint)";
const SEL = "var(--accent)";
const BACK = "var(--tint-route-back)";
const BADGE_X = 24;

const GATE_STYLE: Record<Gate["kind"], { label: string; bg: string; fg: string }> = {
  workflow: { label: "workflow", bg: "var(--tint-link-bg)", fg: "var(--tint-link-text)" },
  check: { label: "check", bg: "var(--accent-soft)", fg: "var(--accent-text)" },
  script: { label: "script", bg: "var(--surface-sunken)", fg: "var(--text-strong)" },
  agent: { label: "agent", bg: "var(--tint-agent-bg)", fg: "var(--tint-agent-text)" },
  "owner-action": { label: "owner", bg: "var(--tint-warn-pill-bg)", fg: "var(--tint-warn-text)" },
};

// What a workflow gate does, for its pill's tooltip: the child's workflow,
// its slug, what it is given and what it returns.
function delegationTip(gate: Gate, link: WorkflowLink): string {
  const pairs = (map: Record<string, string> | undefined, arrow: string) =>
    Object.entries(map ?? {}).map(([a, b]) => (a === b ? a : `${a} ${arrow} ${b}`)).join(", ");
  return [
    `workflow: ${gate.text}`,
    link.ok ? `opens ${link.path}` : link.reason,
    `child slug: ${gate.slug ?? "{slug}-{step}"}`,
    gate.inputs && `gives: ${pairs(gate.inputs, "←")}`,
    gate.returns && `returns: ${pairs(gate.returns, "←")}`,
    gate.route_back_to.length ? `route back to: ${gate.route_back_to.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
const COMPARE_LABEL: Record<StepCompare["status"], string> = {
  same: "same",
  changed: "changed",
  "only-here": "only here",
};

const ROLE_PREFIX: Record<ArtifactRole, string> = { produces: "", optional_produces: "", updates: "~" };
const ROLE_SUFFIX: Record<ArtifactRole, string> = { produces: "", optional_produces: "?", updates: "" };

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
  run,
  readOnly = false,
  gateTextVisible = true,
  inputs,
  handOffs,
  linkTo,
  onOpenWorkflow,
  findRun,
  onOpenRun,
  compare,
  compareAction,
}: {
  steps: StepView[];
  selectedIndex: number;
  onSelect: (i: number) => void;
  problemsByStep: Map<number, Problem[]>;
  library: LibraryEntry[];
  showPaths: boolean;
  showDescriptions: boolean;
  hoveredArtifact: string | null;
  onHoverArtifact: (id: string | null) => void;
  onInsert: (at: number) => void;
  onMove: (from: number, to: number) => void;
  onDelete: (index: number) => void;
  onAppend: () => void;
  onDropArtifact: (step: number, artifact: string) => void;
  // A library entry dropped between steps, or on "Append step", becomes a new step at `at`.
  onDropArtifactAt: (at: number, artifact: string) => void;
  run?: WorkstreamSummary;
  // Another project's file, or compare mode: shown, never edited, with or without a run.
  // No insert, append, move or delete controls, and artifact drops are ignored.
  readOnly?: boolean;
  gateTextVisible?: boolean;
  // The documents the workflow expects from outside, and the workflows it hands off to.
  inputs: WorkflowInput[];
  handOffs: HandOff[];
  // Where a workflow reference leads, and opening a listed workflow by key.
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  // Any workstream by slug, and opening its run, for a step's child workstreams.
  findRun: (slug: string) => WorkstreamSummary | undefined;
  onOpenRun: (slug: string) => void;
  // Compare mode: how each step compares with the other workflow, by index.
  compare?: StepCompare[];
  // Compare mode: an action on each step that differs from the other side.
  compareAction?: { label: string; title: (id: string) => string; run: (index: number) => void };
}) {
  const locked = readOnly || !!run;
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
      onDropArtifactAt(at, artifact);
    },
  });
  const flowRef = useRef<HTMLDivElement>(null);
  const [geo, setGeo] = useState<Rect[]>([]);
  const layout = layoutEdges(steps);
  const maxCardWidth = 820;
  const leftPad = 24 + 8 * layout.leftLanes;
  const rightPad = 24 + 8 * layout.rightLanes;
  const flowMaxWidth = maxCardWidth + 48 + 8 * layout.leftLanes + 8 * layout.rightLanes;

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
  }, [steps]);

  return (
    <div className="diagram-scroll">
      <div className="diagram-inner" style={{ maxWidth: `${flowMaxWidth}px` }}>
        <div className="flow" ref={flowRef} style={{ padding: `0 ${rightPad}px 0 ${leftPad}px` }}>
          <Edges
            steps={steps}
            geo={geo}
            layout={layout}
            selectedIndex={selectedIndex}
            hoveredArtifact={hoveredArtifact}
            run={run}
          />
          {inputs.length > 0 && (
            <div className="workflow-inputs">
              <span className="link-label">inputs</span>
              {inputs.map((input) => (
                <span
                  key={input.artifact}
                  className={`chip chip-input${hoveredArtifact === input.artifact ? " is-hovered" : ""}`}
                  title={[
                    `input ${input.artifact}${input.required ? ", required" : ", optional"}`,
                    input.description ?? "",
                    run?.inputs?.[input.artifact] ? `given: ${run.inputs[input.artifact]}` : run ? "not given" : "",
                  ]
                    .filter(Boolean)
                    .join("\n")}
                  onMouseEnter={() => onHoverArtifact(input.artifact)}
                  onMouseLeave={() => onHoverArtifact(null)}
                >
                  {input.artifact}
                  {input.required && <span className="chip-required">required</span>}
                  {run && !run.inputs?.[input.artifact] && <span className="chip-nolib">not given</span>}
                </span>
              ))}
            </div>
          )}
          {steps.map((step, i) => (
            <div key={`${step.id}-${i}`}>
              {locked ? null : (
                <div
                  className={`step-seam${dropAt === i ? " is-drop-target" : ""}`}
                  onClick={() => onInsert(i)}
                  {...dropProps(i)}
                >
                  <span>{dropAt === i ? "+ new step" : "+ insert"}</span>
                </div>
              )}
              {step.phase && (i === 0 || steps[i - 1].phase !== step.phase) && (
                <div className="phase-heading">
                  <span className="phase-pill">{step.phase}</span>
                  <span className="phase-line" />
                </div>
              )}
              <StepCard
                step={step}
                num={i + 1}
                selected={i === selectedIndex}
                onSelect={() => onSelect(i)}
                problems={problemsByStep.get(i) ?? []}
                library={library}
                showPaths={showPaths}
                showDescriptions={showDescriptions}
                hoveredArtifact={hoveredArtifact}
                onHoverArtifact={onHoverArtifact}
                gateTextVisible={gateTextVisible}
                canMoveUp={i > 0}
                canMoveDown={i < steps.length - 1}
                onMoveUp={() => onMove(i, i - 1)}
                onMoveDown={() => onMove(i, i + 1)}
                onDelete={() => onDelete(i)}
                onDropArtifact={(artifact) => onDropArtifact(i, artifact)}
                runStep={run?.summary?.steps[step.id]}
                runMode={!!run}
                readOnly={readOnly}
                inputIds={inputs.map((input) => input.artifact)}
                linkTo={linkTo}
                onOpenWorkflow={onOpenWorkflow}
                runChildren={(run?.children ?? []).filter((child) => child.step === step.id)}
                findRun={findRun}
                onOpenRun={onOpenRun}
                compare={compare?.[i]}
                compareAction={
                  compareAction && compare?.[i] && compare[i].status !== "same"
                    ? { label: compareAction.label, title: compareAction.title(step.id), run: () => compareAction.run(i) }
                    : undefined
                }
              />
            </div>
          ))}
          {handOffs.length > 0 && (
            <div className="handoff">
              <div className="handoff-connector" style={{ marginLeft: `${BADGE_X - 1}px` }} />
              <div className="handoff-box">
                <span className="link-label">hands off to</span>
                {handOffs.map((handOff, k) => {
                  const link = linkTo(handOff.workflow);
                  return (
                    <div key={`${handOff.workflow}-${k}`} className="handoff-row">
                      <WorkflowLinkButton refText={handOff.workflow} link={link} onOpen={onOpenWorkflow} />
                      {handOff.when && <span className="handoff-when">{handOff.when}</span>}
                    </div>
                  );
                })}
                {run && (run.startedAfter?.length ?? 0) > 0 && (
                  <div className="handoff-row">
                    <span className="link-label">started after this run</span>
                    {run.startedAfter!.map((slug) => (
                      <RunLinkButton key={slug} slug={slug} run={findRun(slug)} onOpen={onOpenRun} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {!locked && (
          <button
            className={`append-step-btn${dropAt === steps.length ? " is-drop-target" : ""}`}
            onClick={onAppend}
            {...dropProps(steps.length)}
          >
            + Append step
          </button>
        )}
        <div className="flow-legend" style={{ margin: `18px ${rightPad}px 0 ${leftPad}px` }}>
          <span className="flow-legend-item">
            <span className="flow-legend-line" /> consumes
          </span>
          <span className="flow-legend-item flow-legend-back">
            <span className="flow-legend-line-dashed" /> route back
          </span>
          <span>~ updates</span>
          <span>id? may produce</span>
          <span>G T R guide · template · review</span>
          {(handOffs.length > 0 || steps.some((s) => s.gates.some((g) => g.kind === "workflow"))) && (
            <span className="flow-legend-link">↗ opens another workflow</span>
          )}
        </div>
      </div>
    </div>
  );
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
  hoveredArtifact,
  onHoverArtifact,
  gateTextVisible,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onDelete,
  onDropArtifact,
  runStep,
  runMode,
  readOnly,
  inputIds,
  linkTo,
  onOpenWorkflow,
  runChildren,
  findRun,
  onOpenRun,
  compare,
  compareAction,
}: {
  step: StepView;
  num: number;
  selected: boolean;
  onSelect: () => void;
  problems: Problem[];
  library: LibraryEntry[];
  showPaths: boolean;
  showDescriptions: boolean;
  hoveredArtifact: string | null;
  onHoverArtifact: (id: string | null) => void;
  gateTextVisible: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onDelete: () => void;
  onDropArtifact: (artifact: string) => void;
  runStep?: { status: string; activeMs: number; ownerWaitMs: number; visits: number; skipReason?: string };
  runMode: boolean;
  readOnly: boolean;
  inputIds: string[];
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  // The child workstreams of this step in the open run, oldest pass first.
  runChildren: { pass: number; slug: string }[];
  findRun: (slug: string) => WorkstreamSummary | undefined;
  onOpenRun: (slug: string) => void;
  compare?: StepCompare;
  compareAction?: { label: string; title: string; run: () => void };
}) {
  const locked = runMode || readOnly;
  const hasProblems = problems.length > 0;
  const badConsumes = new Set(
    problems.filter((p) => p.field === "consumes" && p.itemIndex !== undefined).map((p) => step.consumes[p.itemIndex!]),
  );
  const order = gatesInRunOrder(step.gates);
  const firstError = problems[0];
  const state = runStep ? runState(runStep.status) : undefined;
  const stateInfo = state ? RUN_STATE[state] : undefined;
  const runBits = runStep
    ? [
        runStep.activeMs ? duration(runStep.activeMs) : "",
        runStep.ownerWaitMs ? `owner ${duration(runStep.ownerWaitMs)}` : "",
        runStep.visits > 1 ? `×${runStep.visits} visits` : "",
        runStep.skipReason ?? "",
      ].filter(Boolean)
    : [];

  return (
    <div
      data-node={num}
      className={`step-card${step.condition ? " is-optional" : ""}${selected ? " is-selected" : ""}${hasProblems ? " has-problems" : ""}${stateInfo ? ` run-${stateInfo.className}` : ""}${compare ? ` compare-${compare.status}` : ""}`}
      onClick={onSelect}
      onDragOver={(event) => {
        if (!locked && event.dataTransfer.types.includes(ARTIFACT_DRAG)) event.preventDefault();
      }}
      onDrop={(event) => {
        const artifact = event.dataTransfer.getData(ARTIFACT_DRAG);
        if (artifact && !locked) {
          event.preventDefault();
          onDropArtifact(artifact);
        }
      }}
    >
      <div className={`step-badge${selected ? " is-selected" : ""}`}>{num}</div>
      <div className="step-main">
        <div className="step-title-row">
          <span className="step-title">{step.title || step.id}</span>
          {step.title && <span className="step-id">{step.id}</span>}
        </div>
        {step.condition && (
          <div className="step-condition" title={`${step.condition.kind}: ${step.condition.text}`}>
            <span className="step-condition-label">only if</span>
            <span
              className="step-condition-kind"
              style={{ background: GATE_STYLE[step.condition.kind].bg, color: GATE_STYLE[step.condition.kind].fg }}
            >
              {GATE_STYLE[step.condition.kind].label}
            </span>
            <span className="step-condition-text">{step.condition.text || "…"}</span>
          </div>
        )}
        {showDescriptions && step.description && <div className="step-description">{step.description}</div>}
        {(step.consumes.length > 0 || step.artifacts.length > 0) && (
          <div className="step-chips">
            {step.consumes.map((id) => {
              const bad = badConsumes.has(id);
              const hovered = hoveredArtifact === id;
              return (
                <span
                  key={id}
                  className={`chip chip-consumes${bad ? " is-bad" : ""}${hovered ? " is-hovered" : ""}`}
                  title={
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
                  title={`${{ produces: "produces", optional_produces: "may produce", updates: "updates" }[a.role]} · ${a.path}${
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
        {step.gates.length > 0 && (
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
                    title={delegationTip(gate, link)}
                    style={{ background: style.bg, color: style.fg }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (link.ok) onOpenWorkflow(link.key);
                    }}
                  >
                    <span className="gate-num">{k + 1}</span>
                    <span className="gate-kind">{style.label}</span>
                    <span className="gate-text">{gate.text}</span>
                    <span className="gate-extra">{link.ok ? "↗" : link.unavailable ? "unavailable" : "not found"}</span>
                    {gate.route_back_to.length > 0 && (
                      <span className="gate-route">↩ {gate.route_back_to.join(", ")}</span>
                    )}
                  </button>
                );
              }
              const extra = gate.kind === "agent" ? `×${gate.max_rounds ?? 2}${gate.guide ? " · guide" : ""}` : "";
              const tip = `${gate.kind}: ${gate.text}${gate.guide ? `\nguide: ${gate.guide}` : ""}${gate.route_back_to.length ? `\nroute back to: ${gate.route_back_to.join(", ")}` : ""}`;
              return (
                <span key={k} className="gate-pill" title={tip} style={{ background: style.bg, color: style.fg }}>
                  <span className="gate-num">{k + 1}</span>
                  <span className="gate-kind">{style.label}</span>
                  {gateTextVisible && gate.text && <span className="gate-text">{gate.text}</span>}
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
        {runChildren.length > 0 && (
          <div className="run-children" onClick={(event) => event.stopPropagation()}>
            <span className="link-label">{runChildren.length > 1 ? "waits for" : "child"}</span>
            <RunLinkButton slug={runChildren.at(-1)!.slug} run={findRun(runChildren.at(-1)!.slug)} onOpen={onOpenRun} />
            {runChildren.length > 1 && (
              <>
                <span className="link-label">earlier passes</span>
                {runChildren.slice(0, -1).map((child) => (
                  <RunLinkButton key={child.slug} slug={child.slug} run={findRun(child.slug)} onOpen={onOpenRun} />
                ))}
              </>
            )}
          </div>
        )}
        {compare?.status === "changed" && (
          <div className="compare-fields">differs in {compare.fields.join(", ")}</div>
        )}
        {runBits.length > 0 && (
          <div className="run-step-meta">
            {runBits.map((bit) => (
              <span key={bit}>{bit}</span>
            ))}
          </div>
        )}
      </div>
      {compare ? (
        <div className="compare-card-side" onClick={(event) => event.stopPropagation()}>
          <span className={`compare-pill compare-pill-${compare.status}`}>{COMPARE_LABEL[compare.status]}</span>
          {compareAction && (
            <button className="compare-copy-btn" title={compareAction.title} onClick={compareAction.run}>
              {compareAction.label}
            </button>
          )}
        </div>
      ) : readOnly ? null : runMode ? (
        <span className={`run-state-pill ${stateInfo?.className ?? "pending"}`}>
          {stateInfo?.label ?? "not started"}
        </span>
      ) : readOnly ? null : (
        <div className="step-actions" onClick={(event) => event.stopPropagation()}>
          <button title="Move up" disabled={!canMoveUp} onClick={onMoveUp}>
            <ArrowUp size={13} strokeWidth={1.75} />
          </button>
          <button title="Move down" disabled={!canMoveDown} onClick={onMoveDown}>
            <ArrowDown size={13} strokeWidth={1.75} />
          </button>
          <button title="Delete step" onClick={onDelete}>
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
  run,
}: {
  steps: StepView[];
  geo: Rect[];
  layout: ReturnType<typeof layoutEdges>;
  selectedIndex: number;
  hoveredArtifact: string | null;
  run?: WorkstreamSummary;
}) {
  if (geo.length !== steps.length || geo.length === 0) return null;
  const left = geo[0]?.l ?? 0;
  const right = geo[0]?.r ?? 0;

  return (
    <svg className="flow-svg">
      <defs>
        <marker
          id="kp-a"
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
          id="kp-s"
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
          id="kp-b"
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
            markerEnd="url(#kp-a)"
            style={{ stroke: FWD, strokeWidth: 1.25 }}
          />
        );
      })}
      {/* data-flow buses, left gutter */}
      {layout.buses.map((bus) => {
        const highlighted =
          hoveredArtifact === bus.artifact ||
          bus.producerIndex === selectedIndex ||
          bus.consumerIndices.includes(selectedIndex);
        const x = left - 14 - bus.lane * 8;
        const y0 = geo[bus.producerIndex].b - 14;
        const ys = bus.consumerIndices.map(
          (c) => geo[c].t + 15 + Math.min(Math.max(steps[c].consumes.indexOf(bus.artifact), 0), 3) * 5,
        );
        const color = highlighted ? SEL : FWD;
        const strokeWidth = highlighted ? 1.6 : 1;
        const marker = highlighted ? "url(#kp-s)" : "url(#kp-a)";
        return (
          <g key={`bus-${bus.artifact}`}>
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
      {layout.routes.map((route, k) => {
        const taken = !!run?.summary?.routesBack.some((back) => back.from === route.from && back.to === route.to);
        const highlighted = taken || selectedIndex === route.fromIndex || selectedIndex === route.toIndex;
        const x = right + 14 + route.lane * 8;
        const yOut = geo[route.fromIndex].b - 14;
        const yIn = geo[route.toIndex].t + 15;
        return (
          <path
            key={`route-${k}`}
            d={`M${right} ${yOut} H${x} V${yIn} H${right + 1}`}
            fill="none"
            markerEnd="url(#kp-b)"
            style={{
              stroke: BACK,
              strokeWidth: taken ? 2.25 : highlighted ? 1.6 : 1.1,
              strokeDasharray: taken ? "none" : "4 3",
              opacity: highlighted ? 1 : 0.7,
            }}
          />
        );
      })}
    </svg>
  );
}
