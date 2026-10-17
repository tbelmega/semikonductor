// SPDX-License-Identifier: Apache-2.0
// The Compare page: the selected workflow on the left and any other one on
// the right, their steps aligned row by row (model/compare.ts), each pair
// marked element by element. The left is the editable working copy: a click
// on a left card selects that step for the right rail, and the right cards
// carry the actions that apply a difference, a whole step, an addition, a
// removal or a move to the left. The right side is read-only.

import { useEffect, useMemo, useRef } from "react";
import type { Gate } from "../../flow/src/schemas/gate.ts";
import { resolveLibrary, type LibraryEntry } from "./api.ts";
import { wordDiff, type WordRun } from "./diff.ts";
import { childSlug, GATE_STYLE, ModeBadge } from "./Flow.tsx";
import {
  alignSteps,
  applyProblem,
  compareItems,
  foldedStep,
  copyStepEdits,
  differences,
  moveEdits,
  outputKey,
  removeEdits,
  ROLE_LABEL,
  rowCounts,
  type CompareRow,
  type DiffMark,
  type RowKind,
  type StepDiff,
} from "./model/compare.ts";
import type { Edit } from "./model/yamlEdit.ts";
import { LOCATION_ROOT } from "./WorkflowList.tsx";
import { stem, stepViews, workflowKey, type OpenWorkflow, type StepView } from "./workflowView.ts";

const LOCATION_LABEL: Record<OpenWorkflow["location"], string> = {
  project: "Project",
  personal: "Personal",
  "fuse-flow": "fuse-flow",
  run: "Other project",
};

// How a workflow is named in the pickers, and the path shown below them.
const pickerLabel = (w: OpenWorkflow) => `${LOCATION_LABEL[w.location]} · ${w.dir ? `${w.dir}/` : ""}${stem(w.file)}`;
const pickerPath = (w: OpenWorkflow) => `${LOCATION_ROOT[w.location]}${w.dir ? `${w.dir}/` : ""}${w.file}`;

const ROW: Record<RowKind, { mark: string; label: string; tip: string }> = {
  same: { mark: "=", label: "same", tip: "same step, same content" },
  changed: { mark: "≠", label: "changed", tip: "same step id, content differs" },
  left: { mark: "−", label: "only left", tip: "only in the left workflow" },
  right: { mark: "+", label: "only right", tip: "only in the right workflow" },
  moved: { mark: "↕", label: "moved", tip: "in both, at a different position" },
};
const DIFF_MARK: Record<DiffMark, string> = { add: "+", del: "−", chg: "≠" };

export interface CompareProps {
  // The workflows the pickers offer, in lane order.
  workflows: OpenWorkflow[];
  left: OpenWorkflow;
  right: OpenWorkflow | null;
  library: LibraryEntry[];
  selectedIndex: number | null;
  onSelectStep: (index: number) => void;
  onPick: (side: "left" | "right", key: string) => void;
  onSwap: () => void;
  onlyDifferences: boolean;
  onOnlyDifferences: (on: boolean) => void;
  allInstructions: boolean;
  onAllInstructions: (on: boolean) => void;
  // The left workflow's status line, and Save.
  status: string;
  dirty: boolean;
  saveBlocked: string | null;
  onSave: () => void;
  // Applies edits to the left workflow as one change and shows the message;
  // with no edits, only the message (a refusal). The selection is cleared
  // after a step was added, removed or moved.
  onApply: (edits: Edit[], message: string, clearSelection: boolean) => void;
  // The disk-change banner for the left workflow, shown below the summary bar.
  diskBanner?: React.ReactNode;
  // The left workflow's problems chip and list, beside its status, and the
  // left steps that have problems, by index, whose cards are marked.
  problemsChip?: React.ReactNode;
  problemSteps?: ReadonlyMap<number, unknown>;
  // A left step to bring into view: unfolded if it sits in a run of
  // identical steps, then scrolled to. A new n asks again.
  reveal?: { index: number; n: number } | null;
}

export function Compare(props: CompareProps) {
  const { left, right, library, onApply } = props;
  const leftSteps = useMemo(() => stepViews(left), [left]);
  const rightSteps = useMemo(() => (right ? stepViews(right) : []), [right]);
  const rows = useMemo(() => (right ? alignSteps(leftSteps, rightSteps) : []), [leftSteps, rightSteps, right]);
  const counts = rowCounts(rows);
  const items = compareItems(rows, leftSteps, props.onlyDifferences);

  // Bring the requested step into view once: unfold its run first, then
  // scroll to its card when it is rendered.
  const scroller = useRef<HTMLDivElement>(null);
  const revealed = useRef(0);
  const { reveal, onlyDifferences, onOnlyDifferences } = props;
  useEffect(() => {
    if (!reveal || revealed.current === reveal.n) return;
    if (foldedStep(rows, reveal.index, onlyDifferences)) return onOnlyDifferences(false);
    revealed.current = reveal.n;
    scroller.current?.querySelector(`[data-left-step="${reveal.index}"]`)?.scrollIntoView({ block: "center" });
  }, [reveal, rows, onlyDifferences, onOnlyDifferences]);

  // Every apply checks first that both workflows can be trusted, then that
  // the step itself can be copied.
  const run = (make: () => Edit[], message: string, clearSelection = false) => {
    if (!right) return;
    const problem = applyProblem(left, right);
    if (problem) return onApply([], problem, false);
    let edits: Edit[];
    try {
      edits = make();
    } catch (e) {
      return onApply([], e instanceof Error ? e.message : String(e), false);
    }
    onApply(edits, message, clearSelection);
  };

  return (
    <div className="center compare">
      <div className="compare-pickers">
        <Picker side="left" workflows={props.workflows} value={left} onPick={(key) => props.onPick("left", key)} />
        <button type="button" className="compare-swap" title="Swap left and right" onClick={props.onSwap} disabled={!right}>
          <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M16 3l4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16" />
          </svg>
          Swap
        </button>
        <Picker side="right" workflows={props.workflows} value={right} onPick={(key) => props.onPick("right", key)} />
      </div>
      <div className="compare-summary">
        {(Object.keys(ROW) as RowKind[]).map((kind) => (
          <span key={kind} className="compare-count" title={ROW[kind].tip}>
            <span className={`compare-mark is-${kind}`}>{ROW[kind].mark}</span>
            {counts[kind]} {ROW[kind].label}
          </span>
        ))}
        <span className="grow" />
        <button className={`toggle-pill-btn${props.onlyDifferences ? " is-on" : ""}`} onClick={() => props.onOnlyDifferences(!props.onlyDifferences)}>
          only differences
        </button>
        <button className={`toggle-pill-btn${props.allInstructions ? " is-on" : ""}`} onClick={() => props.onAllInstructions(!props.allInstructions)}>
          all instructions
        </button>
        {props.problemsChip}
        <span className={`compare-status${props.dirty ? " is-dirty" : ""}`}>{props.status}</span>
        <button
          className={`compare-save${props.dirty && !props.saveBlocked ? " is-enabled" : ""}`}
          disabled={!props.dirty || !!props.saveBlocked}
          title={props.saveBlocked ?? (props.dirty ? `Save ${left.file}` : "No changes to save")}
          onClick={props.onSave}
        >
          Save…
        </button>
      </div>
      {props.diskBanner}
      <div className="compare-scroll" ref={scroller}>
        {!right ? (
          <div className="compare-none">There is no other workflow to compare {left.file} with.</div>
        ) : (
          <div className="compare-rows">
            {items.map((item, i) =>
              item.type === "gap" ? (
                <button key={`gap-${i}`} className="compare-gap" title="Show the identical steps" onClick={() => props.onOnlyDifferences(false)}>
                  <span className="compare-gap-mark">=</span>
                  {item.ids.length} identical step{item.ids.length === 1 ? "" : "s"} · {item.ids.join(", ")}
                </button>
              ) : (
                <Row
                  key={`${item.row.left}-${item.row.right}`}
                  row={item.row}
                  left={left}
                  right={right}
                  leftSteps={leftSteps}
                  rightSteps={rightSteps}
                  library={library}
                  allInstructions={props.allInstructions}
                  selectedIndex={props.selectedIndex}
                  onSelectStep={props.onSelectStep}
                  run={run}
                  problemSteps={props.problemSteps}
                />
              ),
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Picker({
  side,
  workflows,
  value,
  onPick,
}: {
  side: "left" | "right";
  workflows: OpenWorkflow[];
  value: OpenWorkflow | null;
  onPick: (key: string) => void;
}) {
  return (
    <label className="compare-picker">
      <span className="compare-picker-kicker">{side}</span>
      <span className="compare-picker-field">
        <span className="compare-picker-value">{value ? pickerLabel(value) : "none"}</span>
        <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
        <select aria-label={`${side} workflow`} value={value ? workflowKey(value) : ""} onChange={(event) => onPick(event.target.value)}>
          {!value && <option value="">none</option>}
          {workflows.map((w) => (
            <option key={workflowKey(w)} value={workflowKey(w)}>
              {pickerLabel(w)}
            </option>
          ))}
        </select>
      </span>
      <span className="compare-picker-path">{value ? pickerPath(value) : ""}</span>
    </label>
  );
}

function Row({
  row,
  left,
  right,
  leftSteps,
  rightSteps,
  library,
  allInstructions,
  selectedIndex,
  onSelectStep,
  run,
  problemSteps,
}: {
  row: CompareRow;
  left: OpenWorkflow;
  right: OpenWorkflow;
  leftSteps: StepView[];
  rightSteps: StepView[];
  library: LibraryEntry[];
  allInstructions: boolean;
  selectedIndex: number | null;
  onSelectStep: (index: number) => void;
  run: (make: () => Edit[], message: string, clearSelection?: boolean) => void;
  problemSteps?: ReadonlyMap<number, unknown>;
}) {
  const x = row.left !== null ? leftSteps[row.left] : null;
  const y = row.right !== null ? rightSteps[row.right] : null;
  const words = x && y && row.diff?.instruction ? wordDiff(x.instruction ?? "", y.instruction ?? "") : null;
  const lines = x && y && row.kind === "changed" ? differences(x, y, row.left!) : [];
  const leftName = stem(left.file);
  const rightName = stem(right.file);

  let head: React.ReactNode = null;
  if (y && row.kind === "changed" && lines.length > 1)
    head = (
      <button
        className="compare-apply"
        title="Make the left step match this one"
        onClick={() => run(() => copyStepEdits(rightSteps, row.right!, leftSteps), `Applied all changes to ${x!.id}`)}
      >
        ← Apply all
      </button>
    );
  if (y && row.kind === "right")
    head = (
      <button
        className="compare-apply"
        title="Copy this step into the left workflow"
        onClick={() =>
          run(() => copyStepEdits(rightSteps, row.right!, leftSteps, row.at), `Added ${y.id} to ${leftName} as step ${row.at + 1}`, true)
        }
      >
        ← Add to left as step {row.at + 1}
      </button>
    );
  if (y && row.kind === "moved")
    head = (
      <button className="compare-apply" title="Move the left step to this position" onClick={() => run(() => moveEdits(row), `Moved ${y.id} in ${leftName}`, true)}>
        ← Move left step here
      </button>
    );

  return (
    <div className="compare-row">
      {x ? (
        <Card
          step={x}
          index={row.left!}
          side="left"
          row={row}
          words={words?.left}
          library={library}
          allInstructions={allInstructions}
          selected={selectedIndex === row.left}
          problem={!!problemSteps?.has(row.left!)}
          onSelect={() => onSelectStep(row.left!)}
        />
      ) : (
        <div className="compare-slot">{row.kind === "moved" ? `moved from step ${row.from! + 1}` : `not in ${leftName}`}</div>
      )}
      <div className="compare-gutter">
        <span className={`compare-gutter-line is-${row.kind}`} />
        <span className={`compare-mark is-${row.kind} is-big`} title={ROW[row.kind].tip}>
          {ROW[row.kind].mark}
        </span>
      </div>
      {y ? (
        <Card step={y} index={row.right!} side="right" row={row} words={words?.right} library={library} allInstructions={allInstructions} head={head}>
          {lines.length > 0 && (
            <div className="compare-diffs">
              {lines.map((line, k) => (
                <div key={k} className="compare-diff">
                  <span className={`compare-diff-mark is-${line.mark}`}>{DIFF_MARK[line.mark]}</span>
                  <span className="compare-diff-label" title={line.label}>
                    {line.label}
                  </span>
                  <button
                    className="compare-diff-apply"
                    title={line.refused ?? "Apply this change to the left workflow"}
                    onClick={() =>
                      run(() => {
                        if (line.refused) throw new Error(line.refused);
                        return line.edits;
                      }, `Applied to ${x!.id}: ${line.label}`)
                    }
                  >
                    ← Apply
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      ) : (
        <div className="compare-slot">
          {row.kind === "moved" ? `moved to step ${row.to! + 1}` : `not in ${rightName}`}
          {row.kind === "left" && (
            <button
              className="compare-apply"
              title="Delete this step from the left workflow"
              onClick={() => run(() => removeEdits(row), `Removed ${x!.id} from ${leftName}`, true)}
            >
              ← Apply · remove from left
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// An element's mark on this side: on the left, what the right lacks is
// removed; on the right, what the left lacks is added; on both, a detail
// that differs is changed. Elements are named by key, gates by file index.
function mark<K>(side: "left" | "right", key: K, only: { left: K[]; right: K[] }, changed: K[] = []): string {
  if (only[side].includes(key)) return side === "left" ? " is-del" : " is-add";
  return changed.includes(key) ? " is-chg" : "";
}

function Card({
  step,
  index,
  side,
  row,
  words,
  library,
  allInstructions,
  selected,
  problem,
  onSelect,
  head,
  children,
}: {
  step: StepView;
  index: number;
  side: "left" | "right";
  row: CompareRow;
  words?: WordRun[];
  library: LibraryEntry[];
  allInstructions: boolean;
  selected?: boolean;
  // A left step with a problem: its card is marked as Edit marks it.
  problem?: boolean;
  onSelect?: () => void;
  head?: React.ReactNode;
  children?: React.ReactNode;
}) {
  const d: StepDiff | undefined = row.diff;
  const moved = row.kind === "moved" ? (side === "left" ? `moved to ${row.to! + 1} →` : `← moved from ${row.from! + 1}`) : "";
  const instruction = words ?? (allInstructions && step.instruction?.trim() ? [{ text: step.instruction.trim(), changed: false }] : null);
  const consumes = { left: d?.consumesLeft ?? [], right: d?.consumesRight ?? [] };
  const outputs = { left: d?.outputsLeft ?? [], right: d?.outputsRight ?? [] };
  const gates = { left: d?.gatesLeft ?? [], right: d?.gatesRight ?? [] };
  const gatesChanged = (d?.gatesChanged ?? []).map((pair) => pair[side]);
  const gateExtra = (g: Gate) =>
    g.route_back_to.length ? `↩ ${g.route_back_to.join(", ")}` : g.kind === "workflow" ? `↳ ${childSlug(g, step.id)}` : "";
  return (
    <div
      className={`compare-card is-${row.kind}${onSelect ? " is-editable" : ""}${selected ? " is-selected" : ""}${problem ? " has-problems" : ""}`}
      data-left-step={side === "left" ? index : undefined}
      onClick={onSelect}
      title={onSelect ? "Edit this step" : undefined}
    >
      <div className="compare-card-head">
        <span className="compare-card-num">{index + 1}</span>
        {/* The editable card selects on click; its title is the keyboard control. */}
        {onSelect ? (
          <button
            type="button"
            className={`compare-card-title${d?.title ? " is-chg" : ""}`}
            aria-label={`Select step ${step.id}${step.title ? `: ${step.title}` : ""}`}
            aria-current={selected ? "true" : undefined}
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
            }}
          >
            {step.title || step.id}
          </button>
        ) : (
          <span className={`compare-card-title${d?.title ? " is-chg" : ""}`}>{step.title || step.id}</span>
        )}
        <span className="compare-card-id">{step.title ? step.id : ""}</span>
        <ModeBadge mode={step.mode} changed={d?.mode} />
        {moved && <span className="compare-moved">{moved}</span>}
        {head && <span onClick={(event) => event.stopPropagation()}>{head}</span>}
      </div>
      {(step.phase || d?.phase) && (
        <div className="compare-phase">
          <span className="compare-phase-label">phase</span>
          <span className={`compare-phase-value${d?.phase ? " is-chg" : ""}`}>{step.phase || "none"}</span>
        </div>
      )}
      {step.condition && (
        <div className={`compare-condition${d?.condition ? " is-chg" : ""}`}>
          <span className="compare-condition-label">only if</span>
          <span className="compare-condition-kind" style={{ background: GATE_STYLE[step.condition.kind].bg, color: GATE_STYLE[step.condition.kind].fg }}>
            {GATE_STYLE[step.condition.kind].label}
          </span>
          <span className="compare-condition-text">{step.condition.text}</span>
        </div>
      )}
      {instruction && (
        <div className="compare-instruction">
          {instruction.map((w, k) => (
            <span key={k} className={w.changed ? (side === "left" ? "is-del" : "is-add") : undefined}>
              {w.text}
            </span>
          ))}
        </div>
      )}
      {step.consumes.length + step.artifacts.length > 0 && (
        <div className="compare-chips">
          {step.consumes.map((id) => (
            <span key={`c-${id}`} className={`compare-chip is-consume${mark(side, id, consumes)}`}>
              <span className="compare-chip-arrow">←</span>
              {id}
            </span>
          ))}
          {step.artifacts.map((a) => {
            const entry = resolveLibrary(library, a.artifact);
            const gtr = entry ? ["G", entry.t ? "T" : "", entry.r ? "R" : ""].filter(Boolean).join(" ") : "no guide";
            return (
              <span
                key={`o-${outputKey(a)}`}
                className={`compare-chip is-output${mark(side, outputKey(a), outputs, d?.outputsChanged)}`}
                title={`${ROLE_LABEL[a.role]} · ${a.path}`}
              >
                {a.role === "updates" && <span className="compare-chip-arrow">~</span>}
                {a.artifact}
                {a.role === "optional_produces" ? "?" : ""}
                <span className="compare-chip-gtr">{gtr}</span>
              </span>
            );
          })}
        </div>
      )}
      {step.gates.length > 0 && (
        <div className="compare-chips">
          {step.gates.map((g, k) => {
            const style = GATE_STYLE[g.kind];
            const extra = gateExtra(g);
            return (
              <span
                key={k}
                className={`compare-gate${mark(side, k, gates, gatesChanged)}`}
                style={{ background: style.bg, color: style.fg }}
              >
                <span className="compare-gate-kind">{style.label}</span>
                <span className="compare-gate-text">{g.text}</span>
                {extra && <span className="compare-gate-extra">{extra}</span>}
              </span>
            );
          })}
        </div>
      )}
      {children}
    </div>
  );
}
