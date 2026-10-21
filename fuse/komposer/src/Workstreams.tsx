// SPDX-License-Identifier: Apache-2.0
// The Workstreams page: the rail of projects and their workstreams on the
// right, filtered by the workflow selected in the left lane (or all of them),
// and the selected workstream in the middle, as a summary or as its
// workflow's diagram in the workstream's state.

import type { ProjectSummary, RunEvent, WorkstreamSummary } from "./api.ts";
import { dateTime, duration, projectName, RUN_STATE, runDuration, runState, type RunState } from "./runView.ts";
import {
  currentChildSlug,
  eventDetail,
  followsWorkflow,
  groupByProject,
  heldStep,
  lastStepEventTime,
  orphanSteps,
  sentBackFrom,
  stateOf,
  stepChildren,
  stepTiming,
  workstreamKey,
  workstreamLinks,
  workstreamProblem,
  workstreamStats,
} from "./model/workstreams.ts";
import type { WorkflowInput } from "../../flow/src/schemas/workflow.ts";
import type { HandOff } from "../../flow/src/schemas/workflow.ts";
import {
  gatesInRunOrder,
  stepViews,
  workflowHandOffs,
  workflowInputs,
  type OpenWorkflow,
  type StepView,
  type WorkflowLink,
} from "./workflowView.ts";
import type { UnavailableWorkflow } from "./model/workflowLinks.ts";
import { ProjectList, workflowStem } from "./ProjectList.tsx";
import { WorkflowLinkButton, WorkstreamLinkButton } from "./Links.tsx";
import { childSlug, delegationTip, GateKindLabel, GATE_STYLE, ModeBadge } from "./Flow.tsx";
import { useFolderState } from "./folders.ts";
import { Chevron } from "./WorkflowList.tsx";

// How long a step may sit IN_PROGRESS with no new event before the Steps
// table flags it as stale. Placeholder: fuse-flow has no notion yet of a
// step actually being stuck, so this is a guess at a sensible threshold.
const STALE_AFTER_MS = 4 * 60 * 60 * 1000;

export type WorkstreamView = "summary" | "diagram";

// A workflow file's name without .yml, as the rail names the selected workflow.
const fileStem = (file: string) => file.replace(/\.ya?ml$/, "");

export function Workstreams({
  workflows,
  workstreams,
  projects,
  projectsError,
  filter,
  selectedKey,
  onSelect,
  view,
  onView,
  onChanged,
  onMessage,
  linkTo,
  onOpenWorkflow,
  unavailable = [],
}: {
  workflows: OpenWorkflow[];
  workstreams: WorkstreamSummary[];
  projects: ProjectSummary[];
  projectsError?: string;
  // The workflow whose workstreams are shown, or null for all of them.
  filter: OpenWorkflow | null;
  selectedKey: string | null;
  // Selects a workstream; one that the current filter hides is passed too, so
  // the caller can change the filter to show it.
  onSelect: (workstream: WorkstreamSummary) => void;
  view: WorkstreamView;
  onView: (view: WorkstreamView) => void;
  onChanged: () => void;
  onMessage: (message: string) => void;
  // How the workflow references (workflow gates, hand-offs) of a workstream's
  // workflow resolve, and opening the workflow one leads to.
  linkTo: (workstream: WorkstreamSummary, from: OpenWorkflow) => (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  // The files the server could not read, so a workstream whose workflow is
  // one of them says why.
  unavailable?: UnavailableWorkflow[];
}) {
  const groups = groupByProject(projects, workstreams, filter ?? null);
  const workflowOf = (w: WorkstreamSummary) => workflows.find((f) => followsWorkflow(w, f)) ?? null;
  // fuse-flow reads the workflow file on disk, not a working copy.
  const problemOf = (w: WorkstreamSummary) => {
    const file = workflowOf(w);
    const unreadable = unavailable.find((u) => u.kind === "file" && u.path === w.workflowPath)?.reason;
    return workstreamProblem(w, file?.onDisk ? file.text : undefined, unreadable);
  };
  const rows = groups.flatMap((g) => g.rows.map((r) => r.workstream));
  const selected = rows.find((w) => workstreamKey(w) === selectedKey) ?? rows[0] ?? null;
  const openLinked = (from: WorkstreamSummary, slug: string) => {
    const target = workstreams.find((w) => w.project === from.project && w.slug === slug);
    if (target) onSelect(target);
  };
  return (
    <div className="ws-page">
      <div className="ws-detail-scroll">
        {selected ? (
          <Detail
            workstream={selected}
            workflow={workflowOf(selected)}
            problem={problemOf(selected)}
            all={workstreams}
            view={view}
            onView={onView}
            onOpenLinked={(slug) => openLinked(selected, slug)}
            linkTo={linkTo}
            onOpenWorkflow={onOpenWorkflow}
          />
        ) : (
          <div className="ws-none">Select a workstream</div>
        )}
      </div>
      <ProjectList
        title={filter ? fileStem(filter.file) : "All workstreams"}
        groups={groups}
        filtered={!!filter}
        filterFile={filter ? fileStem(filter.file) : ""}
        error={projectsError}
        selectedKey={selected ? workstreamKey(selected) : null}
        onSelect={onSelect}
        onChanged={onChanged}
        onMessage={onMessage}
        problemOf={problemOf}
      />
    </div>
  );
}

function StatePill({ state }: { state: RunState }) {
  const info = RUN_STATE[state];
  return <span className={`run-state-pill ${info.className}`}>{info.label}</span>;
}

function Detail({
  workstream,
  workflow,
  problem,
  all,
  view,
  onView,
  onOpenLinked,
  linkTo,
  onOpenWorkflow,
}: {
  workstream: WorkstreamSummary;
  workflow: OpenWorkflow | null;
  // Why fuse-flow cannot read the workstream.
  problem?: string;
  all: WorkstreamSummary[];
  view: WorkstreamView;
  onView: (view: WorkstreamView) => void;
  onOpenLinked: (slug: string) => void;
  linkTo: (workstream: WorkstreamSummary, from: OpenWorkflow) => (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
}) {
  const state = stateOf(workstream);
  const done = state === "COMPLETED";
  const links = workstreamLinks(workstream, all);
  const found = (slug: string) => all.some((w) => w.project === workstream.project && w.slug === slug);
  const steps = workflow ? stepViews(workflow) : [];
  const file = workflow?.file ?? (workstream.workflowPath ? `${workflowStem(workstream)}.yml` : (workstream.workflow ?? ""));
  return (
    <div className="ws-detail">
      <div className="ws-detail-head">
        <div className="ws-detail-title-row">
          <h1 className="ws-detail-title">{workstream.slug}</h1>
          {workstream.summary && <StatePill state={state} />}
          <span className="grow" />
          <div className="segmented ws-view-toggle" role="tablist">
            {(
              [
                ["diagram", "Diagram"],
                ["summary", "Summary"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                role="tab"
                aria-selected={view === id}
                className={`segmented-opt${view === id ? " is-active" : ""}`}
                onClick={() => onView(id)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <div className="ws-detail-meta">
          <span data-tip={workstream.workflowPath}>{file}</span>
          <span data-tip={workstream.project}>{projectName(workstream.project)}</span>
          {workstream.summary && (
            <span>
              started {dateTime(workstream.summary.started)} · {done ? "took" : "running for"} {duration(runDuration(workstream))}
            </span>
          )}
        </div>
        {links.length > 0 && (
          <div className="ws-detail-links">
            {links.map((link) => (
              <span key={`${link.label}-${link.slug}`}>
                {link.label}
                <WorkstreamLinkButton slug={link.slug} found={found(link.slug)} onOpen={onOpenLinked} />
              </span>
            ))}
          </div>
        )}
        {workflow?.location === "run" && (
          <span className="ws-detail-note">
            The workflow is {projectName(workstream.project)}'s own file; it opens read-only.
          </span>
        )}
        {problem && <span className="ws-detail-error">{problem}</span>}
        {!problem && heldStep(workstream) && (
          <span className="ws-detail-note">
            Step {heldStep(workstream)} has not been handed out yet. <code>fuse-flow start {workstream.slug}</code> hands it out,
            or says what holds it, such as a condition whose check the owner has to bind or skip.
          </span>
        )}
      </div>
      {view === "summary" ? (
        <Summary workstream={workstream} steps={steps} readable={!problem} found={found} onOpenLinked={onOpenLinked} />
      ) : (
        <WorkstreamDiagram
          workstream={workstream}
          found={found}
          onOpenLinked={onOpenLinked}
          steps={steps}
          readable={!problem}
          inputs={workflow ? workflowInputs(workflow) : []}
          handOffs={workflow ? workflowHandOffs(workflow) : []}
          linkTo={workflow ? linkTo(workstream, workflow) : notListed}
          onOpenWorkflow={onOpenWorkflow}
        />
      )}
    </div>
  );
}

function Summary({
  workstream,
  steps,
  readable,
  found,
  onOpenLinked,
}: {
  workstream: WorkstreamSummary;
  steps: StepView[];
  // Whether fuse-flow can read the workflow, so the steps it lacks are known.
  readable: boolean;
  found: (slug: string) => boolean;
  onOpenLinked: (slug: string) => void;
}) {
  const s = workstream.summary;
  const events = workstream.events ?? [];
  const inputs = Object.entries(workstream.inputs ?? {});
  const folders = useFolderState("komposer-ws-events");
  const key = workstreamKey(workstream);
  return (
    <>
      {s && (
      <div className="ws-stats">
        {workstreamStats(workstream).map((stat) => (
          <div key={stat.label} className="ws-stat">
            <span className="ws-kicker">{stat.label}</span>
            <span className="ws-stat-value" data-tip={stat.value}>
              {stat.value}
            </span>
          </div>
        ))}
      </div>
      )}
      {inputs.length > 0 && (
        <section className="ws-card">
          <div className="ws-card-head ws-kicker">Inputs</div>
          {inputs.map(([id, path]) => (
            <div key={id} className="ws-input-row">
              <span className="ws-input-id">{id}</span>
              <span className="ws-input-path">{path}</span>
            </div>
          ))}
        </section>
      )}
      <section className="ws-card">
        <div className="ws-card-head ws-kicker">Steps</div>
        {steps.map((step, i) => {
          const figures = s?.steps[step.id];
          const state = runState(figures?.status);
          const current = s?.currentStep === step.id && workstream.summary?.status !== "COMPLETED";
          const bits = stepTiming(figures);
          const lastUpdated = lastStepEventTime(events, step.id);
          const stale = state === "IN_PROGRESS" && isStale(lastUpdated);
          const stepEvents = events.filter((e) => e.step === step.id);
          const eventsKey = `events:${key}:${step.id}`;
          const open = folders.isOpen(eventsKey, step.id, false);
          return (
            <div key={step.id} className={`ws-step-block${stale ? " is-stale" : ""}`}>
              <div className={`ws-step-row${current ? ` is-current state-${RUN_STATE[state].className}` : ""}`}>
                <span className="ws-step-num">{i + 1}</span>
                <span className="ws-step-main">
                  <span className="ws-step-title">{step.title || step.id}</span>
                  {bits && <span className="ws-step-bits">{bits}</span>}
                </span>
                <span className="ws-step-updated" data-tip={lastUpdated ? dateTime(lastUpdated) : undefined}>
                  {lastUpdated ? dateTime(lastUpdated) : "—"}
                  {stale && (
                    <span className="ws-stale-flag" data-tip={`No new event in over ${duration(STALE_AFTER_MS)}; may be stuck`}>
                      stuck?
                    </span>
                  )}
                </span>
                <StatePill state={state} />
                <button
                  type="button"
                  className="ws-step-events-toggle lane-toggle"
                  aria-expanded={open}
                  disabled={stepEvents.length === 0}
                  onClick={() => folders.toggle(eventsKey, step.id, false)}
                  data-tip={stepEvents.length ? `${open ? "Hide" : "Show"} this step's events` : "No events for this step"}
                >
                  <Chevron open={open} />
                  {plural(stepEvents.length, "event")}
                </button>
              </div>
              {open && stepEvents.length > 0 && (
                <div className="ws-step-events">
                  {[...stepEvents].reverse().map((event, k) => (
                    <EventRow key={`${event.time}-${event.step}-${k}`} event={event} found={found} onOpenLinked={onOpenLinked} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
        {steps.length === 0 && <div className="ws-empty">The workflow's steps cannot be shown.</div>}
        {orphanSteps(workstream, steps.map((step) => step.id), readable).map((orphan) => (
          <div key={`gone-${orphan.id}`} className="ws-step-row is-gone">
            <span className="ws-step-num">–</span>
            <span className="ws-step-main">
              <span className="ws-step-title">{orphan.id}</span>
              <span className="ws-step-bits">{orphan.note}</span>
            </span>
            <StatePill state={orphan.status} />
          </div>
        ))}
      </section>
    </>
  );
}

// "1 event", "2 events".
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Whether a step's last event is old enough to flag as possibly stuck.
function isStale(lastUpdated: string | undefined, now = Date.now()): boolean {
  if (!lastUpdated) return false;
  const t = Date.parse(lastUpdated);
  return !Number.isNaN(t) && now - t > STALE_AFTER_MS;
}

// An event; the detail of a created child links to that child workstream.
function EventRow({
  event,
  found,
  onOpenLinked,
}: {
  event: RunEvent;
  found: (slug: string) => boolean;
  onOpenLinked: (slug: string) => void;
}) {
  const from = runState(event.from);
  const to = runState(event.to);
  const detail =
    event.kind === "child-created" && event.detail ? (
      <>
        created child workstream{" "}
        <WorkstreamLinkButton slug={event.detail} found={found(event.detail)} onOpen={onOpenLinked} />
      </>
    ) : (
      eventDetail(event)
    );
  return (
    <div className="ws-event">
      <time className="ws-event-time">{dateTime(event.time)}</time>
      <div className="ws-event-main">
        <div className="ws-event-change">
          <span className="ws-event-step">{event.step}</span>
          {event.from !== event.to && (
            <>
              <StatePill state={from} />
              <span className="ws-event-arrow">→</span>
            </>
          )}
          <StatePill state={to} />
          {event.actor && <span className="ws-event-actor">· {event.actor}</span>}
        </div>
        {detail && <span className="ws-event-detail">{detail}</span>}
      </div>
    </div>
  );
}

// Without its workflow the diagram has no steps, so nothing is resolved.
const notListed = (): WorkflowLink => ({ ok: false, reason: "the workstream's workflow is not listed" });

const STATE_ORDER: RunState[] = ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED", "COMPLETED", "SKIPPED"];

// The workflow as read-only cards in the workstream's state, below the
// workflow's inputs and the path each was given, and above the workflows it
// hands off to. A workflow gate and a hand-off open the workflow they lead
// to, and say so when it cannot be found.
function WorkstreamDiagram({
  workstream,
  found,
  onOpenLinked,
  steps,
  readable,
  inputs,
  handOffs,
  linkTo,
  onOpenWorkflow,
}: {
  workstream: WorkstreamSummary;
  found: (slug: string) => boolean;
  onOpenLinked: (slug: string) => void;
  steps: StepView[];
  // Whether fuse-flow can read the workflow, so the steps it lacks are known.
  readable: boolean;
  inputs: WorkflowInput[];
  handOffs: HandOff[];
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
}) {
  const s = workstream.summary;
  return (
    <div className="ws-diagram">
      <div className="ws-legend">
        {STATE_ORDER.map((state) => (
          <span key={state}>
            <i className={`ws-legend-box ${RUN_STATE[state].className}`} />
            {RUN_STATE[state].label}
          </span>
        ))}
      </div>
      {inputs.length > 0 && (
        <div className="flow-card workflow-inputs">
          <span className="flow-card-kicker">Inputs</span>
          {inputs.map((input) => {
            const given = workstream.inputs?.[input.artifact];
            return (
              <span
                key={input.artifact}
                className="chip chip-input"
                data-tip={[
                  `input ${input.artifact}, ${input.required ? "required" : "optional"}`,
                  input.description ?? "",
                  given ? `given: ${given}` : "not given",
                ]
                  .filter(Boolean)
                  .join("\n")}
              >
                {input.artifact}
                {!given && <span className="chip-nolib">not given</span>}
              </span>
            );
          })}
        </div>
      )}
      {steps.map((step, i) => {
        const figures = s?.steps[step.id];
        const state = runState(figures?.status);
        const info = RUN_STATE[state];
        const live = state !== "PENDING" && state !== "SKIPPED";
        const phaseHead = !!step.phase && (i === 0 || steps[i - 1].phase !== step.phase);
        const back = sentBackFrom(workstream, step.id);
        const bits = stepTiming(figures, " working");
        const delegation = step.gates.find((g) => g.kind === "workflow");
        const children = stepChildren(workstream, step.id, delegation && childSlug(delegation, step.id, workstream.slug));
        return (
          <div key={step.id} className="ws-diagram-item">
            {phaseHead && (
              <div className="phase-heading">
                <span className="phase-pill">{step.phase}</span>
                <span className="phase-line" />
              </div>
            )}
            {i > 0 && !phaseHead && <div className="ws-connector" />}
            <div
              className={`ws-step-card state-${info.className}${live ? " is-live" : ""}${state === "SKIPPED" || step.condition ? " is-dashed" : ""}`}
            >
              <div className="step-badge">{i + 1}</div>
              <div className="step-main">
                <div className="step-title-row">
                  <span className="step-title">{step.title || step.id}</span>
                  {step.title && <span className="step-id">{step.id}</span>}
                  <ModeBadge mode={step.mode} />
                </div>
                {step.condition && (
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
                {(step.consumes.length > 0 || step.artifacts.length > 0) && (
                  <div className="step-chips">
                    {step.consumes.map((id) => (
                      <span key={`in-${id}`} className="chip chip-consumes">
                        <span className="chip-arrow">←</span>
                        {id}
                      </span>
                    ))}
                    {step.artifacts.map((a, k) => (
                      <span key={`out-${a.artifact}-${k}`} className={`chip chip-produces role-${a.role}`} data-tip={a.path}>
                        {a.role === "updates" ? "~" : ""}
                        {a.artifact}
                        {a.role === "optional_produces" ? "?" : ""}
                      </span>
                    ))}
                  </div>
                )}
                {step.gates.length > 0 && (
                  <div className="step-gates">
                    {gatesInRunOrder(step.gates).map(({ gate }, k) => {
                      const style = GATE_STYLE[gate.kind];
                      if (gate.kind === "workflow") {
                        const link = linkTo(gate.text);
                        return (
                          <button
                            key={k}
                            type="button"
                            className={`gate-pill gate-pill-link${link.ok ? "" : " is-unresolved"}`}
                            data-tip={delegationTip(gate, link)}
                            aria-disabled={!link.ok}
                            style={{ background: style.bg, color: style.fg }}
                            onClick={() => link.ok && onOpenWorkflow(link.key)}
                          >
                            <GateKindLabel kind={gate.kind} />
                            <span className="gate-text">{gate.text}</span>
                            <span className="gate-extra">
                              {link.ok
                                ? `↳ ${currentChildSlug(workstream, step.id, childSlug(gate, step.id, workstream.slug))}`
                                : link.unavailable
                                  ? "unavailable"
                                  : "not found"}
                            </span>
                          </button>
                        );
                      }
                      return (
                        <span key={k} className="gate-pill" data-tip={gate.text} style={{ background: style.bg, color: style.fg }}>
                          <GateKindLabel kind={gate.kind} />
                          {gate.text && <span className="gate-text">{gate.text}</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
                {/* As fuse-flow status says it: while the step is handed out it
                    waits for its current child; otherwise its children are listed. */}
                {children && (
                  <div className="ws-step-children">
                    {children.waitsFor && (
                      <>
                        <span className="ws-link-label">waits for</span>
                        <WorkstreamLinkButton slug={children.waitsFor} found={found(children.waitsFor)} onOpen={onOpenLinked} />
                      </>
                    )}
                    {children.others.length > 0 && (
                      <>
                        <span className="ws-link-label">
                          {children.waitsFor ? "earlier passes" : children.others.length > 1 ? "children" : "child"}
                        </span>
                        {children.others.map((slug) => (
                          <WorkstreamLinkButton key={slug} slug={slug} found={found(slug)} onOpen={onOpenLinked} />
                        ))}
                      </>
                    )}
                  </div>
                )}
                {bits && <div className="ws-step-bits">{bits}</div>}
                {back.length > 0 && <div className="ws-sent-back">↩ sent back to {back.join(", ")}</div>}
              </div>
              <StatePill state={state} />
            </div>
          </div>
        );
      })}
      {orphanSteps(workstream, steps.map((step) => step.id), readable).map((orphan) => (
        <div key={`gone-${orphan.id}`} className="ws-diagram-item">
          <div className="ws-connector" />
          <div className={`ws-step-card state-${RUN_STATE[orphan.status].className} is-dashed`}>
            <div className="step-badge">–</div>
            <div className="step-main">
              <div className="step-title-row">
                <span className="step-title">{orphan.id}</span>
              </div>
              <div className="ws-step-bits">{orphan.note}</div>
            </div>
            <StatePill state={orphan.status} />
          </div>
        </div>
      ))}
      {handOffs.length > 0 && (
        <div className="flow-card handoff-box ws-handoffs">
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
      {steps.length === 0 && <div className="ws-empty">The workflow's steps cannot be shown.</div>}
    </div>
  );
}
