// SPDX-License-Identifier: Apache-2.0
// The Edit page's right rail: a strip of three buttons in scope order
// (Library, Workflow, Step) that is always shown, and the panel it opens
// between the diagram and the strip. The panel is closed until a button or a
// click on a step opens it.

import { useEffect, useState } from "react";
import YAML, { Scalar } from "yaml";
import { BookOpen, Captions, Plus, Settings2, X } from "lucide-react";
import type { FileRef, LibraryEntry, ReviewGuides, WorkstreamSummary } from "./api.ts";
import { dateTime, projectName, RUN_STATE, runState } from "./runView.ts";
import { ARTIFACT_DRAG, resolveLibrary, runKey, suggestPath } from "./api.ts";
import { winningEntry } from "./model/artifactInstruction.ts";
import { folderPrefixes, useFolderState } from "./folders.ts";
import { Chevron } from "./WorkflowList.tsx";
import { CHECK_KIND } from "../../flow/src/schemas/gate.ts";
import type { Edit, GateKind, OutputMode } from "./model/yamlEdit.ts";
import {
  delegationOf,
  gatesInRunOrder,
  INVALID_MODE,
  modeSelectValue,
  stepViews,
  workflowHandOffs,
  workflowInputs,
  workflowKey,
  type OpenWorkflow,
  type StepView,
  type WorkflowLink,
} from "./workflowView.ts";
import type { WorkflowInput } from "../../flow/src/schemas/workflow.ts";
import { DEFAULT_CHILD_SLUG, type Gate } from "../../flow/src/schemas/gate.ts";
import { WorkflowLinkButton } from "./Links.tsx";
import type { Problem } from "./validate.ts";
import { sectionsWithProblems, type StepSection } from "./model/stepSections.ts";
import { reviewInEffectRows } from "./model/reviewInEffect.ts";
import { DOCS, GATE_FIELD_DOCS, GATE_KIND_DOCS } from "./docs.ts";
import { FieldLabel, InfoTip } from "./InfoTip.tsx";
import { lineDiff, visibleDiff } from "./diff.ts";
import { plural } from "./model/workstreams.ts";

const LEVELS: LibraryEntry["level"][] = ["project", "user", "package"];
const LEVEL_LABEL: Record<LibraryEntry["level"], string> = { project: "Project", user: "Personal", package: "fuse-flow" };
const LEVEL_ROOT: Record<LibraryEntry["level"], string> = {
  project: ".konductor/library/artifacts/",
  user: "~/.konductor/library/artifacts/",
  package: "fuse-flow/library/artifacts/",
};
// An entry's place in its library, such as "writing/essay".
const entryPath = (entry: LibraryEntry) => (entry.group ? `${entry.group}/${entry.id}` : entry.id);

export type RailTab = "library" | "workflow" | "step";
export type WorkflowView = "form" | "yaml" | "changes";
const RAIL_TABS: { id: RailTab; label: string; icon: React.ReactNode }[] = [
  { id: "library", label: "Library", icon: <BookOpen size={18} strokeWidth={1.75} /> },
  { id: "workflow", label: "Workflow", icon: <Settings2 size={18} strokeWidth={1.75} /> },
  { id: "step", label: "Step", icon: <Captions size={18} strokeWidth={1.75} /> },
];
const TAB_TITLE: Record<RailTab, string> = { library: "Library", workflow: "Workflow", step: "Step" };

// The strip at the far right. Clicking the active button closes the panel;
// Step needs a selected step, and Library an editable workflow.
export function RailStrip({
  open,
  tab,
  stepEnabled,
  libraryEnabled,
  stepProblem,
  dirty,
  onPick,
}: {
  open: boolean;
  tab: RailTab;
  stepEnabled: boolean;
  libraryEnabled: boolean;
  // The selected step has a problem: a red dot on Step.
  stepProblem: boolean;
  // The working copy differs from the file: an accent dot on Workflow.
  dirty: boolean;
  // The tab to open, or null to close the panel.
  onPick: (tab: RailTab | null) => void;
}) {
  return (
    <nav className="rail-strip" aria-label="Detail panel">
      {RAIL_TABS.map(({ id, label, icon }) => {
        const disabled = id === "step" ? !stepEnabled : id === "library" ? !libraryEnabled : false;
        const active = open && tab === id;
        const tip = disabled
          ? id === "step"
            ? "Select a step in the diagram"
            : "Read-only workflow"
          : active
            ? `Close ${label} (Esc)`
            : `Open ${label}`;
        const dot = id === "step" ? stepProblem && stepEnabled : id === "workflow" ? dirty : false;
        return (
          <button
            key={id}
            type="button"
            className={`rail-strip-btn${active ? " is-active" : ""}`}
            title={tip}
            aria-pressed={active}
            aria-disabled={disabled}
            onClick={() => !disabled && onPick(active ? null : id)}
          >
            <span className="rail-strip-bar" />
            {icon}
            <span>{label}</span>
            {dot && <span className={`rail-strip-dot${id === "step" ? " is-problem" : ""}`} />}
          </button>
        );
      })}
    </nav>
  );
}

export function RailPanel({
  tab,
  workflowView,
  onWorkflowView,
  onTab,
  workflow,
  readOnly,
  steps,
  selectedIndex,
  problems,
  library,
  workstreams,
  root,
  diffBase,
  onEdit,
  onAddArtifact,
  reviewGuides,
  allWorkflows,
  onOpenWorkstream,
  linkTo,
  onOpenWorkflow,
  onOpenWorkflowStep,
  onClose,
}: {
  tab: RailTab;
  workflowView: WorkflowView;
  onWorkflowView: (view: WorkflowView) => void;
  onTab: (tab: RailTab) => void;
  workflow: OpenWorkflow;
  readOnly: boolean;
  steps: StepView[];
  selectedIndex: number | null;
  problems: Problem[];
  library: LibraryEntry[];
  workstreams: WorkstreamSummary[];
  // The project Komposer was started on.
  root: string;
  diffBase: string;
  onEdit: (edit: Edit) => void;
  // Adds an artifact to a step and pre-fills the step's instruction from the
  // library's description of the artifact.
  onAddArtifact: (step: number, mode: OutputMode, artifact: string, path?: string) => void;
  // The review guides of the open text's agent gates, from the server.
  reviewGuides: ReviewGuides | null;
  allWorkflows: OpenWorkflow[];
  // Shows a workstream of this workflow on the Workstreams page.
  onOpenWorkstream: (workstream: WorkstreamSummary) => void;
  // Where a workflow reference of the open workflow leads, and opening one.
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
  onOpenWorkflowStep: (workflowKey: string, stepIndex: number) => void;
  onClose: () => void;
}) {
  // The library entry a G T R badge asked to open; the counter re-opens the same id.
  const [libraryFocus, setLibraryFocus] = useState<{ id: string; n: number } | null>(null);
  const openLibraryEntry = (id: string) => {
    setLibraryFocus((current) => ({ id, n: (current?.n ?? 0) + 1 }));
    onTab("library");
  };
  // A guide file opened from a gate, shown over the panel.
  const [viewing, setViewing] = useState<{ title: string; file: FileRef; text?: string } | null>(null);
  useEffect(() => setViewing(null), [tab, workflow.path]);
  const selected = selectedIndex === null ? undefined : steps[selectedIndex];
  const stepLabel = selected ? `${selectedIndex! + 1} · ${selected.id}` : "";
  const subtitle =
    tab === "step" ? stepLabel : tab === "library" ? (selected ? `adds to ${stepLabel}` : "no step selected") : workflow.file;
  return (
    <aside className="rail-panel" aria-label={TAB_TITLE[tab]}>
      <div className="rail-panel-head">
        <span className="rail-panel-title">{TAB_TITLE[tab]}</span>
        <span className="rail-panel-sub">{subtitle}</span>
        <button type="button" className="rail-close" title="Close panel (Esc)" onClick={onClose}>
          <X size={14} /> Close
        </button>
      </div>
      {tab === "step" && (
        <div className="rail-panel-body is-step">
          {selected && selectedIndex !== null ? (
            <StepTab
              step={selected}
              steps={steps}
              selectedIndex={selectedIndex}
              problems={problems}
              library={library}
              text={workflow.openText}
              onEdit={onEdit}
              onAddArtifact={onAddArtifact}
              onLibrary={() => onTab("library")}
              onOpenLibraryEntry={openLibraryEntry}
              reviewGuides={reviewGuides}
              onViewFile={(title, file) => setViewing({ title, file, text: reviewGuides?.files[file.path] })}
              inputs={workflowInputs(workflow)}
              linkTo={linkTo}
              onOpenWorkflow={onOpenWorkflow}
            />
          ) : (
            <div className="inspector-empty">Select a step in the diagram.</div>
          )}
        </div>
      )}
      {tab === "workflow" && (
        <WorkflowTab
          workflow={workflow}
          readOnly={readOnly}
          view={readOnly ? "yaml" : workflowView}
          onView={onWorkflowView}
          diffBase={diffBase}
          workstreams={workstreams}
          root={root}
          onEdit={onEdit}
          onOpenWorkstream={onOpenWorkstream}
          linkTo={linkTo}
          onOpenWorkflow={onOpenWorkflow}
        />
      )}
      {tab === "library" && (
        <div className="rail-panel-body">
          <LibraryTab
            library={library}
            allWorkflows={allWorkflows}
            steps={steps}
            selectedIndex={selectedIndex}
            onAddArtifact={onAddArtifact}
            onOpenWorkflowStep={onOpenWorkflowStep}
            focus={libraryFocus}
          />
        </div>
      )}
      {viewing && <GuideViewer {...viewing} backTo={TAB_TITLE[tab]} onClose={() => setViewing(null)} />}
    </aside>
  );
}

function StepTab({
  step,
  steps,
  selectedIndex,
  problems,
  library,
  text,
  onEdit,
  onAddArtifact,
  onLibrary,
  onOpenLibraryEntry,
  reviewGuides,
  onViewFile,
  inputs,
  linkTo,
  onOpenWorkflow,
}: {
  step?: StepView;
  steps: StepView[];
  selectedIndex: number;
  problems: Problem[];
  library: LibraryEntry[];
  text: string;
  onEdit: (edit: Edit) => void;
  onAddArtifact: (step: number, mode: OutputMode, artifact: string, path?: string) => void;
  onLibrary: () => void;
  onOpenLibraryEntry: (id: string) => void;
  reviewGuides: ReviewGuides | null;
  onViewFile: (title: string, file: FileRef) => void;
  inputs: WorkflowInput[];
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
}) {
  const [expand, setExpand] = useState(false);
  const sections = useFolderState("komposer:step-sections");
  const [outputId, setOutputId] = useState("");
  const gateGuides = (fileIndex: number) =>
    reviewGuides?.gates.find((g) => g.step === selectedIndex && g.gate === fileIndex);
  if (!step) return <div className="inspector-empty">No step selected.</div>;
  const err = (field: Problem["field"]) =>
    problems
      .filter((p) => p.field === field)
      .map((p) => p.message)
      .join(" ");
  const phases = [...new Set(steps.map((s) => s.phase).filter((p): p is string => !!p))];
  // What the step may consume: the workflow's inputs, and what earlier steps
  // write or return from their child, as the engine allows.
  const available: { id: string; from: string }[] = inputs.map((input) => ({ id: input.artifact, from: "input" }));
  steps.slice(0, selectedIndex).forEach((s) =>
    [...s.artifacts.map((a) => a.artifact), ...Object.keys(delegationOf(s)?.returns ?? {})].forEach((id) => {
      if (!available.some((x) => x.id === id)) available.push({ id, from: s.id });
    }),
  );
  const gateOrder = gatesInRunOrder(step.gates);
  const differs = gateOrder.some((g, i) => g.fileIndex !== i);
  const style = instructionStyle(text, selectedIndex);
  const setStep = (key: "id" | "title" | "phase" | "mode" | "description", value: string) =>
    onEdit({ op: "setStepField", step: selectedIndex, key, value: value || null });
  const setCondition = (kind: GateKind, value: string, description?: string) =>
    onEdit({
      op: "setCondition",
      step: selectedIndex,
      condition: { kind, text: value, ...(description ? { description } : {}) },
    });

  const withProblem = sectionsWithProblems(problems);
  const section = (id: StepSection) => ({
    open: withProblem.has(id) || sections.isOpen(id, id, id === "instruction"),
    problem: withProblem.has(id),
    onToggle: () => sections.toggle(id, id, id === "instruction"),
  });
  const firstWords = (step.instruction ?? "").trim().split(/\s+/).slice(0, 8).join(" ");
  const gateKinds = gateOrder.map(({ gate }) => gate.kind).join(", ");

  return (
    <div className="inspector-section-stack">
      <StepSectionView
        title="Basics"
        summary={[step.title ?? step.id, step.phase, step.mode === "unattended" ? "unattended" : undefined].filter(Boolean).join(" · ")}
        {...section("basics")}
      >
        <div className="field-grid">
          <label className="field full-span">
            <FieldLabel label="Title" doc={DOCS.title} />
            <input
              className="field-input title-input"
              value={step.title ?? ""}
              placeholder={step.id}
              onChange={(e) => setStep("title", e.target.value)}
            />
          </label>
          <label className="field">
            <FieldLabel label="Id" doc={DOCS.id} />
            <input
              className="field-input mono-input"
              value={step.id}
              onChange={(e) => setStep("id", e.target.value)}
              data-error={!!err("id")}
            />
          </label>
          <label className="field">
            <FieldLabel label="Phase" doc={DOCS.phase} />
            <input
              className="field-input"
              list="kp-phases"
              value={step.phase ?? ""}
              onChange={(e) => setStep("phase", e.target.value)}
            />
            <datalist id="kp-phases">
              {phases.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </label>
          {err("id") && <div className="field-error full-span">{err("id")}</div>}
          <label className="field full-span">
            <FieldLabel label="Mode" doc={DOCS.mode} />
            {/* No mode is attended. An explicit "attended" shows as attended and
                stays as written until the author picks another value; any other
                value is shown as written, beside its error. */}
            <select
              className="field-input"
              value={modeSelectValue(step.mode)}
              onChange={(e) => e.target.value !== INVALID_MODE && setStep("mode", e.target.value)}
              data-error={!!err("mode")}
            >
              <option value="">attended (default)</option>
              <option value="unattended">unattended</option>
              {modeSelectValue(step.mode) === INVALID_MODE && (
                <option value={INVALID_MODE}>{step.mode === "" ? '""' : step.mode} (invalid)</option>
              )}
            </select>
          </label>
          {err("mode") && <div className="field-error full-span">{err("mode")}</div>}
          <label className="field full-span">
            <FieldLabel label="Description" doc={DOCS.description} />
            <input
              className="field-input"
              value={step.description ?? ""}
              onChange={(e) => setStep("description", e.target.value)}
            />
          </label>
        </div>
      </StepSectionView>

      <StepSectionView
        title="Instruction"
        summary={
          (step.condition ? `only if: ${step.condition.text || step.condition.kind} · ` : "") +
          (firstWords ? `${firstWords}…` : "empty")
        }
        {...section("instruction")}
      >

        <div className="field-block">
          <div className="field-block-head">
            <FieldLabel label="Instruction" doc={DOCS.instruction} />
            <span className="grow" />
            <select
              className="mode-select"
              value={style}
              onChange={(e) =>
                onEdit({
                  op: "setInstruction",
                  step: selectedIndex,
                  text: step.instruction ?? "",
                  style: e.target.value as ">" | "|",
                })
              }
            >
              <option value=">">&gt; folded</option>
              <option value="|">| literal</option>
            </select>
            <button className="text-button" onClick={() => setExpand(true)}>
              Expand
            </button>
          </div>
          <textarea
            className="field-textarea"
            rows={clampRows(step.instruction)}
            value={step.instruction ?? ""}
            onChange={(e) => onEdit({ op: "setInstruction", step: selectedIndex, text: e.target.value, style })}
            data-error={!!err("instr")}
          />
          {err("instr") && <div className="field-error">{err("instr")}</div>}
        </div>

        <div className="field-block">
          <div className="field-block-head">
            <FieldLabel label="Condition" doc={DOCS.condition} />
          </div>
          <div className="segmented">
            {(["none", "check", "script", "agent", "owner-action"] as const).map((kind) => (
              <button
                key={kind}
                className={`segmented-opt${(step.condition?.kind ?? "none") === kind ? " is-active" : ""}`}
                onClick={() =>
                  kind === "none"
                    ? onEdit({ op: "setCondition", step: selectedIndex, condition: null })
                    : setCondition(
                        kind,
                        kind === "check" ? "default" : (step.condition?.text ?? ""),
                        step.condition?.description,
                      )
                }
              >
                {kind === "owner-action" ? "owner" : kind}
              </button>
            ))}
          </div>
          {step.condition && (
            <>
              <input
                className="field-input"
                value={step.condition.text}
                placeholder={conditionPlaceholder(step.condition.kind)}
                onChange={(e) => setCondition(step.condition!.kind, e.target.value, step.condition!.description)}
                data-error={!!err("cond")}
              />
              <label className="mini-field">
                <span className="mini-label">
                  description <span className="field-tag is-optional">optional</span>
                  <InfoTip doc={GATE_FIELD_DOCS.gateDescription} />
                </span>
                <input
                  className="field-input"
                  value={step.condition.description ?? ""}
                  onChange={(e) => setCondition(step.condition!.kind, step.condition!.text, e.target.value)}
                />
              </label>
            </>
          )}
          {err("cond") && <div className="field-error">{err("cond")}</div>}
        </div>
      </StepSectionView>

      <StepSectionView
        title="Inputs and outputs"
        summary={`reads ${step.consumes.length} · writes ${step.artifacts.length}`}
        {...section("artifacts")}
      >

        <div className="field-block">
          <div className="field-block-head">
            <FieldLabel label="Consumes" doc={DOCS.consumes} />
          </div>
          <div className="pill-row">
            {available.map((a) => {
              const on = step.consumes.includes(a.id);
              return (
                <button
                  key={a.id}
                  className={`toggle-pill${on ? " is-on" : ""}`}
                  title={`from ${a.from}`}
                  onClick={() =>
                    onEdit({
                      op: "setConsumes",
                      step: selectedIndex,
                      ids: on
                        ? step.consumes.filter((id) => id !== a.id)
                        : [
                            ...step.consumes.filter((id) => available.some((v) => v.id === id)),
                            a.id,
                            ...step.consumes.filter((id) => !available.some((v) => v.id === id)),
                          ],
                    })
                  }
                >
                  {a.id} <small>{a.from}</small>
                </button>
              );
            })}
            {step.consumes
              .filter((id) => !available.some((a) => a.id === id))
              .map((id) => (
                <button
                  key={id}
                  className="toggle-pill is-bad"
                  onClick={() =>
                    onEdit({ op: "setConsumes", step: selectedIndex, ids: step.consumes.filter((x) => x !== id) })
                  }
                >
                  {id} × remove
                </button>
              ))}
          </div>
          {err("consumes") && <div className="field-error">{err("consumes")}</div>}
        </div>

        <div className="field-block">
          <div className="field-block-head">
            <FieldLabel label="Outputs" doc={DOCS.produces} />
            <span className="grow" />
            <button className="text-button" onClick={onLibrary}>
              Library
            </button>
          </div>
          <div className="output-rows">
            {step.artifacts.map((a, flatIndex) => {
              const index = step.artifacts.slice(0, flatIndex).filter((x) => x.role === a.role).length;
              const entry = resolveLibrary(library, a.artifact);
              const fieldErr = problems
                .filter((p) => p.field === "art" && p.itemIndex === flatIndex)
                .map((p) => p.message)
                .join(" ");
              return (
                <div key={`${a.role}-${index}`} className="output-row">
                  <div className="output-row-head">
                    <select
                      className="mode-select"
                      value={a.role}
                      onChange={(e) =>
                        onEdit({
                          op: "changeOutputMode",
                          step: selectedIndex,
                          mode: a.role,
                          index,
                          to: e.target.value as OutputMode,
                        })
                      }
                    >
                      <option value="produces">produces</option>
                      <option value="optional_produces">optional_produces</option>
                      <option value="updates">updates</option>
                    </select>
                    <InfoTip doc={DOCS[a.role]} />
                    <button
                      type="button"
                      className={`library-badge${entry ? "" : " is-missing"}`}
                      title={
                        entry
                          ? [
                              `Open ${a.artifact} in the library`,
                              ...Object.entries(winningEntry(library, a.artifact)?.links ?? {}).map(
                                ([name, link]) => `${name} is ${link.display}`,
                              ),
                            ].join("\n")
                          : `Search the library for ${a.artifact}`
                      }
                      onClick={() => onOpenLibraryEntry(a.artifact)}
                    >
                      {entry ? `${entry.g ? "G" : ""} ${entry.t ? "T" : ""} ${entry.r ? "R" : ""}` : "no guide"}
                    </button>
                    <button
                      className="icon-mini"
                      title="Remove output"
                      aria-label="Remove output"
                      onClick={() => onEdit({ op: "removeOutput", step: selectedIndex, mode: a.role, index })}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <label className="mini-field">
                    <span className="mini-label">
                      artifact <span className="field-tag is-required">required</span>
                      <InfoTip doc={DOCS.artifact} />
                    </span>
                    <input
                      className="field-input mono-input"
                      list="kp-library"
                      value={a.artifact}
                      onChange={(e) =>
                        onEdit({
                          op: "setOutput",
                          step: selectedIndex,
                          mode: a.role,
                          index,
                          fields: { artifact: e.target.value },
                        })
                      }
                      data-error={!!fieldErr}
                    />
                  </label>
                  <label className="mini-field">
                    <span className="mini-label">
                      path <span className="field-tag is-required">required</span>
                      <InfoTip doc={DOCS.path} />
                    </span>
                    <input
                      className="field-input"
                      value={a.path}
                      onChange={(e) =>
                        onEdit({
                          op: "setOutput",
                          step: selectedIndex,
                          mode: a.role,
                          index,
                          fields: { path: e.target.value },
                        })
                      }
                    />
                  </label>
                  <label className="mini-field">
                    <span className="mini-label">
                      description <span className="field-tag is-optional">optional</span>
                      <InfoTip doc={DOCS.artDescription} />
                    </span>
                    <input
                      className="field-input"
                      value={a.description ?? ""}
                      onChange={(e) =>
                        onEdit({
                          op: "setOutput",
                          step: selectedIndex,
                          mode: a.role,
                          index,
                          fields: { description: e.target.value || null },
                        })
                      }
                    />
                  </label>
                  {fieldErr && <div className="field-error">{fieldErr}</div>}
                </div>
              );
            })}
            <datalist id="kp-library">
              {[...new Set(library.map((e) => e.id))].map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <div className="add-row">
              <input
                className="field-input mono-input"
                list="kp-library"
                placeholder="artifact id"
                value={outputId}
                onChange={(e) => setOutputId(e.target.value)}
              />
              <button
                className="add-button"
                onClick={() => {
                  const id = outputId.trim();
                  if (!id) return;
                  onAddArtifact(selectedIndex, "produces", id);
                  setOutputId("");
                }}
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </div>

      </StepSectionView>

      <StepSectionView
        title="Gates"
        summary={gateKinds || "none"}
        {...section("gates")}
      >
        <div className="field-block">
          <div className="field-block-head">
            <FieldLabel label="Gates" doc={DOCS.gates} />
            {differs && <span className="run-order-note">shown in run order; file order differs</span>}
          </div>
          <div className="gate-rows">
            {gateOrder.map(({ gate, fileIndex }, orderIndex) => {
              const gateProblems = problems.filter((p) => p.field === "gate" && p.itemIndex === fileIndex);
              const gateTextErr = gateProblems
                .filter((p) => p.subfield === "text" || !p.subfield)
                .map((p) => p.message)
                .join(" ");
              const routeErr = gateProblems
                .filter((p) => p.subfield === "route")
                .map((p) => p.message)
                .join(" ");
              const maxRoundsErr = gateProblems
                .filter((p) => p.subfield === "maxRounds")
                .map((p) => p.message)
                .join(" ");
              const remainingErr = gateProblems
                .filter((p) => p.subfield !== "route")
                .map((p) => p.message)
                .join(" ");
              return (
                <div key={fileIndex} className="gate-row">
                  <div className="gate-row-head">
                    <span className="gate-row-num">{orderIndex + 1}</span>
                    <select
                      className="kind-select"
                      value={gate.kind}
                      onChange={(e) => {
                        const kind = e.target.value as GateKind;
                        onEdit({
                          op: "setGate",
                          step: selectedIndex,
                          index: fileIndex,
                          fields: {
                            kind,
                            ...(kind === "check" && !CHECK_KIND.test(gate.text) ? { text: "default" } : {}),
                          },
                        });
                      }}
                    >
                      <option value="check">check</option>
                      <option value="script">script</option>
                      <option value="agent">agent</option>
                      <option value="owner-action">owner-action</option>
                      <option value="workflow" disabled={gate.kind !== "workflow" && !!delegationOf(step)}>
                        workflow
                      </option>
                    </select>
                    <span className="grow" />
                    <button
                      className="icon-mini"
                      title="Remove gate"
                      aria-label="Remove gate"
                      onClick={() => onEdit({ op: "removeGate", step: selectedIndex, index: fileIndex })}
                    >
                      <X size={14} />
                    </button>
                  </div>
                  <label className="mini-field">
                    <span className="mini-label">
                      {gateTextLabel(gate.kind)} <span className="field-tag is-required">required</span>
                      <InfoTip doc={GATE_KIND_DOCS[gate.kind]} />
                    </span>
                    <input
                      className="field-input"
                      value={gate.text}
                      onChange={(e) =>
                        onEdit({ op: "setGate", step: selectedIndex, index: fileIndex, fields: { text: e.target.value } })
                      }
                      data-error={!!gateTextErr}
                    />
                  </label>
                  {gate.kind === "agent" && (
                    <div className="field-grid">
                      <label className="mini-field">
                        <span className="mini-label">
                          max_rounds <FieldLabel label="" doc={GATE_FIELD_DOCS.maxRounds} />
                        </span>
                        <input
                          className="field-input"
                          type="number"
                          min={1}
                          placeholder="2"
                          value={gate.max_rounds ?? ""}
                          data-error={!!maxRoundsErr}
                          onChange={(e) =>
                            onEdit({
                              op: "setGate",
                              step: selectedIndex,
                              index: fileIndex,
                              fields: { max_rounds: e.target.value ? Number(e.target.value) : null },
                            })
                          }
                        />
                      </label>
                      <label className="mini-field">
                        <span className="mini-label">
                          guide <FieldLabel label="" doc={GATE_FIELD_DOCS.guide} />
                        </span>
                        <span className="input-with-button">
                          <input
                            className="field-input"
                            value={gate.guide ?? ""}
                            onChange={(e) =>
                              onEdit({
                                op: "setGate",
                                step: selectedIndex,
                                index: fileIndex,
                                fields: { guide: e.target.value || null },
                              })
                            }
                          />
                          {gateGuides(fileIndex)?.gateGuide && (
                            <GateGuideButton guide={gateGuides(fileIndex)!.gateGuide!} onView={(file) => onViewFile("Gate guide", file)} />
                          )}
                        </span>
                      </label>
                    </div>
                  )}
                  {gate.kind === "agent" && gateGuides(fileIndex) && (
                    <ReviewInEffect gate={gateGuides(fileIndex)!} onViewFile={onViewFile} />
                  )}
                  {gate.kind === "workflow" && (
                    <DelegationFields
                      gate={gate}
                      stepId={step.id}
                      link={linkTo(gate.text)}
                      onSet={(fields) => onEdit({ op: "setGate", step: selectedIndex, index: fileIndex, fields })}
                      onOpenWorkflow={onOpenWorkflow}
                    />
                  )}
                  <label className="mini-field">
                    <span className="mini-label">
                      route_back_to <FieldLabel label="" doc={GATE_FIELD_DOCS.routeBack} />
                    </span>
                    <div className="pill-row route-pills" data-error={!!routeErr}>
                      {steps.slice(0, selectedIndex + 1).map((s, i) => {
                        const on = gate.route_back_to.includes(s.id);
                        return (
                          <button
                            key={s.id}
                            className={`toggle-pill${on ? " is-on" : ""}`}
                            onClick={() =>
                              onEdit({
                                op: "setGate",
                                step: selectedIndex,
                                index: fileIndex,
                                fields: {
                                  route_back_to: on
                                    ? gate.route_back_to.filter((id) => id !== s.id)
                                    : [...gate.route_back_to, s.id],
                                },
                              })
                            }
                          >
                            {s.id}
                            {i === selectedIndex ? " (this)" : ""}
                          </button>
                        );
                      })}
                      {gate.route_back_to
                        .filter((target) => !steps.slice(0, selectedIndex + 1).some((step) => step.id === target))
                        .map((target) => (
                          <button
                            key={target}
                            className="toggle-pill is-bad"
                            onClick={() =>
                              onEdit({
                                op: "setGate",
                                step: selectedIndex,
                                index: fileIndex,
                                fields: { route_back_to: gate.route_back_to.filter((id) => id !== target) },
                              })
                            }
                          >
                            {target} × remove
                          </button>
                        ))}
                    </div>
                    {routeErr && <span className="field-error">{routeErr}</span>}
                  </label>
                  <label className="mini-field">
                    <span className="mini-label">
                      description <span className="field-tag is-optional">optional</span>
                      <InfoTip doc={GATE_FIELD_DOCS.gateDescription} />
                    </span>
                    <input
                      className="field-input"
                      value={gate.description ?? ""}
                      onChange={(e) =>
                        onEdit({
                          op: "setGate",
                          step: selectedIndex,
                          index: fileIndex,
                          fields: { description: e.target.value || null },
                        })
                      }
                    />
                  </label>
                  {remainingErr && <div className="field-error">{remainingErr}</div>}
                </div>
              );
            })}
            <div className="gate-adds">
              {(["check", "script", "agent", "owner-action", "workflow"] as GateKind[])
                .filter((kind) => kind !== "workflow" || !delegationOf(step))
                .map((kind) => (
                <button
                  key={kind}
                  onClick={() =>
                    onEdit({
                      op: "addGate",
                      step: selectedIndex,
                      gate: { kind, text: kind === "check" ? "default" : "" },
                    })
                  }
                >
                  + {kind}
                </button>
              ))}
            </div>
          </div>
        </div>
      </StepSectionView>
      {expand && (
        <div className="modal-backdrop">
          <div className="expand-modal">
            <div className="modal-title-row">
              <h2>Instruction</h2>
              <button className="icon-mini" title="Close" aria-label="Close" onClick={() => setExpand(false)}>
                <X />
              </button>
            </div>
            <textarea
              autoFocus
              value={step.instruction ?? ""}
              onChange={(e) => onEdit({ op: "setInstruction", step: selectedIndex, text: e.target.value, style })}
            />
            <div className="expand-meta">
              {(step.instruction ?? "").trim().split(/\s+/).filter(Boolean).length} words ·{" "}
              {(step.instruction ?? "").split(/\n\s*\n/).filter(Boolean).length} paragraphs{" "}
              <button className="primary-button" onClick={() => setExpand(false)}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// The step tab's four collapsible sections. Instruction is open by default;
// the user's choice is kept in localStorage, and a section with a problem is
// always open.

function StepSectionView({
  title,
  summary,
  open,
  problem,
  onToggle,
  children,
}: {
  title: string;
  summary: string;
  open: boolean;
  problem: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section className={`step-section${open ? " is-open" : ""}`}>
      <button type="button" className="step-section-head" aria-expanded={open} onClick={onToggle} disabled={problem}>
        <Chevron open={open} />
        <span className="step-section-title">{title}</span>
        {problem && <span className="step-section-problem" title="This section has a problem" />}
        {!open && <span className="step-section-summary">{summary}</span>}
      </button>
      {open && <div className="step-section-body">{children}</div>}
    </section>
  );
}


// The Workflow tab: the workflow's form, its file, and its changes against
// the original (or the disk version when the file changed underneath). A
// read-only workflow shows only its file.
function WorkflowTab({
  workflow,
  readOnly,
  view,
  onView,
  diffBase,
  workstreams,
  root,
  onEdit,
  onOpenWorkstream,
  linkTo,
  onOpenWorkflow,
}: {
  workflow: OpenWorkflow;
  readOnly: boolean;
  view: WorkflowView;
  onView: (view: WorkflowView) => void;
  diffBase: string;
  workstreams: WorkstreamSummary[];
  root: string;
  onEdit: (edit: Edit) => void;
  onOpenWorkstream: (workstream: WorkstreamSummary) => void;
  linkTo: (ref: string) => WorkflowLink;
  onOpenWorkflow: (key: string) => void;
}) {
  const changed = lineDiff(diffBase, workflow.openText).filter((l) => l.kind !== " ").length;
  const name = workflow.parsed?.name ?? workflow.rawWorkflow.name;
  const description = workflow.parsed?.description ?? workflow.rawWorkflow.description ?? "";
  const inputs = workflowInputs(workflow);
  const handOffs = workflowHandOffs(workflow);
  const own = workstreams.filter((w) => w.workflowPath === workflow.path);
  return (
    <>
      {!readOnly && (
        <div className="rail-panel-tools">
          <div className="segmented rail-segmented">
            {(
              [
                ["form", "Form"],
                ["yaml", "YAML"],
                ["changes", `Changes · ${changed}`],
              ] as const
            ).map(([id, label]) => (
              <button key={id} className={`segmented-opt${view === id ? " is-active" : ""}`} onClick={() => onView(id)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {view === "yaml" && <pre className="rail-file">{workflow.openText}</pre>}
      {view === "changes" && (
        <div className="rail-file rail-diff">
          {visibleDiff(lineDiff(diffBase, workflow.openText)).map((line, i) => (
            <div
              key={i}
              className={`diff-${line.kind === "…" ? "skip" : line.kind === "+" ? "add" : line.kind === "-" ? "remove" : "same"}`}
            >
              <span className="diff-mark">{line.kind === " " || line.kind === "…" ? "" : line.kind}</span>
              <span className="diff-text">{line.text}</span>
            </div>
          ))}
          {changed === 0 && <div className="inspector-empty rail-diff-none">No changes.</div>}
        </div>
      )}
      {view === "form" && (
        <div className="rail-panel-body">
          <div className="inspector-section-stack">
            <label className="field">
              <FieldLabel label="Name" doc={DOCS.wfName} />
              <input
                className="field-input mono-input"
                value={name}
                onChange={(e) => onEdit({ op: "setWorkflowField", key: "name", value: e.target.value })}
              />
            </label>
            <label className="field">
              <FieldLabel label="Description" doc={DOCS.wfDescription} />
              <textarea
                className="field-textarea"
                rows={4}
                value={description}
                onChange={(e) => onEdit({ op: "setWorkflowField", key: "description", value: e.target.value || null })}
              />
            </label>
            <div className="field-block">
              <span className="field-label-row">
                Inputs · {inputs.length} <InfoTip doc={DOCS.wfInputs} />
              </span>
              {inputs.map((input) => (
                <div key={input.artifact} className="rail-box-row">
                  <span className="mono rail-box-id">{input.artifact}</span>
                  <span className={`field-tag ${input.required ? "is-required" : "is-optional"}`}>
                    {input.required ? "required" : "optional"}
                  </span>
                  {input.description && <span className="rail-box-text">{input.description}</span>}
                </div>
              ))}
              {inputs.length === 0 && <span className="rail-none">none</span>}
            </div>
            <div className="field-block">
              <span className="field-label-row">
                Hands off to · {handOffs.length} <InfoTip doc={DOCS.wfHandsOffTo} />
              </span>
              {handOffs.map((handOff, k) => (
                <WorkflowLinkButton
                  key={`${handOff.workflow}-${k}`}
                  refText={handOff.workflow}
                  link={linkTo(handOff.workflow)}
                  onOpen={onOpenWorkflow}
                  when={handOff.when}
                />
              ))}
              {handOffs.length === 0 && <span className="rail-none">none</span>}
              <span className="rail-none">inputs and hands_off_to: edit in YAML</span>
            </div>
            <div className="field-block">
              <span className="field-label-row">
                File <InfoTip doc={DOCS.version} />
              </span>
              <div className="rail-box-row">
                <span className="location-pill">{workflow.location}</span>
                <span className="file-path mono" title={workflow.path}>
                  {workflow.path}
                </span>
              </div>
            </div>
            <div className="field-block">
              <span className="field-label-row">Workstreams · {own.length}</span>
              {own.map((w) => {
                const state = RUN_STATE[runState(w.summary?.status)];
                return (
                  <button key={runKey(w)} className="rail-workstream-row" onClick={() => onOpenWorkstream(w)}>
                    <span className="rail-workstream-main">
                      <span className="mono rail-box-id">{w.slug}</span>
                      <span className="rail-workstream-meta">
                        {w.summary?.currentStep && w.summary.status !== "COMPLETED" ? `at ${w.summary.currentStep} · ` : ""}
                        started {dateTime(w.summary?.started)}
                        {w.project !== root ? ` · ${projectName(w.project)}` : ""}
                      </span>
                    </span>
                    <span className={`run-state-pill ${state.className}`}>{state.label}</span>
                  </button>
                );
              })}
              {own.length === 0 && <span className="rail-none">none</span>}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LibraryTab({
  library,
  allWorkflows,
  steps,
  selectedIndex,
  onAddArtifact,
  onOpenWorkflowStep,
  focus,
}: {
  library: LibraryEntry[];
  allWorkflows: OpenWorkflow[];
  steps: StepView[];
  selectedIndex: number | null;
  onAddArtifact: (step: number, mode: OutputMode, artifact: string, path?: string) => void;
  onOpenWorkflowStep: (workflowKey: string, stepIndex: number) => void;
  focus: { id: string; n: number } | null;
}) {
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<"all" | LibraryEntry["level"]>("all");
  const [open, setOpen] = useState<LibraryEntry | null>(null);
  const [file, setFile] = useState("");
  const [mode, setMode] = useState<OutputMode>("produces");
  const [path, setPath] = useState("");
  const selectedStep = selectedIndex === null ? undefined : steps[selectedIndex];
  const levelLabel = (value: LibraryEntry["level"]) =>
    ({ project: "project", user: "personal", package: "fuse-flow" })[value];
  const usage = (id: string) =>
    allWorkflows.flatMap((candidate) =>
      stepViews(candidate).flatMap((step, stepIndex) => [
        ...step.artifacts
          .filter((artifact) => artifact.artifact === id)
          .map((artifact) => ({ candidate, step, stepIndex, mode: artifact.role })),
        ...(step.consumes.includes(id) ? [{ candidate, step, stepIndex, mode: "consumes" }] : []),
      ]),
    );
  const add = (id: string, addMode = mode, addPath = path || suggestPath(id)) => {
    if (!selectedStep || selectedIndex === null) return;
    onAddArtifact(selectedIndex, addMode, id, addPath);
  };
  const openEntry = (entry: LibraryEntry) => {
    setOpen(entry);
    setFile(Object.keys(entry.files)[0] ?? "");
    setPath(suggestPath(entry.id));
  };
  // A G T R badge opens the entry its artifact resolves to, or searches for an id with none.
  useEffect(() => {
    if (!focus) return;
    const entry = winningEntry(library, focus.id);
    if (entry) openEntry(entry);
    else {
      setOpen(null);
      setQuery(focus.id);
    }
  }, [focus?.n]);
  const filtered = library.filter(
    (entry) =>
      (level === "all" || entry.level === level) &&
      (!query.trim() || entryPath(entry).includes(query.trim().toLowerCase())),
  );
  const unknown = query.trim().toLowerCase();
  const noLibrary = [...new Set(steps.flatMap((step) => step.artifacts.map((artifact) => artifact.artifact)))].filter(
    (id) => !library.some((entry) => entry.id === id),
  );

  const folders = useFolderState("komposer-library-folders");
  const searching = !!query.trim();
  const sectionOpen = (lv: LibraryEntry["level"]) => searching || folders.isOpen(`${lv}:`, "", true);
  const folderOpen = (lv: LibraryEntry["level"], prefix: string, name: string) =>
    searching || folders.isOpen(`${lv}:${prefix}`, name);
  const renderRow = (entry: LibraryEntry, depth: number) => {
    const used = usage(entry.id);
    const workflows = new Set(used.map((item) => item.candidate.path)).size;
    const hidden = !!entry.hiddenBy;
    return (
      <div
        key={`${entry.id}-${entry.level}-${entry.folder}`}
        className={`library-row${hidden ? " is-hidden" : ""}`}
        style={{ marginLeft: `${depth * 14}px` }}
        draggable
        onDragStart={(event) => event.dataTransfer.setData(ARTIFACT_DRAG, entry.id)}
        onClick={() => openEntry(entry)}
      >
        <span className="mono library-row-id">{entry.id}</span>
        <span className="chip-gtr">
          <span className={entry.files["guide.md"] ? "lit" : "dim"}>G</span>
          <span className={Object.keys(entry.files).some((name) => name.startsWith("template.")) ? "lit" : "dim"}>
            T
          </span>
          <span className={entry.files["review.md"] ? "lit" : "dim"}>R</span>
        </span>
        <span className="library-level-pill">{levelLabel(entry.level)}</span>
        {entry.description ? (
          <span className="library-description">{entry.description}</span>
        ) : entry.entryProblem ? (
          <span className="library-description is-missing">entry.yml has a problem</span>
        ) : null}
        <span className="library-meta">
          {(entry.hides || entry.hiddenBy) && (
            <span className="library-override">
              {entry.hiddenBy ? `hidden by ${levelLabel(entry.hiddenBy)}` : `hides ${levelLabel(entry.hides!)}`}
            </span>
          )}
          <span className="library-used">
            {used.length ? `${plural(used.length, "step")} · ${plural(workflows, "workflow")}` : "unused"}
          </span>
        </span>
        <button
          className="icon-mini"
          title={selectedStep ? `Add to ${selectedStep.id}` : "Select a step to add to"}
          aria-label={selectedStep ? `Add to ${selectedStep.id}` : "Select a step to add to"}
          disabled={!selectedStep}
          onClick={(event) => {
            event.stopPropagation();
            add(entry.id, "produces", suggestPath(entry.id));
          }}
        >
          <Plus size={14} />
        </button>
      </div>
    );
  };

  if (open) {
    const files = Object.keys(open.files);
    const shownFile = files.includes(file) ? file : files[0];
    const used = usage(open.id);
    const others = library.filter((entry) => entry.id === open.id && entry.level !== open.level);
    return (
      <div className="inspector-section-stack library-detail">
        <button className="text-button back-button" onClick={() => setOpen(null)}>
          ← Library
        </button>
        <div>
          <div className="library-detail-title">
            <strong>{open.id}</strong>
            <span className="library-level-pill">{levelLabel(open.level)}</span>
          </div>
          {(open.hides || open.hiddenBy) && (
            <div className="library-override">
              {open.hiddenBy ? `hidden by ${levelLabel(open.hiddenBy)}` : `hides ${levelLabel(open.hides!)}`}
            </div>
          )}
          {open.description && <p className="library-detail-description">{open.description}</p>}
          {others.length > 0 && (
            <div className="library-others">
              <span className="rail-kicker">Same id on other levels</span>
              {others.map((other) => {
                const inEffect = !other.hiddenBy;
                return (
                  <button key={other.level} type="button" className="library-other-row" onClick={() => openEntry(other)}>
                    <span className="library-level-pill">{levelLabel(other.level)}</span>
                    <span className={inEffect ? "library-in-effect" : "library-hidden-by"}>
                      {inEffect ? "in effect" : `hidden by ${LEVEL_LABEL[other.hiddenBy!]}`}
                    </span>
                    <span className="library-other-path">
                      {LEVEL_ROOT[other.level]}
                      {entryPath(other)}/
                    </span>
                  </button>
                );
              })}
            </div>
          )}
          {open.entryProblem && <div className="library-entry-problem">{open.entryProblem}</div>}
          <div className="file-path mono">{open.folder}</div>
          {open.group && <div className="library-override">filed under {open.group}/</div>}
        </div>
        {files.length > 0 && (
          <>
            <div className="library-file-tabs">
              {files.map((name) => (
                <button key={name} className={shownFile === name ? "is-active" : ""} onClick={() => setFile(name)}>
                  {name}
                </button>
              ))}
            </div>
            {open.links?.[shownFile] && (
              <div className="library-link" title={open.links[shownFile].path}>
                {shownFile} is a link to <span className="mono">{open.links[shownFile].display}</span>
              </div>
            )}
            <pre className="library-file">{open.files[shownFile]}</pre>
          </>
        )}
        <div className="field-block">
          <div className="field-block-head">Add to {selectedStep?.id ?? "no step selected"}</div>
          <div className="segmented">
            {(["produces", "optional_produces", "updates"] as OutputMode[]).map((value) => (
              <button
                key={value}
                className={`segmented-opt${mode === value ? " is-active" : ""}`}
                onClick={() => setMode(value)}
              >
                {value === "optional_produces" ? "may produce" : value}
              </button>
            ))}
          </div>
          <input
            className="field-input"
            value={path}
            placeholder={suggestPath(open.id)}
            onChange={(event) => setPath(event.target.value)}
          />
          <button className="primary-button" disabled={!selectedStep} onClick={() => add(open.id)}>
            Add
          </button>
        </div>
        <div className="field-block">
          <div className="field-block-head">Used by · {used.length}</div>
          {used.map(({ candidate, step, stepIndex, mode: usedMode }, index) => (
            <button
              key={`${candidate.path}-${step.id}-${index}`}
              className="library-used-row"
              onClick={() => onOpenWorkflowStep(workflowKey(candidate), stepIndex)}
            >
              <span>
                <strong>{candidate.file.replace(/\.ya?ml$/, "")}</strong> · {step.id}
              </span>
              <small>{usedMode}</small>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="inspector-section-stack">
      <input
        className="field-input"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search artifacts or type a new id"
      />
      <div className="library-toolbar">
        <div className="segmented">
          {(["all", "project", "user", "package"] as const).map((value) => (
            <button
              key={value}
              className={`segmented-opt${level === value ? " is-active" : ""}`}
              onClick={() => setLevel(value)}
            >
              {value === "user" ? "personal" : value === "package" ? "fuse-flow" : value}
            </button>
          ))}
        </div>
        <span className="library-add-to">
          ADD TO <strong>{selectedStep && selectedIndex !== null ? `${selectedIndex + 1} · ${selectedStep.id}` : "no step selected"}</strong>
        </span>
      </div>
      <div className="library-list">
        {LEVELS.filter((lv) => level === "all" || lv === level).map((lv) => {
          const inLevel = filtered
            .filter((entry) => entry.level === lv)
            .sort((a, b) => entryPath(a).localeCompare(entryPath(b)));
          if (!inLevel.length) return null;
          const open = sectionOpen(lv);
          const shownFolders = new Set<string>();
          return (
            <div key={lv}>
              <button
                className="library-section-head lane-toggle"
                aria-expanded={open}
                title={LEVEL_ROOT[lv]}
                onClick={() => folders.toggle(`${lv}:`, "", true)}
              >
                <Chevron open={open} />
                <span className="lane-group-label">{LEVEL_LABEL[lv]}</span>
                <span className="library-section-count">{inLevel.length}</span>
                <span className="lane-group-root">{LEVEL_ROOT[lv]}</span>
              </button>
              {open &&
                inLevel.map((entry) => {
                  const rows: React.ReactNode[] = [];
                  let visible = true;
                  folderPrefixes(entry.group).forEach(({ prefix, name }, depth) => {
                    if (!visible) return;
                    const folderIsOpen = folderOpen(lv, prefix, name);
                    if (!shownFolders.has(prefix)) {
                      shownFolders.add(prefix);
                      rows.push(
                        <button
                          key={`folder-${prefix}`}
                          className="lane-folder-row lane-toggle"
                          aria-expanded={folderIsOpen}
                          style={{ paddingLeft: `${4 + depth * 14}px` }}
                          onClick={() => folders.toggle(`${lv}:${prefix}`, name)}
                        >
                          <Chevron open={folderIsOpen} />
                          {name}/
                        </button>,
                      );
                    }
                    visible = folderIsOpen;
                  });
                  if (visible) rows.push(renderRow(entry, folderPrefixes(entry.group).length));
                  return rows;
                })}
            </div>
          );
        })}
      </div>
      {unknown && !library.some((entry) => entry.id === unknown) && /^[a-z0-9][a-z0-9-]*$/.test(unknown) && (
        <button className="library-new" onClick={() => add(unknown, "produces", suggestPath(unknown))}>
          + Add {unknown}, no library entry
        </button>
      )}
      {noLibrary.length > 0 && (
        <div className="library-missing-footer">
          <span>In this workflow, no library entry · {noLibrary.length}</span>
          <div>
            {noLibrary.map((id) => (
              <span key={id}>{id}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function instructionStyle(text: string, step: number): ">" | "|" {
  const document = YAML.parseDocument(text);
  const instruction = document.getIn(["steps", step, "instruction"], true);
  return instruction instanceof Scalar && instruction.type === Scalar.BLOCK_LITERAL ? "|" : ">";
}
function clampRows(text?: string) {
  return Math.min(16, Math.max(5, (text?.split("\n").length ?? 1) + 1));
}
function conditionPlaceholder(kind: string) {
  return (
    (
      {
        check: "check kind, e.g. default",
        script: "shell command; success runs the step",
        agent: "when the step applies",
        "owner-action": "what to ask the owner",
      } as Record<string, string>
    )[kind] ?? ""
  );
}
function gateTextLabel(kind: string) {
  return (
    (
      {
        check: "check kind",
        script: "command",
        agent: "what to review",
        "owner-action": "what the owner does",
        workflow: "child workflow, by name or path",
      } as Record<string, string>
    )[kind] ?? "text"
  );
}

// A workflow gate's own fields: the child workstream's slug and the ids the
// child returns, which Komposer edits, and the inputs it gives the child,
// shown as written. Returns written as a mapping of other names are shown as
// written too; they are changed in the file.
function DelegationFields({
  gate,
  stepId,
  link,
  onSet,
  onOpenWorkflow,
}: {
  gate: Gate;
  stepId: string;
  link: WorkflowLink;
  onSet: (fields: { slug?: string | null; returns?: string[] | null }) => void;
  onOpenWorkflow: (key: string) => void;
}) {
  const returns = Object.entries(gate.returns ?? {});
  const listForm = returns.every(([id, from]) => id === from);
  const returnsText = returns.map(([id]) => id).join(", ");
  const [draft, setDraft] = useState(returnsText);
  useEffect(() => setDraft(returnsText), [returnsText]);
  const commit = () => {
    const ids = draft.split(/[\s,]+/).filter(Boolean);
    if (ids.join(", ") !== returnsText) onSet({ returns: ids.length ? ids : null });
  };
  const inputs = Object.entries(gate.inputs ?? {});
  return (
    <div className="delegation-grid">
      <span className="mini-label">
        child <span className="field-tag is-optional">optional</span>
        <InfoTip doc={GATE_FIELD_DOCS.slug} />
      </span>
      <span className="mini-label">
        returns <span className="field-tag is-optional">optional</span>
        <InfoTip doc={GATE_FIELD_DOCS.returns} />
      </span>
      <input
        className="field-input mono-input is-small"
        value={gate.slug ?? ""}
        placeholder={DEFAULT_CHILD_SLUG}
        title={`for workstream <slug>: ${(gate.slug ?? DEFAULT_CHILD_SLUG).replaceAll("{step}", stepId)}`}
        onChange={(e) => onSet({ slug: e.target.value || null })}
      />
      {listForm ? (
        <input
          className="field-input mono-input is-small"
          value={draft}
          placeholder="artifact ids, comma separated"
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && commit()}
        />
      ) : (
        <span className="mono delegation-written" title="Written as a mapping; edit in YAML">
          {returns.map(([id, from]) => (id === from ? id : `${id} ← ${from}`)).join(", ")}
        </span>
      )}
      {inputs.length > 0 && (
        <span className="delegation-inputs">
          <span className="mini-label">
            inputs <InfoTip doc={GATE_FIELD_DOCS.inputs} />
          </span>
          <span className="mono">{inputs.map(([a, b]) => (a === b ? a : `${a} ← ${b}`)).join(", ")}</span>
        </span>
      )}
      <button
        type="button"
        className="delegation-open"
        disabled={!link.ok}
        title={link.ok ? `Open ${link.path}` : link.reason}
        onClick={() => link.ok && onOpenWorkflow(link.key)}
      >
        {link.ok ? `Open ${gate.text || "…"} →` : `${gate.text || "…"} · not found`}
      </button>
    </div>
  );
}

// What an agent gate reviews against, as the engine decides it for each
// artifact of its step (see reviewInEffectRows).
function ReviewInEffect({
  gate,
  onViewFile,
}: {
  gate: ReviewGuides["gates"][number];
  onViewFile: (title: string, file: FileRef) => void;
}) {
  const rows = reviewInEffectRows(gate);
  return (
    <div className="review-in-effect">
      <span className="rail-kicker">Review in effect</span>
      {rows.map((row) => (
        <div key={row.key} className="review-in-effect-row">
          <span className="mono review-in-effect-what" title={row.file?.path}>
            {row.name}
          </span>
          <span className="review-in-effect-from">{row.from}</span>
          {row.file && (
            <button type="button" className="text-button is-small" onClick={() => onViewFile(row.title, row.file!)}>
              Open
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

// The button beside a gate's guide field: it opens the guide, or says the
// guide is missing. A guide that exists but cannot be read opens the viewer,
// which says why.
function GateGuideButton({ guide, onView }: { guide: FileRef & { exists: boolean }; onView: (file: FileRef) => void }) {
  const unreadable = guide.unreadable !== undefined;
  const opens = unreadable || guide.exists || !!guide.outside;
  return (
    <button
      type="button"
      className="text-button"
      disabled={!opens}
      title={unreadable ? `${guide.path} cannot be read: ${guide.unreadable}` : guide.path}
      onClick={() => onView(guide)}
    >
      {unreadable ? "Cannot be read" : opens ? "Open" : "Not found"}
    </button>
  );
}

// A guide file opened from a gate, over the whole panel.
function GuideViewer({
  title,
  file,
  text,
  backTo,
  onClose,
}: {
  title: string;
  file: FileRef;
  text?: string;
  backTo: string;
  onClose: () => void;
}) {
  return (
    <div className="guide-viewer">
      <div className="guide-viewer-head">
        <button type="button" className="text-button is-small is-accent" onClick={onClose}>
          ← Back to {backTo}
        </button>
        <span className="guide-viewer-title">{title}</span>
        <span className="guide-viewer-path" title={file.path}>
          {file.display}
        </span>
      </div>
      {file.outside ? (
        <div className="inspector-empty guide-viewer-note">
          Komposer shows guides only from the project, the libraries and the workflow locations.
        </div>
      ) : file.unreadable !== undefined ? (
        <div className="inspector-empty guide-viewer-note">The file cannot be read: {file.unreadable}</div>
      ) : text === undefined ? (
        <div className="inspector-empty guide-viewer-note">The file does not exist.</div>
      ) : (
        <pre className="rail-file">{text}</pre>
      )}
    </div>
  );
}
