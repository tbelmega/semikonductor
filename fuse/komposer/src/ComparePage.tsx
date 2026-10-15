// SPDX-License-Identifier: Apache-2.0
// Compare mode: two workflows picked from any location, their diagrams side
// by side and read-only, each step card marked by how it compares with the
// other side. A step that differs can be copied to the other side, which
// becomes an unsaved edit of that workflow; everything else is edited in edit
// mode, where "Edit" on a side opens it. A YAML view shows the line diff.

import { useMemo, useState } from "react";
import { ArrowLeftRight, Pencil } from "lucide-react";
import type { LibraryEntry } from "./api.ts";
import { Flow } from "./Flow.tsx";
import { compareWorkflows, copyStepEdits, type CompareCounts } from "./model/compare.ts";
import { lineDiff, visibleDiff } from "./diff.ts";
import type { Edit } from "./model/yamlEdit.ts";
import { problemsByStep, problemsForText } from "./validate.ts";
import { stem, stepViews, workflowHandOffs, workflowInputs, workflowKey, type LocationId, type OpenWorkflow, type WorkflowLink } from "./workflowView.ts";

export type Mode = "edit" | "compare";

const LOCATION_ORDER: LocationId[] = ["project", "personal", "fuse-flow"];
const LOCATION_LABEL: Record<LocationId, string> = { project: "Project", personal: "Personal", "fuse-flow": "fuse-flow" };

export function ModeSwitch({ mode, onMode }: { mode: Mode; onMode: (mode: Mode) => void }) {
  return (
    <div className="segmented mode-switch" role="tablist" aria-label="Mode">
      {(["edit", "compare"] as const).map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          className={`segmented-opt${mode === m ? " is-active" : ""}`}
          onClick={() => onMode(m)}
        >
          {m === "edit" ? "Edit" : "Compare"}
        </button>
      ))}
    </div>
  );
}

// The list order of the left navigation: by location, then by folder and file.
export function compareOrder(workflows: OpenWorkflow[]): OpenWorkflow[] {
  return LOCATION_ORDER.flatMap((loc) =>
    workflows
      .filter((w) => w.location === loc)
      .sort((a, b) => `${a.dir}${a.file}`.localeCompare(`${b.dir}${b.file}`)),
  );
}

const label = (w: OpenWorkflow) => `${w.dir ? `${w.dir}/` : ""}${stem(w.file)}`;

export function ComparePage({
  workflows,
  library,
  leftKey,
  rightKey,
  onPick,
  onEdit,
  onMode,
  onSwap,
  onApply,
  resolveLink,
}: {
  workflows: OpenWorkflow[];
  library: LibraryEntry[];
  leftKey: string | null;
  rightKey: string | null;
  onPick: (side: "left" | "right", key: string) => void;
  onEdit: (key: string) => void;
  onMode: (mode: Mode) => void;
  onSwap: () => void;
  // Applies edits to the workflow with this key, as an unsaved change.
  onApply: (key: string, edits: Edit[], message: string) => void;
  // Where a workflow reference in a shown workflow leads.
  resolveLink: (ref: string, from: OpenWorkflow) => WorkflowLink;
}) {
  const [view, setView] = useState<"diagrams" | "yaml">("diagrams");
  const ordered = useMemo(() => compareOrder(workflows), [workflows]);
  const left = workflows.find((w) => workflowKey(w) === leftKey) ?? null;
  const right = workflows.find((w) => workflowKey(w) === rightKey) ?? null;
  const leftSteps = useMemo(() => (left ? stepViews(left) : []), [left]);
  const rightSteps = useMemo(() => (right ? stepViews(right) : []), [right]);
  const result = useMemo(() => compareWorkflows(leftSteps, rightSteps), [leftSteps, rightSteps]);

  return (
    <div className="compare-page">
      <div className="center-header">
        <div className="center-header-main">
          <div className="center-header-title">workflow compare</div>
          <div className="center-header-sub">
            <span className="center-header-status">compare · read-only</span>
          </div>
        </div>
        <button className="compare-swap-btn" title="Swap the left and right workflows" onClick={onSwap}>
          <ArrowLeftRight size={14} strokeWidth={1.75} /> Swap sides
        </button>
        <div className="segmented compare-view-switch" role="tablist" aria-label="Compare view">
          {(["diagrams", "yaml"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              className={`segmented-opt${view === v ? " is-active" : ""}`}
              onClick={() => setView(v)}
            >
              {v === "diagrams" ? "Diagrams" : "YAML"}
            </button>
          ))}
        </div>
        <ModeSwitch mode="compare" onMode={onMode} />
      </div>
      <div className={`compare-columns${view === "yaml" ? " is-yaml" : ""}`}>
        {(["left", "right"] as const).map((sideName) => {
          const w = sideName === "left" ? left : right;
          const other = sideName === "left" ? right : left;
          const steps = sideName === "left" ? leftSteps : rightSteps;
          const otherSteps = sideName === "left" ? rightSteps : leftSteps;
          const copy =
            other && w && workflowKey(other) !== workflowKey(w)
              ? {
                  label: sideName === "left" ? "copy →" : "← copy",
                  title: (id: string) => `Copy step ${id} into ${other.file}, as an unsaved change`,
                  // A step that cannot be copied gives an empty edit list and the reason.
                  run: (index: number) => {
                    let edits: Edit[] = [];
                    let message = `Copied ${steps[index].id} into ${other.file} (unsaved)`;
                    try {
                      edits = copyStepEdits(steps, index, otherSteps);
                    } catch (e) {
                      message = e instanceof Error ? e.message : String(e);
                    }
                    onApply(workflowKey(other), edits, message);
                  },
                }
              : undefined;
          return (
            <CompareSide
              key={sideName}
              side={sideName}
              workflow={w}
              ordered={ordered}
              steps={steps}
              compare={sideName === "left" ? result.left : result.right}
              counts={sideName === "left" ? result.leftCounts : result.rightCounts}
              library={library}
              resolveLink={resolveLink}
              onPick={(key) => onPick(sideName, key)}
              onEdit={onEdit}
              copy={copy}
              showDiagram={view === "diagrams"}
            />
          );
        })}
      </div>
      {view === "yaml" && <YamlCompare left={left} right={right} />}
    </div>
  );
}

function CompareSide({
  side,
  workflow,
  ordered,
  steps,
  compare,
  counts,
  library,
  resolveLink,
  onPick,
  onEdit,
  copy,
  showDiagram,
}: {
  side: "left" | "right";
  workflow: OpenWorkflow | null;
  ordered: OpenWorkflow[];
  steps: ReturnType<typeof stepViews>;
  compare: ReturnType<typeof compareWorkflows>["left"];
  counts: CompareCounts;
  library: LibraryEntry[];
  resolveLink: (ref: string, from: OpenWorkflow) => WorkflowLink;
  onPick: (key: string) => void;
  onEdit: (key: string) => void;
  copy?: { label: string; title: (id: string) => string; run: (index: number) => void };
  showDiagram: boolean;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  const byStep = useMemo(
    () => problemsByStep(workflow ? problemsForText(workflow.openText) : []),
    [workflow?.openText],
  );
  const noop = () => {};
  return (
    <div className="compare-side">
      <div className="compare-side-head">
        <select
          className="compare-picker"
          aria-label={`${side} workflow`}
          value={workflow ? workflowKey(workflow) : ""}
          onChange={(event) => onPick(event.target.value)}
        >
          {LOCATION_ORDER.map((loc) => {
            const inLoc = ordered.filter((w) => w.location === loc);
            if (!inLoc.length) return null;
            return (
              <optgroup key={loc} label={LOCATION_LABEL[loc]}>
                {inLoc.map((w) => (
                  <option key={workflowKey(w)} value={workflowKey(w)}>
                    {label(w)}
                    {w.openText !== w.text ? " (unsaved)" : ""}
                  </option>
                ))}
              </optgroup>
            );
          })}
        </select>
        {workflow && (
          <button className="compare-edit-btn" title={`Edit ${workflow.file}`} onClick={() => onEdit(workflowKey(workflow))}>
            <Pencil size={13} strokeWidth={1.75} /> Edit
          </button>
        )}
      </div>
      <div className="toolbar compare-counts">
        <span className="toolbar-counts">
          {counts.steps} steps · {counts.artifacts} artifacts · {counts.routesBack} routes back
        </span>
        <span className="toolbar-counts">
          gates: {counts.gates["owner-action"]} owner · {counts.gates.agent} agent · {counts.gates.check} check ·{" "}
          {counts.gates.script} script · {counts.gates.workflow} workflow
        </span>
      </div>
      {!showDiagram ? null : workflow ? (
        <Flow
          steps={steps}
          selectedIndex={-1}
          onSelect={noop}
          problemsByStep={byStep}
          library={library}
          showPaths={false}
          showDescriptions
          hoveredArtifact={hovered}
          onHoverArtifact={setHovered}
          onInsert={noop}
          onAppend={noop}
          onMove={noop}
          onDelete={noop}
          onDropArtifact={noop}
          onDropArtifactAt={noop}
          inputs={workflowInputs(workflow)}
          handOffs={workflowHandOffs(workflow)}
          linkTo={(ref) => resolveLink(ref, workflow)}
          onOpenWorkflow={onEdit}
          findRun={() => undefined}
          onOpenRun={noop}
          readOnly
          compare={compare}
          compareAction={copy}
        />
      ) : (
        <div className="lane-empty">No workflow to show.</div>
      )}
    </div>
  );
}

// The line diff of the two open texts: "-" lines only in the left file, "+"
// lines only in the right, with unchanged runs folded.
function YamlCompare({ left, right }: { left: OpenWorkflow | null; right: OpenWorkflow | null }) {
  const lines = useMemo(() => lineDiff(left?.openText ?? "", right?.openText ?? ""), [left?.openText, right?.openText]);
  const removed = lines.filter((l) => l.kind === "-").length;
  const added = lines.filter((l) => l.kind === "+").length;
  return (
    <div className="compare-yaml">
      <div className="compare-yaml-legend">
        <span className="diff-remove">- {removed} lines only in {left?.file ?? "left"}</span>
        <span className="diff-add">+ {added} lines only in {right?.file ?? "right"}</span>
      </div>
      <pre className="yaml-pre diff-pre">
        {visibleDiff(lines).map((line, i) => (
          <span
            key={i}
            className={`diff-${line.kind === "…" ? "skip" : line.kind === "+" ? "add" : line.kind === "-" ? "remove" : "same"}`}
          >
            {line.kind === " " || line.kind === "…" ? "  " : `${line.kind} `}
            {line.text}
            {"\n"}
          </span>
        ))}
      </pre>
    </div>
  );
}
