// SPDX-License-Identifier: Apache-2.0
// The fuse-flow commands. Each returns the lines to print, or throws a
// FlowError whose message says why the command was refused.
//
// A workstream is a state machine. The current step is the first step in file
// order that is neither COMPLETED nor SKIPPED. Every command ends by handing
// out the current step, if it is PENDING, and printing what to do next: the
// step block when it is the agent's turn, the hand-over block when it is the
// owner's.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { currentBase, resolveBase } from "./base.ts";
import { FlowError } from "./errors.ts";
import { EVENT, ownerNotes, runEvents, SKIP_REASON, stamp } from "./history.ts";
import { has, own } from "./own.ts";
import {
  artifactPath,
  checkBinding,
  display,
  libraryEntry,
  loadProject,
  maxRounds,
  type Project,
  type Launch,
  launch,
  launchSetting,
  reviewer,
  reviewers,
  ownersReviewGuide,
  reviewGuide,
  refuseBadReviewGuides,
  reviewGuideProblems,
  reviewGuideSource,
  rulings,
} from "./policy.ts";
import { decisionsFile, findWorkflow, isDirectory, isWorkflowPath, reviewsDir, workflowDirs, workflowFilesBelow, workstreamFile, workstreamsDir } from "./project.ts";
import { type Artifact, type Condition, describeGate, type Gate, loadWorkflow, type Step, type Workflow } from "./workflow.ts";
import {
  childGate,
  childSlug,
  crossCheck,
  documentOf,
  firstUnfinished,
  isComplete,
  links,
  parentGone,
  recordedFolder,
  refuseCycle,
  untouched,
  whereIs,
  workflowFile,
} from "./links.ts";
import {
  localDate,
  readWorkstream,
  startedOn,
  type StepState,
  type StepStatus,
  stateOf,
  updateWorkstream,
  type Workstream,
  workstreamExists,
  type Written,
} from "./workstream.ts";

// How the follow-up commands fuse-flow prints start. The fuse-flow script
// sets FUSE_FLOW_COMMAND to its own absolute path, so a printed command works
// without fuse-flow being on PATH.
const FUSE_FLOW = shellQuote(process.env.FUSE_FLOW_COMMAND || "fuse-flow");

// A path that the shell reads as one word, even with spaces or quotes in it.
function shellQuote(word: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

// The JSON Schema a reviewer's findings file follows.
const FINDINGS_SCHEMA = resolve(import.meta.dirname, "..", "workflows", "schemas", "review-findings.schema.json");

const finished = (status: StepStatus) => status === "COMPLETED" || status === "SKIPPED";

// Everything a command needs to know about one workstream. The workflow is
// read fresh on every command, so an edit to the workflow file takes effect
// straight away.
interface Ctx {
  root: string;
  slug: string;
  wf: Workflow;
  p: Project;
  date: string; // the day the workstream started, for {date} in artifact paths
}

// A review guide that cannot be followed is refused for the steps still to
// finish, whose step blocks print it; `readOnly` commands, which print no
// step block, read the workstream whatever its guides. Steps before index
// `from` of the workflow are not checked: the command passes over them.
function context(root: string, slug: string, ws: Workstream, readOnly = false, from: (wf: Workflow) => number = () => 0): Ctx {
  const file = findWorkflow(root, ws.workflow);
  const c = { root, slug, wf: loadWorkflow(file), p: loadProject(root), date: startedOn(ws) };
  if (!readOnly) {
    const first = from(c.wf);
    refuseBadReviewGuides(c.p, c.wf, file, (step) => c.wf.steps.indexOf(step) >= first && unfinishedIn(ws)(step));
  }
  convertOldState(c, ws);
  return c;
}

// The steps the workstream has not finished yet.
const unfinishedIn = (ws: Workstream) => (step: Step) => !finished(stateOf(ws, step.id).status);

const currentStep = (wf: Workflow, ws: Workstream) => firstUnfinished(wf, ws);

const position = (c: Ctx, step: Step) => `${c.wf.steps.indexOf(step) + 1} of ${c.wf.steps.length}`;

// The gates in the order they run: the child workstream, checks, then agent
// reviews, then the owner, so that a reviewer and the owner see the child's
// results, the cheap deterministic checks fail first and the owner sees only
// work that has already passed review. Within a kind, the order the workflow
// lists them in.
function gatesInOrder(step: Step): Gate[] {
  const rank = (g: Gate) => (g.kind === "workflow" ? -1 : g.kind === "check" || g.kind === "script" ? 0 : g.kind === "agent" ? 1 : 2);
  return [...step.gates].sort((a, b) => rank(a) - rank(b));
}

const ownerGates = (step: Step) => step.gates.filter((g) => g.kind === "owner-action");
const routesBack = (step: Step) => [...new Set(step.gates.flatMap((g) => g.route_back_to))];

// A gate's number in the step block's list of gates, WHEN THE WORK IS DONE.
// The owner's gates come last in gatesInOrder and are not listed, so the
// number of every listed gate is its place in that order.
const gateNumber = (step: Step, g: Gate) => gatesInOrder(step).indexOf(g) + 1;

// A gate as the hand-over block names it.
function gateLabel(c: Ctx, step: Step, state: StepState, g: Gate): string {
  if (g.kind === "agent") return `review (${g.text})`;
  if (g.kind === "workflow") return `workstream ${childOf(c, state, step)}`;
  if (g.kind === "check" || g.kind === "script") return mechanical(c, g).label;
  return g.text;
}

// The review numbered `n` in the step block, or a refusal that lists the
// step's reviews by number.
function reviewNumbered(step: Step, n: number): Gate {
  const g = gatesInOrder(step)[n - 1];
  if (g?.kind === "agent") return g;
  const reviews = gatesInOrder(step).filter((x) => x.kind === "agent");
  if (!reviews.length) throw new FlowError(`step "${step.id}" has no review, so there is no gate for --gate to name`);
  throw new FlowError(
    `--gate names one of the step's reviews by its number in the step's list: ` +
      reviews.map((x) => `${gateNumber(step, x)} (${x.text})`).join(", "),
  );
}

interface Placed {
  artifact: Artifact;
  path: string; // relative to the repository root, {slug} and {date} replaced
}

const place = (c: Ctx, artifacts: Artifact[]): Placed[] => artifacts.map((artifact) => ({ artifact, path: artifactPath(c.p, artifact, c.slug, c.date) }));
const onDisk = (c: Ctx, path: string) => existsSync(resolve(c.root, path));

// Whether `file` lies at or below `path`. Both are as display() shows them:
// relative to the repository root when inside it, absolute when outside, so
// a file outside the repository is inside no artifact.
function contains(path: string, file: string): boolean {
  if (isAbsolute(file) || file === ".." || file.startsWith("../")) return false;
  const dir = path.replace(/\/+$/, "").replace(/^\.\/+/, "");
  if (dir === "" || dir === ".") return true;
  return file === dir || file.startsWith(`${dir}/`);
}

// Every path this workstream recorded, in any step.
function recordedPaths(ws: Workstream): Set<string> {
  return new Set(Object.values(ws.steps).flatMap((s) => s.artifacts.map((a) => a.path)));
}

// Whether an artifact path names a folder: written with a trailing slash, or a
// directory on disk.
const isFolder = (c: Ctx, path: string) => path.endsWith("/") || isDirectory(resolve(c.root, path));

const unique = (items: string[]) => [...new Set(items)];

// The step's declared artifacts with their paths, in the order it declares them.
const declaredOf = (c: Ctx, step: Step) => place(c, [...step.produces, ...step.optional_produces, ...step.updates]);

// The ids of the step's artifacts whose paths hold `file`.
const holders = (c: Ctx, step: Step, file: string) =>
  unique(declaredOf(c, step).filter((a) => contains(a.path, file)).map((a) => a.artifact.artifact));

// How the agent names a file it writes in a folder artifact: by the file
// alone, or, where the folder lies inside another declared path, with the
// artifact it counts for.
const fileFlag = (c: Ctx, step: Step, a: Placed) =>
  declaredOf(c, step).some((o) => o.artifact.artifact !== a.artifact.artifact && contains(o.path, a.path))
    ? `--updated ${a.artifact.artifact}=<file>`
    : "--updated <file>";

const isUpdates = (step: Step, id: string | undefined) => step.updates.some((a) => a.artifact === id);

// Whether a skipped step was passed over when the owner started later or
// jumped forward, rather than skipped for a reason of its own.
const passedOver = (state: StepState) =>
  Boolean(state.skip_reason?.startsWith(SKIP_REASON.startedAt("")) || state.skip_reason?.startsWith(SKIP_REASON.jumpedForward("")));

// Whether a skipped step was skipped because it was not needed: its condition
// did not hold, or the owner answered it no. A step passed over when the
// owner started later or jumped forward may still have work to restore.
const notNeeded = (step: Step, state: StepState) => step.condition !== undefined && !passedOver(state);

// ------------------------------------------------------------------ commands

// How a mechanical gate or condition runs in this project: its command, or why
// there is none.
type Mechanical =
  | { kind: "run"; command: string; label: string }
  | { kind: "none"; label: string; file: string }
  | { kind: "unbound"; label: string; check: string };

function mechanical(c: Ctx, g: Gate | Condition): Mechanical {
  if (g.kind === "script") return { kind: "run", command: g.text, label: `script \`${g.text}\`` };
  const binding = checkBinding(c.p, g.text);
  const label = `check ${g.text}`;
  if (!binding) return { kind: "unbound", label, check: g.text };
  if (binding.command === "none") return { kind: "none", label, file: display(c.p, binding.file) };
  return { kind: "run", command: binding.command, label: `${label} (\`${binding.command}\`)` };
}

function bindInstruction(c: Ctx, check: string): string {
  const base =
    `This project has no command for the ${check} check yet. Find it in the project (package.json, a Makefile, ` +
    `Cargo.toml and so on), confirm it with the owner, and record it in .konductor/policy-overrides.yml as ` +
    `\`checks: { ${check}: <command> }\`.`;
  return check === "default"
    ? `${base} If the project has no check command for agents, suggest that the owner add one, and meanwhile bind ` +
        "the closest existing command, with the owner's confirmation."
    : base;
}

// The command as the agent runs it by hand: with the variables fuse-flow sets
// when it runs the command, and through sh -c as fuse-flow does, so that a
// command that reads them in its own text sees them too.
function byHand(c: Ctx, step: Step, command: string): string {
  return `FUSE_FLOW_SLUG=${shellQuote(c.slug)} FUSE_FLOW_STEP=${shellQuote(step.id)} sh -c ${shellQuote(command)}`;
}

// Runs from the repository root with the caller's environment, like a
// Makefile target, plus FUSE_FLOW_SLUG and FUSE_FLOW_STEP. Keeps only the end
// of the output: enough to see why it failed without flooding the agent's
// context. The output goes to a file rather than into memory, so a check that
// prints any amount still finishes and reports its own exit code.
const OUTPUT_TAIL_LINES = 20;
const OUTPUT_TAIL_BYTES = 64 * 1024;

function runCommand(c: Ctx, command: string, stepId: string) {
  const dir = mkdtempSync(join(tmpdir(), "fuse-flow-check-"));
  try {
    const fd = openSync(join(dir, "output"), "w+");
    try {
      const proc = spawnSync("sh", ["-c", command], {
        cwd: c.root,
        env: { ...process.env, FUSE_FLOW_SLUG: c.slug, FUSE_FLOW_STEP: stepId },
        stdio: ["ignore", fd, fd],
      });
      if (proc.error) throw proc.error;
      return { exitCode: proc.status, output: outputTail(fd) };
    } finally {
      closeSync(fd);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The last lines of the output file. Reads only its end; when that cuts a
// line, the cut line is dropped.
function outputTail(fd: number): string {
  const size = fstatSync(fd).size;
  const length = Math.min(size, OUTPUT_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  readSync(fd, buffer, 0, length, size - length);
  let text = buffer.toString("utf8");
  if (length < size && text.includes("\n")) text = text.slice(text.indexOf("\n") + 1);
  return text.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n");
}

// ------------------------------------------------------------------ hand-out
// Hand out the current step if it is PENDING: run a script or check condition
// and skip the step when it says so, otherwise mark it IN_PROGRESS and note
// which of its produces paths already exist. Repeats until the current step is
// handed out, waits for someone, or the workflow is complete. A condition runs
// without holding the state file's lock.

function handOut(c: Ctx): void {
  for (;;) {
    const ws = readWorkstream(c.root, c.slug);
    const step = currentStep(c.wf, ws);
    if (!step || stateOf(ws, step.id).status !== "PENDING") return;

    let skip: string | undefined;
    let note = EVENT.handedOut();
    const cond = step.condition;
    if (cond && (cond.kind === "script" || cond.kind === "check")) {
      const m = mechanical(c, cond);
      if (m.kind === "unbound") return; // stays PENDING; the output says how to bind it
      if (m.kind === "run") {
        const r = runCommand(c, m.command, step.id);
        if (r.exitCode === 0) note = EVENT.handedOut(`condition \`${m.command}\` exited 0`);
        else skip = `condition \`${m.command}\` exited ${r.exitCode ?? "without a code, killed by a signal"}`;
      } else {
        note = EVENT.handedOut(`condition ${m.label} is not configured in this project`);
      }
    }

    let moved = false;
    updateWorkstream(c.root, c.slug, (ws2) => {
      const state = stateOf(ws2, step.id);
      if (currentStep(c.wf, ws2) !== step || state.status !== "PENDING") return; // another command got here first
      moved = true;
      if (skip) {
        state.status = "SKIPPED";
        state.skip_reason = skip;
        state.history.push(stamp(EVENT.skipped(skip)));
        return;
      }
      state.status = "IN_PROGRESS";
      // A later pass keeps what the first pass found: by now the workstream
      // has recorded files of its own in a folder that existed before it.
      // A folder that another artifact of this workstream recorded, such as
      // an index updated in a shared reports folder, still holds none of this
      // artifact's files, so it counts as existing for this one.
      if (!state.pass) {
        const recorded = recordedPaths(ws2);
        const ownRecord = (a: Placed) =>
          isFolder(c, a.path)
            ? Object.values(ws2.steps).some((s) => s.artifacts.some((r) => r.path === a.path && r.artifact === a.artifact.artifact))
            : recorded.has(a.path);
        const existed = place(c, [...step.produces, ...step.optional_produces])
          .filter((a) => onDisk(c, a.path) && !ownRecord(a))
          .map((a) => a.path);
        if (existed.length) state.existed = existed;
        else delete state.existed;
      }
      state.history.push(stamp(note));
    });
    if (!moved) continue;
    if (!skip) return;
  }
}

// ------------------------------------------------------------------ output

// The base to record for a workstream that starts now, as fields to spread
// into its state; none outside a git repository or before its first commit.
function baseNow(root: string): { base?: { sha: string; subject: string } } {
  const base = currentBase(root);
  return base ? { base } : {};
}

// The base for printing, as "<short sha> (<subject>)", with how it was found
// when it is not the recorded one.
function baseText(root: string, ws: Workstream, withHow: boolean): string | undefined {
  const b = resolveBase(root, ws);
  if (!b) return undefined;
  const text = `${b.sha.slice(0, 12)}${b.subject ? ` (${b.subject})` : ""}`;
  return withHow && !b.how.startsWith("recorded") ? `${text}, ${b.how}` : text;
}

// What the review text says about the code changes under review.
function baseSentence(c: Ctx, ws: Workstream): string {
  const b = resolveBase(c.root, ws);
  if (!b) return "";
  return (
    ` When the review covers code, the workstream's changes are everything since its base commit ` +
    `${b.sha.slice(0, 12)}${b.subject ? ` (${b.subject})` : ""}: the commits from there to HEAD, and any changes ` +
    `not committed yet. The base was ${b.how}. Use it as it is, even if the range is a little wider or narrower ` +
    "than the work; do not ask the owner about it."
  );
}

function present(c: Ctx): string[] {
  handOut(c);
  const ws = readWorkstream(c.root, c.slug);
  const step = currentStep(c.wf, ws);
  if (!step) return handOver(c, ws, undefined);
  const state = stateOf(ws, step.id);
  switch (state.status) {
    case "PENDING": {
      const m = mechanical(c, step.condition!) as Extract<Mechanical, { kind: "unbound" }>;
      return [
        `STEP ${step.id} (${position(c, step)}) cannot be handed out yet: its condition names the ${m.check} check.`,
        `${bindInstruction(c, m.check)} Then run \`${FUSE_FLOW} start ${c.slug}\`.`,
        // A step not handed out cannot be reported blocked; the owner's way
        // past it is a skip.
        ...stopEarly(c, ws, step, `If the owner decides the step should not run, run \`${FUSE_FLOW} continue ${c.slug} --skip "<the owner's reason>"\`.`),
      ];
    }
    case "IN_PROGRESS": {
      try {
        ensureChild(c, step);
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
        const exists = workstreamExists(c.root, childOf(c, state, step)!);
        return [
          `STEP ${step.id} (${position(c, step)}) waits for a child workstream that cannot be ${exists ? "used" : "created"}: ${e.message}.`,
          `If you cannot resolve this, report the step blocked: run \`${FUSE_FLOW} continue ${c.slug} --blocked "<the reason above>"\`, so the owner decides.`,
          ...stopEarly(c, ws, step),
        ];
      }
      const fresh = readWorkstream(c.root, c.slug);
      return stepBlock(c, fresh, step, stateOf(fresh, step.id));
    }
    default:
      return handOver(c, ws, step);
  }
}

// What the step block says about a document it reads that is not on disk.
const RESTORE =
  "It does not exist, for example because earlier steps were skipped. Restore what this step needs in the way " +
  "that serves the owner, such as copying or extracting it from related work, or writing a placeholder that " +
  "explains the status, and report what you did in the hand-over block.";

// A workflow reference as the agent reads it: a name, or a path from the repository root.
const refName = (c: Ctx, ref: string) => (isWorkflowPath(ref) ? display(c.p, ref) : ref);

// The child workstream of the step's current pass, as recorded, or the slug
// it will be created under.
function childOf(c: Ctx, state: StepState, step: Step): string | undefined {
  const gate = childGate(step);
  if (!gate) return undefined;
  const pass = state.pass ?? 1;
  return state.children?.find((ch) => ch.pass === pass)?.slug ?? childSlug(gate, c.slug, step.id, pass);
}

// The READ line for a workflow input.
function inputLine(c: Ctx, ws: Workstream, id: string): string {
  const path = own(ws.inputs, id);
  if (path === undefined) return `READ ${id}: not given; the workstream was started without this input, so do the step without it.`;
  return onDisk(c, path) ? `READ ${path} (input ${id}).` : `READ ${path} (input ${id}). ${RESTORE}`;
}

// The READ line for a document an earlier step's child returned.
function returnedLine(c: Ctx, ws: Workstream, source: Step, id: string, childId: string): string {
  const state = stateOf(ws, source.id);
  if (state.status === "SKIPPED") {
    const why = `READ ${id}: step ${source.id} was skipped (${state.skip_reason ?? "no reason recorded"}), so no child workstream returned it`;
    // Passed over when the owner started later or jumped forward, the step's
    // work may still be needed.
    return passedOver(state) ? `${why}. ${RESTORE}` : `${why} and there is nothing to read.`;
  }
  const child = state.children?.at(-1)?.slug;
  if (!child) return `READ ${id}: step ${source.id} has no child workstream, so there is nothing to read.`;
  if (!isComplete(c.root, child)) {
    return `READ ${id}: workstream ${child}, the child of step ${source.id}, ${whereIs(c.root, child)}, so it has not returned ${childId} and there is nothing to read yet.`;
  }
  const path = documentOf(c.root, child, childId);
  if (!path) return `READ ${id}: workstream ${child}, the child of step ${source.id}, recorded no ${childId}, so there is nothing to read.`;
  const from = `(${id}, returned by workstream ${child}, the child of step ${source.id})`;
  return onDisk(c, path) ? `READ ${path} ${from}.` : `READ ${path} ${from}. ${RESTORE}`;
}

// Refuses a workstream under the child's slug that is not this step's child:
// one that follows another workflow, or belongs to another parent step; and
// a child whose next step blocks cannot be printed.
function checkChild(c: Ctx, step: Step, gate: Gate, slug: string): void {
  const child = readWorkstream(c.root, slug);
  if (workflowFile(c.root, child.workflow) !== workflowFile(c.root, gate.text)) {
    // A child recorded for this pass keeps its slug whatever the gate's slug
    // says now, so only a new pass gives the step a new child.
    const state = stateOf(readWorkstream(c.root, c.slug), step.id);
    if (state.children?.some((ch) => ch.pass === (state.pass ?? 1) && ch.slug === slug)) {
      throw new FlowError(
        `step ${step.id} waits for a child workstream ${slug} that follows ${refName(c, gate.text)}, but workstream ${slug} was ` +
          `created for this pass of the step and follows ${refName(c, child.workflow)}. To give the step a new child that follows ` +
          `${refName(c, gate.text)}, the owner sends the work back to it: \`${FUSE_FLOW} continue ${c.slug} --back-to ${step.id}\`; ` +
          `or change the gate back to ${refName(c, child.workflow)}`,
      );
    }
    throw new FlowError(
      `step ${step.id} waits for a child workstream ${slug} that follows ${refName(c, gate.text)}, but workstream ${slug} ` +
        `exists and follows ${refName(c, child.workflow)}. Rename that workstream's state file, or give the gate a slug of its own`,
    );
  }
  if (child.parent?.slug !== c.slug || child.parent.step !== step.id) {
    throw new FlowError(
      `step ${step.id} waits for a child workstream ${slug}, but workstream ${slug} exists and ` +
        (child.parent ? `belongs to step ${child.parent.step} of workstream ${child.parent.slug}` : "was started on its own") +
        ". Rename that workstream's state file, or give the gate a slug of its own",
    );
  }
  // The child's step blocks print the review guides of the steps it has not
  // finished, as its own commands check them.
  const file = findWorkflow(c.root, child.workflow);
  refuseBadReviewGuides(c.p, loadWorkflow(file), file, unfinishedIn(child));
}

// Why the step may not complete yet because of its child, or undefined when
// its child for this pass exists, is its own and is complete.
function childNotDone(c: Ctx, step: Step): string | undefined {
  const gate = childGate(step);
  if (!gate) return undefined;
  const state = stateOf(readWorkstream(c.root, c.slug), step.id);
  const slug = childOf(c, state, step)!;
  if (!workstreamExists(c.root, slug)) return `workstream ${slug}, which this step waits for, does not exist`;
  checkChild(c, step, gate, slug);
  if (!state.children?.some((ch) => ch.pass === (state.pass ?? 1) && ch.slug === slug)) {
    throw new FlowError(`workstream ${slug} is not recorded as this pass's child; run \`${FUSE_FLOW} start ${c.slug}\` to record it`);
  }
  return isComplete(c.root, slug) ? undefined : `workstream ${slug}, which this step waits for, ${whereIs(c.root, slug)}`;
}

// Why a delegating step may not complete yet because of its child, or
// undefined when the step has no workflow gate or its own child for this pass
// is complete. The same check as on continue. `child` says whether finishing
// the child would satisfy the gate: "unfinished" when it is this pass's own
// child and only not complete, "missing" when it does not exist, and
// "unusable" when it cannot satisfy the gate however far it runs.
function waitingFor(c: Ctx, step: Step): { slug: string; why: string; child: "unfinished" | "missing" | "unusable" } | undefined {
  if (!childGate(step)) return undefined;
  const slug = childOf(c, stateOf(readWorkstream(c.root, c.slug), step.id), step)!;
  try {
    const why = childNotDone(c, step);
    if (!why) return undefined;
    return { slug, why, child: workstreamExists(c.root, slug) ? "unfinished" : "missing" };
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    return { slug, why: e.message, child: "unusable" };
  }
}

// The workflow and inputs of the child workstream `slug` that the step's
// workflow gate creates, or a refusal that says why it cannot be created.
// Writes nothing, so the step block can say why too.
function newChild(c: Ctx, step: Step, gate: Gate, slug: string): { target: Workflow; inputs: Record<string, string> } {
  refuseCycle(c.root, c.slug, gate.text);
  const targetPath = findWorkflow(c.root, gate.text);
  const target = loadWorkflow(targetPath);
  // The checks a new workstream of that workflow gets from start.
  const errors = [...reviewGuideProblems(c.p, target, targetPath), ...crossCheck(c.root, targetPath, target).errors];
  if (errors.length) throw new FlowError(`workflow ${target.name} cannot start: ${errors.join("; ")}`);
  const inputs: Record<string, string> = {};
  for (const [childId, parentId] of Object.entries(gate.inputs ?? {})) {
    const path = documentOf(c.root, c.slug, parentId, step.id);
    if (path !== undefined) inputs[childId] = path;
  }
  const missing = target.inputs.filter((i) => i.required && !has(inputs, i.artifact));
  if (missing.length) {
    throw new FlowError(
      `step ${step.id} cannot create its child workstream ${slug}: ${target.name} requires ` +
        `${missing.map((i) => i.artifact).join(", ")}, and this workstream has no document to give it. Send the work back to the step that writes it`,
    );
  }
  return { target, inputs };
}

// Creates the child workstream of a step with a workflow gate, if it does not
// exist yet, with its inputs bound from this workstream's documents, and
// records it for the step's pass. The child is only created: its first step
// is handed out when the agent starts it.
function ensureChild(c: Ctx, step: Step): void {
  const gate = childGate(step);
  if (!gate) return;
  const state = stateOf(readWorkstream(c.root, c.slug), step.id);
  const pass = state.pass ?? 1;
  const slug = childOf(c, state, step)!;
  if (workstreamExists(c.root, slug)) {
    checkChild(c, step, gate, slug);
  } else {
    const { target, inputs } = newChild(c, step, gate, slug);
    updateWorkstream(
      c.root,
      slug,
      (child) => {
        for (const s of target.steps) stateOf(child, s.id);
      },
      { workflow: gate.text, started: localDate(), ...baseNow(c.root), parent: { slug: c.slug, step: step.id }, ...(Object.keys(inputs).length ? { inputs } : {}), steps: {} },
    );
  }
  if (state.children?.some((ch) => ch.pass === pass)) return;
  updateWorkstream(c.root, c.slug, (ws) => {
    const s = stateOf(ws, step.id);
    if (s.children?.some((ch) => ch.pass === pass)) return;
    s.children = [...(s.children ?? []), { pass, slug }];
    s.history.push(stamp(EVENT.childCreated(slug)));
  });
}

// Removes the child of the step's current pass when nothing has happened in
// it, because the step was skipped: a skipped step leaves no child. Returns
// the line to print.
function dropUntouchedChild(c: Ctx, step: Step): string[] {
  if (!childGate(step)) return [];
  const ws = readWorkstream(c.root, c.slug);
  const state = stateOf(ws, step.id);
  const pass = state.pass ?? 1;
  const slug = state.children?.find((ch) => ch.pass === pass)?.slug;
  if (!slug || !workstreamExists(c.root, slug)) return [];
  if (!untouched(readWorkstream(c.root, slug))) return [`The child workstream ${slug} stays as it is, because work was done in it.`];
  rmSync(workstreamFile(c.root, slug), { force: true });
  updateWorkstream(c.root, c.slug, (ws2) => {
    const s = stateOf(ws2, step.id);
    s.children = (s.children ?? []).filter((ch) => ch.pass !== pass);
    if (!s.children.length) delete s.children;
  });
  return [`Removed the child workstream ${slug}, in which nothing had happened.`];
}

// What the agent does now. `above` is the refusal printed above the block,
// whose reason the block does not repeat.
function stepBlock(c: Ctx, ws: Workstream, step: Step, state: StepState, above = ""): string[] {
  const lines = [`STEP ${step.id} (${position(c, step)}): ${step.instruction.replace(/\s+/g, " ").trim()}`];
  const owned = rulings(c.p);
  if (owned.length) {
    lines.push("RULINGS: where this workflow and the house rules overlap, the owner ruled:", ...owned.map((r) => `  - ${r}`));
  }
  // The owner's words with the decisions that led into this pass, so the
  // agent need not carry them over from the conversation.
  const notes = ownerNotes(state.history);
  for (const note of notes) lines.push(`OWNER SAID: "${note}"`);
  const ff = `${FUSE_FLOW} continue ${c.slug}`;

  const cond = step.condition;
  if (cond?.kind === "agent") {
    lines.push(`CONDITION: Do this step only if ${cond.text}. Otherwise run \`${ff} --skip "<why it does not apply>"\`.`);
  } else if (cond?.kind === "owner-action") {
    lines.push(
      `CONDITION: Before you start, ask the owner to ${cond.text}, and end your message with the five lines at the ` +
        `end of this block, STATUS needs input. If the owner decides to skip the step, run \`${ff} --skip "<the owner's reason>"\`; ` +
        "otherwise do the step.",
    );
  } else if (cond) {
    const ran = state.history.findLast((h) => h.includes("handed out"));
    if (ran?.includes("condition")) lines.push(`CONDITION: ${ran.slice(ran.indexOf("condition"))}, so the step runs.`);
  }
  lines.push(modeLine(c, step));

  const gate = childGate(step);
  const child = gate ? childOf(c, state, step) : undefined;
  // Why the child cannot be created or used, as continue would refuse it.
  const unusable = (check: () => void) => {
    try {
      check();
      return undefined;
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      return e.message;
    }
  };
  const reason = (why: string) => (above.includes(why) ? ", for the reason above." : `: ${why}.`);
  // Set when the child cannot be created or used, so the step cannot complete.
  let blocker: string | undefined;
  if (gate && child && !workstreamExists(c.root, child)) {
    const why = unusable(() => newChild(c, step, gate, child));
    if (why) blocker = "created";
    lines.push(
      why
        ? `DELEGATE: this step waits for workstream ${child}, which follows workflow ${refName(c, gate.text)}. It does not exist, and fuse-flow cannot create it${reason(why)}`
        : `DELEGATE: this step waits for workstream ${child}, which follows workflow ${refName(c, gate.text)}. It does not exist; fuse-flow creates it when it prints this step with \`${FUSE_FLOW} start ${c.slug}\`.`,
    );
  } else if (gate && child) {
    const why = unusable(() => checkChild(c, step, gate, child));
    if (why) blocker = "used";
    const given = Object.keys(readWorkstream(c.root, child).inputs ?? {});
    lines.push(
      why
        ? `DELEGATE: this step waits for workstream ${child}, which cannot be used${reason(why)}`
        : `DELEGATE: this step waits for workstream ${child}, which follows workflow ${refName(c, gate.text)} and was ` +
            `created for it${given.length ? `, given ${given.join(", ")}` : ""}. First run it to its end: ` +
            `\`${FUSE_FLOW} start ${child}\` prints its current step. Run it yourself or in a subagent, as suits the ` +
            "work; the owner's decisions in it are made there. Then do this step's work.",
    );
    if (!why && (cond?.kind === "agent" || cond?.kind === "owner-action")) {
      lines.push(`If this step does not apply, skip it before you start ${child}; fuse-flow then removes ${child}, since nothing has happened in it.`);
    }
  }

  for (const id of step.consumes) {
    const before = c.wf.steps.slice(0, c.wf.steps.indexOf(step)).reverse();
    const writers = before.filter(
      (s) => [...s.produces, ...s.optional_produces, ...s.updates].some((a) => a.artifact === id) || has(childGate(s)?.returns, id),
    );
    // A step that was skipped as not needed, or that finished without
    // recording the document, such as one that reported it not produced or an
    // optional producer that wrote nothing, wrote nothing: the document of an
    // earlier step that declares it stands, as for a later workstream. A
    // returned id is never passed over, since the newest child decides.
    const wroteNothing = (s: Step) => {
      if (has(childGate(s)?.returns, id)) return false;
      const st = stateOf(ws, s.id);
      return (st.status === "SKIPPED" && notNeeded(s, st)) || (st.status === "COMPLETED" && !st.artifacts.some((a) => a.artifact === id));
    };
    const source = writers.find((s) => !wroteNothing(s)) ?? writers[0];
    if (!source) {
      lines.push(inputLine(c, ws, id));
      continue;
    }
    const returned = own(childGate(source)?.returns, id);
    if (returned !== undefined) {
      lines.push(returnedLine(c, ws, source, id, returned));
      continue;
    }
    const artifact = [...source.produces, ...source.optional_produces, ...source.updates].find((a) => a.artifact === id)!;
    const path = artifactPath(c.p, artifact, c.slug, c.date);
    const sourceState = stateOf(ws, source.id);
    // The files the step recorded inside a folder artifact, which may be
    // shared with other work, also when an edit of the workflow has since
    // moved the folder.
    const records = sourceState.artifacts.filter((a) => a.artifact === id);
    const folder = sourceState.status === "COMPLETED" ? recordedFolder(records, path) : path;
    const files = records.filter((a) => a.path !== folder && contains(folder, a.path)).map((a) => a.path);
    if (sourceState.status === "SKIPPED" && notNeeded(source, sourceState)) {
      lines.push(`READ ${id}: step ${source.id} was skipped (${sourceState.skip_reason}), so there is nothing from it to read.`);
    } else if (sourceState.status === "COMPLETED" && own(sourceState.not_produced, id)) {
      lines.push(`READ ${id}: step ${source.id} did not produce it (${own(sourceState.not_produced, id)}), so there is nothing from it to read.`);
    } else if (files.length) {
      const gone = files.filter((f) => !onDisk(c, f));
      lines.push(
        `READ ${files.join(", ")} (from step ${source.id}).` +
          (gone.length ? ` Of these, ${gone.join(", ")} ${gone.length > 1 ? "do" : "does"} not exist, ${RESTORE.slice(RESTORE.indexOf("for example"))}` : ""),
      );
    } else if (sourceState.status === "COMPLETED" && (sourceState.existed ?? []).includes(path) && isFolder(c, path)) {
      // A folder shared with other work, in which the step recorded nothing.
      lines.push(`READ ${id}: step ${source.id} wrote nothing in ${path}, so there is nothing from it to read.`);
    } else if (sourceState.status === "COMPLETED" && !records.length && source.optional_produces.some((a) => a.artifact === id)) {
      // An optional producer that wrote nothing, with no earlier writer.
      lines.push(`READ ${id}: step ${source.id} wrote none, so there is nothing from it to read.`);
    } else {
      // The document the step recorded, as a later workstream reads it, also
      // when an edit of the workflow has since moved the artifact's path.
      const at = sourceState.status === "COMPLETED" && records.length === 1 ? records[0].path : path;
      lines.push(
        onDisk(c, at)
          ? `READ ${at} (from step ${source.id}).`
          : `READ ${at} (from step ${source.id}). ${RESTORE}`,
      );
    }
  }

  // What this step's child returns, for this step's own work.
  if (gate && child) {
    const complete = isComplete(c.root, child);
    for (const [id, childId] of Object.entries(gate.returns ?? {})) {
      const path = complete ? documentOf(c.root, child, childId) : undefined;
      lines.push(
        path
          ? onDisk(c, path)
            ? `READ ${path} (${id}, returned by workstream ${child}).`
            : `READ ${path} (${id}, returned by workstream ${child}). ${RESTORE}`
          : complete
            ? `RETURNS ${id}: workstream ${child} recorded no ${childId}, so there is nothing to read.`
            : `RETURNS ${id}: workstream ${child}'s ${childId}, once ${child} is complete; read it then.`,
      );
    }
  }

  const existed = new Set(state.existed ?? []);
  // An updates folder recorded whole is named on its UPDATE line; only the
  // files named in it say what the earlier pass wrote.
  const earlierFiles = (state.files ?? []).filter((f) => f.pass === "earlier" && !(f.kind === "whole" && isUpdates(step, f.artifact) && isFolder(c, f.path)));
  const earlier = unique(earlierFiles.map((f) => f.path));
  const artifactLine = (label: string, a: Placed, missingNote?: string) => {
    let line = `${label} ${a.path} (${a.artifact.artifact}).`;
    const entry = libraryEntry(c.p, a.artifact.artifact);
    if (entry?.guide) {
      line += ` Follow the process in ${display(c.p, entry.guide)}`;
      line += entry.template ? ` and use the structure of ${display(c.p, entry.template)}.` : ".";
    } else if (entry?.guideMissing) {
      line +=
        ` Its guide is missing (${display(c.p, entry.guideMissing)} cannot be read); ask the owner whether to continue ` +
        "without it, install it and run this command again, or use another workflow.";
      if (entry.template) line += ` Use the structure of ${display(c.p, entry.template)}.`;
    } else if (entry?.template) {
      line += ` Use the structure of ${display(c.p, entry.template)}.`;
    }
    if (missingNote) line += ` ${missingNote}`;
    return line;
  };
  const declared = declaredOf(c, step);
  const nameFlag = (a: Placed) => fileFlag(c, step, a);
  for (const a of place(c, step.produces)) {
    let note: string | undefined;
    const folder = isFolder(c, a.path);
    if (existed.has(a.path) && earlierFiles.some((f) => f.artifact === a.artifact.artifact)) {
      note = `${a.path} existed before this workstream; the files this workstream wrote in it are listed under EARLIER PASS.`;
      if (folder) note += ` Name each file you write in it with ${nameFlag(a)}.`;
    } else if (existed.has(a.path) && folder) {
      // A folder that existed, such as a research folder shared with other
      // work: the step adds files of its own to it.
      note =
        `${a.path} already existed when the step was handed out, and may hold other work. Write the step's files in ` +
        `it, and name each file you write in it with ${nameFlag(a)}.`;
    } else if (existed.has(a.path)) {
      note =
        `${a.path} already existed when the step was handed out, and this workstream did not write it. Do what ` +
        "the instruction or the guide says about it; if they say nothing, judge whether to ask the owner to " +
        "update it, replace it, or use a different path.";
    }
    lines.push(artifactLine("PRODUCE", a, note));
  }
  for (const a of place(c, step.optional_produces)) {
    const shared = existed.has(a.path) && isFolder(c, a.path);
    lines.push(artifactLine("PRODUCE (optional)", a, shared ? `${a.path} existed before the step; name each file you write in it with ${nameFlag(a)}.` : undefined));
  }
  for (const a of place(c, step.updates)) {
    lines.push(
      artifactLine("UPDATE", a, onDisk(c, a.path) ? undefined : `${a.path} does not exist yet; create it and report it with --updated.`),
    );
  }
  // A file in the paths of two artifacts does not say which it counts for.
  const nested = declared.flatMap((inner, i) =>
    declared
      .filter((outer, j) => outer.artifact.artifact !== inner.artifact.artifact && contains(outer.path, inner.path) && (j < i || tidy(outer.path) !== tidy(inner.path)))
      .map((outer) => `${inner.path} (${inner.artifact.artifact}) lies inside ${outer.path} (${outer.artifact.artifact})`),
  );
  if (nested.length) {
    lines.push(`FILES IN TWO ARTIFACTS: ${nested.join("; ")}. Name a file there with --updated <artifact>=<file>, once for each artifact it counts for.`);
  }
  if (earlier.length) {
    lines.push(
      `EARLIER PASS: this step ran before the owner sent the work back, and wrote ${earlier.join(", ")}. Check each ` +
        (notes.length
          ? "against what changed since. Follow the owner's notes where they decide what happens to a file; for the " +
            "files they do not mention, keep it, update it, or redo it, and propose to the owner which."
          : "against what changed since: keep it, update it, or redo it, and propose to the owner which."),
    );
  }

  const reviewed = place(c, [...step.produces, ...step.optional_produces, ...step.updates]);
  const guides = new Guides();
  for (const a of reviewed) guides.addAuthoring(libraryEntry(c.p, a.artifact.artifact));
  // A step instruction may deliberately depart from a shared guide; say which
  // wins. A guide the owner or the project put in place is a house rule.
  if (guides.any()) lines.push(`GUIDES: ${guidePrecedence(c, guides, "author")}`);
  lines.push("WHEN THE WORK IS DONE:");
  let n = 0;
  // Reviews run in list order, so the agent reached the latest review the
  // owner accepted only after the reviews before it had passed in this pass.
  const accepted = state.accepted_gates ?? [];
  const lastAccepted = Math.max(0, ...accepted);
  for (const g of gatesInOrder(step)) {
    if (g.kind === "workflow") {
      lines.push(
        blocker
          ? `  ${++n}. Workstream ${child} cannot be ${blocker}, so this step cannot complete until that is resolved. If you cannot resolve it, ` +
              `report the step blocked: run \`${ff} --blocked "<the reason>"\`, so the owner decides.`
          : `  ${++n}. Make sure workstream ${child} is complete. fuse-flow checks it on continue and refuses the step until it is.`,
      );
    } else if (g.kind === "check" || g.kind === "script") {
      const m = mechanical(c, g);
      const again = "fuse-flow runs it again on continue and refuses the step while it fails.";
      if (m.kind === "run") {
        const what = g.kind === "check" ? `, the project's ${g.text} check (bound in ${display(c.p, checkBinding(c.p, g.text)!.file)})` : "";
        lines.push(`  ${++n}. Run \`${byHand(c, step, m.command)}\`${what}. Fix the work, or the check if the check is wrong, until it passes. ${again}`);
      } else if (m.kind === "none") {
        lines.push(`  ${++n}. The ${g.text} check is not configured in this project (bound to none in ${m.file}); there is nothing to run.`);
      } else {
        lines.push(`  ${++n}. ${bindInstruction(c, m.check)} Then run it and fix the work until it passes. ${again}`);
      }
    } else if (g.kind === "agent") {
      ++n;
      lines.push(
        accepted.includes(n)
          ? `  ${n}. The owner accepted this review (${g.text}) as it was; do not run it again.`
          : n < lastAccepted
            ? `  ${n}. This review (${g.text}) passed earlier in this pass; do not run it again.`
            : `  ${n}. ${reviewText(c, ws, g, step, state, reviewed, n, notes.length > 0)}`,
      );
    }
  }

  let last = `  ${++n}. Run \`${ff}\``;
  const updates = step.updates.map((a) => a.artifact);
  const produces = step.produces.map((a) => a.artifact);
  const parts: string[] = [];
  // With one artifact the hint names its id, so the agent can copy the flag as printed.
  if (updates.length) {
    const flag = `--unchanged ${updates.length === 1 ? updates[0] : "<artifact>"} "<reason>"`;
    const which = updates.length === 1 ? `if you left ${updates[0]} as it was` : `for each of ${updates.join(", ")} that you left as it was`;
    parts.push(`with --updated <file> for each file you revised (repeat it), and ${flag} ${which}`);
  }
  if (produces.length) {
    const flag = `--not-produced ${produces.length === 1 ? produces[0] : "<artifact>"} "<reason>"`;
    const which = produces.length === 1 ? `if you rightly did not write ${produces[0]}` : `for each of ${produces.join(", ")} that you rightly did not write`;
    parts.push(`with ${flag} only ${which}`);
  }
  if (parts.length) last += `, ${parts.join("; and ")}`;
  last += ".";
  const owner = ownerGates(step);
  if (owner.length) {
    last += ` The step then waits for the owner to ${owner.map((g) => g.text).join(", and to ")}.`;
    const routes = routesBack(step);
    if (routes.length) last += ` If the owner rejects it, suggest sending the work back to ${routes.join(" or ")}.`;
  }
  lines.push(last);
  lines.push(...stopEarly(c, ws, step));
  return lines;
}

// How the agent hands back to the owner while the step is still in progress:
// it waits for an answer, or the owner paused the work.
// `otherwise` replaces the advice for a step the agent cannot finish at all.
function stopEarly(c: Ctx, ws: Workstream, step: Step, otherwise = "If you cannot finish the step at all, report it blocked instead."): string[] {
  const reviews = step.gates.filter((g) => g.kind === "agent").length > 0;
  return [
    `IF YOU STOP BEFORE THE STEP IS DONE: end your message with these five lines, written for the owner, with each <...> part replaced. ${otherwise}`,
    `  SUMMARY: <the task, in a sentence>. Workstream ${c.slug}, step ${step.id}, ${position(c, step)}.${skippedSteps(c, ws)}`,
    "  STATUS: <needs input, when you need an answer or a decision from the owner; paused, when the work only " +
      "waits for the owner's request to continue>",
    "  PRODUCED: <the files written or changed so far, and why any artifact will not be written; or none>",
    `  VERIFICATION: <the check results so far${reviews ? ", the review rounds used of the cap, and any required fix still open" : ""}; or none>`,
    "  NEXT STEP: <two to four options for the owner, your recommendation first, with its reason>",
  ];
}

// ---------------------------------------------------------------- decisions
// The agent records the decisions it makes on its own in one file per
// workstream. fuse-flow never reads that file: it prints the MODE line, and
// works out from the history alone when the owner has not yet seen the
// decisions of some finished work.

const decisionPath = (c: Ctx, slug: string) => display(c.p, decisionsFile(c.root, slug));

function decisionGuide(c: Ctx): string | undefined {
  const guide = libraryEntry(c.p, "decision-log")?.guide;
  return guide ? display(c.p, guide) : undefined;
}

// How the step runs. A step without a mode is attended.
function modeLine(c: Ctx, step: Step): string {
  const guide = decisionGuide(c);
  const record = `${decisionPath(c, c.slug)}${guide ? `, following ${guide}` : ""}`;
  const precedence =
    "Where the step's instruction sets how the whole step runs, such as an interactive or an automatic mode, " +
    "follow it and treat the step as attended or unattended accordingly, also where a guide has a branch for " +
    "unattended steps; a single question or decision the instruction names is an exception within this mode.";
  if (step.mode === "unattended") {
    return (
      "MODE: unattended. Decide on your own judgement, with the instruction and the documents this block names " +
      "as the authority; ask the owner only before an irreversible action, one that reaches outside this " +
      `checkout, or where the instruction asks for the owner. Record every decision the owner should see in ${record}. ` +
      `The owner can leave until the next owner gate. ${precedence}`
    );
  }
  return (
    "MODE: attended. Ask the owner often, one question at a time, about anything you cannot settle from the work. " +
    `Record each decision you make without asking in ${record}. The owner stays with the session during this step. ${precedence}`
  );
}

// The latest time the agent finished a stretch of work, and the latest time
// the owner acted on a hand-over: moved a step on from AWAITING_OWNER or
// BLOCKED, where only the owner can. ISO timestamps; "" when there is none.
function decisionTimes(ws: Workstream): { work: string; review: string } {
  let work = "";
  let review = "";
  for (const e of runEvents(ws)) {
    if (!e.time) continue;
    if (e.kind === "awaiting-owner" || e.kind === "completed" || e.kind === "blocked") {
      if (e.time > work) work = e.time;
    } else if ((e.from === "AWAITING_OWNER" || e.from === "BLOCKED") && e.to !== e.from) {
      if (e.time > review) review = e.time;
    }
  }
  return { work, review };
}

interface OpenDecisions {
  slug: string;
  // For a descendant workstream: the step of this workstream that delegated
  // to it, directly or through its own children.
  via?: string;
}

// The decisions files with work the owner has not yet reviewed: this
// workstream's own, and each descendant's whose latest work is later than the
// latest review in it and in every workstream above it.
function openDecisions(c: Ctx, ws: Workstream): OpenDecisions[] {
  const own = decisionTimes(ws);
  const above = ancestorReview(c, ws);
  const floor = above > own.review ? above : own.review;
  const open: OpenDecisions[] = own.work > floor ? [{ slug: c.slug }] : [];
  const seen = new Set([c.slug]);
  const descend = (w: Workstream, floor: string, via: string | undefined) => {
    for (const [stepId, state] of Object.entries(w.steps)) {
      for (const ch of state.children ?? []) {
        if (seen.has(ch.slug) || !workstreamExists(c.root, ch.slug)) continue;
        seen.add(ch.slug);
        let child: Workstream;
        try {
          child = readWorkstream(c.root, ch.slug);
        } catch {
          continue;
        }
        const t = decisionTimes(child);
        const below = t.review > floor ? t.review : floor;
        if (t.work > below) open.push({ slug: ch.slug, via: via ?? stepId });
        descend(child, below, via ?? stepId);
      }
    }
  };
  descend(ws, floor, undefined);
  return open;
}

// The latest review in the workstreams above `ws`, its parent and theirs: a
// review there covers the work delegated to `ws` too. "" when there is none.
function ancestorReview(c: Ctx, ws: Workstream): string {
  let review = "";
  const seen = new Set([c.slug]);
  for (let parent = ws.parent; parent && !seen.has(parent.slug) && workstreamExists(c.root, parent.slug); ) {
    seen.add(parent.slug);
    let above: Workstream;
    try {
      above = readWorkstream(c.root, parent.slug);
    } catch {
      break;
    }
    const t = decisionTimes(above).review;
    if (t > review) review = t;
    parent = above.parent;
  }
  return review;
}

// The DECISIONS line, or nothing when no decisions await review. It is the
// only line the decisions add to a hand-over block: the agent finds how to
// carry out the owner's response in the decision-log guide, and the block's
// existing send-back command does the rest.
function decisionLines(c: Ctx, ws: Workstream, complete: boolean): string[] {
  const open = openDecisions(c, ws);
  if (!open.length) return [];
  // The printing workstream's own file always comes first, also when only a
  // descendant's work opened the line.
  if (open[0].slug !== c.slug) open.unshift({ slug: c.slug });
  const files = open
    .map((o) => (o.via ? `${decisionPath(c, o.slug)} (workstream ${o.slug}, delegated by step ${o.via})` : decisionPath(c, o.slug)))
    .join(", and ");
  const change = complete
    ? "A change is made in a new workstream that follows on from this one."
    : "A change goes back to the step whose work it changes, or to the step that delegated that work, so its checks and reviews run again.";
  return [
    `DECISIONS: <how many decisions are open, or none recorded>, in ${files}. The owner can accept them as they ` +
      `are, comment inline in the file, ask for changes here, or have you walk through them one by one. ${change}`,
  ];
}

// The skipped steps with their reasons, for the SUMMARY line, or nothing.
function skippedSteps(c: Ctx, ws: Workstream): string {
  const skips = c.wf.steps
    .map((s) => ({ s, state: stateOf(ws, s.id) }))
    .filter(({ state }) => state.status === "SKIPPED")
    .map(({ s, state }) => `${s.id} (${state.skip_reason ?? "no reason recorded"})`);
  return skips.length ? ` Skipped steps: ${skips.join("; ")}.` : "";
}

function capOf(c: Ctx, g: Gate, state: StepState): string {
  const cap = maxRounds(c.p, g);
  const granted = state.rounds_granted ?? 0;
  return granted ? `${cap + granted} (${cap} plus ${granted} granted by the owner)` : `${cap}`;
}

// The guides that apply to a step, split by where each was found: in the
// owner's or the project's own library or policy, or shipped with fuse or the
// workflow.
class Guides {
  readonly owned: string[] = [];
  readonly shipped: string[] = [];
  private add(path: string, owners: boolean) {
    const list = owners ? this.owned : this.shipped;
    if (!list.includes(path)) list.push(path);
  }
  addAuthoring(entry: { level: string; guide?: string } | undefined) {
    if (entry?.guide) this.add(entry.guide, entry.level !== "package");
  }
  addReview(p: Project, found: Parameters<typeof ownersReviewGuide>[1] | undefined, gate: Gate) {
    if (found) this.add(found.path, ownersReviewGuide(p, found, gate));
  }
  any() {
    return this.owned.length + this.shipped.length > 0;
  }
}

// Which wins where a step instruction and a guide disagree: the instruction,
// over a guide that ships with fuse or the workflow; a guide the owner or the
// project put in place is a house rule, settled as the always-on block says.
function guidePrecedence(c: Ctx, guides: Guides, who: "author" | "reviewer"): string {
  const owned = guides.owned;
  const shipped = guides.shipped.length > 0;
  if (!owned.length) {
    return who === "author"
      ? "where the step instruction above and a guide disagree, follow the instruction, and name each disagreement in your hand-over block."
      : "where it and a guide disagree, the instruction wins, so following the instruction is not a required fix.";
  }
  const names = owned.map((g) => display(c.p, g)).join(", ");
  const they = owned.length > 1 ? `The guides ${names} come from this project's or the owner's own library or policy, so they are house rules` : `The guide ${names} comes from this project's or the owner's own library or policy, so it is a house rule`;
  if (who === "author") {
    return (
      `${shipped ? "where the step instruction above and a guide that ships with fuse disagree, follow the instruction. " : ""}` +
      `${they}: where the step instruction disagrees with ${owned.length > 1 ? "one" : "it"}, follow the owner's ruling, ` +
      "else the guide when it clearly applies, and ask the owner when it is unclear. Name each disagreement in your hand-over block."
    );
  }
  return (
    `${shipped ? "where it and a guide that ships with fuse disagree, the instruction wins, so following the instruction is not a required fix. " : ""}` +
    `${they}: where the instruction disagrees with ${owned.length > 1 ? "one" : "it"}, report the disagreement, and the ` +
    "author settles it with the owner's ruling or the house rules; it is not a required fix by itself."
  );
}

// The same cap, as the status view shows it.
function statusCap(c: Ctx, g: Gate, state: StepState): string {
  const cap = maxRounds(c.p, g);
  const granted = state.rounds_granted ?? 0;
  return granted ? `${cap + granted}, ${cap} plus ${granted} granted` : `${cap}`;
}

// Where a review gate's reviewer writes its findings, with <n> for the round.
// With several reviews, the file carries the review's number in the step
// block's list, the number --gate takes.
function findingsFile(c: Ctx, g: Gate, step: Step, state: StepState): string {
  const agentGates = step.gates.filter((x) => x.kind === "agent");
  const gateName = agentGates.length > 1 ? `-gate${gateNumber(step, g)}` : "";
  return `${display(c.p, reviewsDir(c.root, c.slug))}/${step.id}${gateName}${state.pass ? `-pass-${state.pass}` : ""}-round-<n>.json`;
}

// `n` is the gate's number in the step block's list; `notes` whether the
// owner gave notes in this pass.
function reviewText(c: Ctx, ws: Workstream, g: Gate, step: Step, state: StepState, reviewed: Placed[], n: number, notes: boolean): string {
  let text = `Have an independent agent ${g.text.replace(/\.$/, "")}.`;
  const guided: string[] = [];
  const parts: string[] = [];
  const authoring: string[] = [];
  const precedence = new Guides();
  for (const a of reviewed) {
    // Every artifact's authoring guide counts for precedence, whether or not a
    // review guide replaces it as the reviewer's checklist.
    precedence.addAuthoring(libraryEntry(c.p, a.artifact.artifact));
    precedence.addReview(c.p, reviewGuideSource(c.p, g, a.artifact.artifact), g);
    const guide = reviewGuide(c.p, g, a.artifact.artifact);
    if (guide) {
      guided.push(guide);
      parts.push(`${a.path} against ${display(c.p, guide)}`);
    } else {
      const own = libraryEntry(c.p, a.artifact.artifact)?.guide;
      if (own) authoring.push(own);
      parts.push(own ? `${a.path}, with its guide ${display(c.p, own)} as the definition of a good artifact` : a.path);
    }
  }
  if (reviewed.length === 0) {
    const guide = reviewGuide(c.p, g, undefined);
    precedence.addReview(c.p, reviewGuideSource(c.p, g, undefined), g);
    if (guide) {
      guided.push(guide);
      text += ` Follow the review guide ${display(c.p, guide)}.`;
    }
  } else {
    text += ` It reviews ${parts.join("; ")}.`;
  }
  text += baseSentence(c, ws);
  const who = reviewer(c.p);
  if (who) text += ` The reviewer: ${who}.`;
  const how = launch(c.p);
  const table = Object.entries(reviewers(c.p));
  const same = (a: Launch, b: Launch) => JSON.stringify(a) === JSON.stringify(b);
  // A row's launch goes without saying only when a policy file sets the same
  // launch for every reviewer; without one, the default defers to the house
  // rules, so a row's explicit launch, even subagent, is printed.
  const set = launchSetting(c.p);
  const ownLaunch = (l: Launch | undefined): l is Launch => l !== undefined && !(set !== undefined && same(l, set));
  const startedBy = (l: Launch) => (l === "subagent" ? "as a fresh subagent in your own harness" : `with \`${l.command}\``);
  // No policy file sets the launch: the house rules may name another way,
  // such as another harness on the command line.
  const defaultStart = launchSetting(c.p) === undefined
    ? "the way the house rules ask, such as a review command they name, or else as a fresh subagent in your own harness"
    : startedBy(how);
  if (table.length) {
    const rows = table.map(([author, r]) => {
      const row = `if you run on ${author}, ${r.model}${r.effort ? ` at ${r.effort} effort` : ""}`;
      return ownLaunch(r.launch) ? `${row}, started ${startedBy(r.launch)}` : row;
    });
    text += ` Pick the reviewer's model by the model you run on: ${rows.join("; ")}. If yours is not listed, follow the review guide.`;
  }
  const rowLaunches = table.flatMap(([, r]) => (ownLaunch(r.launch) ? [r.launch] : []));
  text += ` ${rowLaunches.length ? "Unless its row says otherwise, start" : "Start"} the reviewer ${defaultStart}, with none of your context.`;
  if (how !== "subagent" || rowLaunches.some((l) => l !== "subagent")) {
    text +=
      " In a launch command, replace {model} and {effort} with the reviewer's, {prompt_file} with a file you " +
      "write the review request to, and {findings_file} with the findings file.";
  }
  const dir = display(c.p, reviewsDir(c.root, c.slug));
  const findings = findingsFile(c, g, step, state);
  text +=
    ` The reviewer writes its findings to ${findings}, where <n> is the round, following ` +
    `${display(c.p, FINDINGS_SCHEMA)}; read them from there.`;
  // The three classes of the fuse review guide, so a valid P2 or P3 finding
  // is not taken for a required fix that costs another round.
  const levels =
    "a P0 or P1 finding you have checked is a required fix; a P2 or P3 finding is optional: fix it when the fix " +
    "is cheap, and list the rest as deferred in the hand-over.";
  text +=
    " Classify each finding as a required fix, optional or a false positive, with the reason; a finding the owner " +
    "already accepted or deferred is not a required fix. " +
    (guided.length
      ? `The review guide decides what counts as a required fix and when a round passes; where it does not say, ${levels}`
      : capitalize(levels)) +
    " Fix what is required and review again, until a round ends with no required fix. That round passes and ends " +
    "the review: fixing optional findings after it starts no further round.";
  if (guided.length || authoring.length) {
    text += ` Give the reviewer the step instruction as well: ${guidePrecedence(c, precedence, "reviewer")}`;
  }
  if (notes) text += " Give the reviewer the owner's notes as well.";
  if (state.pass) {
    text +=
      ` This is pass ${state.pass} of this step, because the owner sent the work back: count only this pass's rounds ` +
      "against the cap. The review covers the whole artifact. Give the reviewer the findings files of the earlier " +
      `passes of this step, in ${dir}/, with how each finding was handled.`;
  }
  // The same rule, in the same words, as the fuse review guide's.
  text +=
    " Every round that ends with a required fix counts, whatever the cause. After " +
    `${capOf(c, g, state)} such rounds, make the last round's fixes anyway, start no further review, and report the ` +
    `step blocked, naming the fixes no reviewer has seen: run \`${FUSE_FLOW} continue ${c.slug} --blocked ` +
    `"<what is still open, and the fixes no reviewer has seen>" --gate ${n}\`.`;
  return text;
}

// The PRODUCED line: the files the step created or changed, and the reasons
// for what it left out.
function producedLine(c: Ctx, step: Step, state: StepState): string {
  const existed = new Set(state.existed ?? []);
  const files: string[] = [];
  const listed: string[] = [];
  for (const a of state.artifacts) {
    if (isUpdates(step, a.artifact)) continue; // listed by file below
    files.push(`${a.path} (${existed.has(a.path) ? "updated" : "new"})`);
    listed.push(a.path);
  }
  // The files the agent named that are not documents of their own: revisions
  // of an updates artifact, and files outside every declared path. One that
  // is also a produced document, or lies in a produced folder listed whole,
  // is listed once, as that.
  const reported = (state.files ?? []).filter((f) => f.pass === "this" && f.kind === "file" && (f.artifact === undefined || isUpdates(step, f.artifact)));
  const shown = new Set<string>();
  for (const f of reported) {
    if (shown.has(f.path) || listed.some((p) => contains(p, f.path))) continue;
    shown.add(f.path);
    files.push(f.artifact === undefined ? `${f.path} (updated, outside the declared paths)` : `${f.path} (updated)`);
  }
  const parts: string[] = [];
  // A folder recorded whole is listed by name and not counted as a file.
  const pathOf = (entry: string) => entry.split(" (")[0];
  const plain = files.filter((f) => !isFolder(c, pathOf(f)));
  if (plain.length >= 5) {
    // The deepest folder that holds them all, or none: files outside the
    // repository are shown absolute, so a mix of those and repository files
    // has no common folder, and the ascent stops at the filesystem root.
    const dirs = plain.map((f) => dirname(pathOf(f)));
    const holdsAll = (dir: string) => dirs.every((d) => d === dir || d.startsWith(dir.endsWith("/") ? dir : `${dir}/`));
    let common: string | undefined = dirs[0];
    while (common !== undefined && common !== "." && !holdsAll(common)) {
      const up = dirname(common);
      common = up === common ? undefined : up;
    }
    const under = common === undefined || common === "." ? "" : ` under ${common.endsWith("/") ? common : `${common}/`}`;
    parts.push(
      ...files.filter((f) => !plain.includes(f)),
      `${plain.length} files${under}; summarize them, for example "12 files under src/checkout/, with their tests"`,
    );
  } else {
    parts.push(...files);
  }
  for (const [id, why] of Object.entries(state.not_produced ?? {})) parts.push(`${id} not produced (${why})`);
  for (const [id, why] of Object.entries(state.unchanged ?? {})) parts.push(`${id} unchanged (${why})`);
  return `PRODUCED: ${parts.join("; ") || "none"}`;
}

function verificationLine(c: Ctx, step: Step, state: StepState): string {
  const mechanicalGates = gatesInOrder(step).filter((g) => g.kind === "workflow" || g.kind === "check" || g.kind === "script");
  const notRun = (g: Gate) => (g.kind === "workflow" ? `workstream ${childOf(c, state, step)}: not checked` : `${mechanical(c, g).label}: not run`);
  const parts = state.verification ? [...state.verification] : mechanicalGates.map(notRun);
  // A child recorded complete that has become unfinished since is not
  // complete now.
  const pending = state.verification && waitingFor(c, step);
  if (pending) {
    for (const [i, part] of parts.entries()) {
      if (part.startsWith(`workstream ${pending.slug} (`) && part.endsWith("): complete")) parts[i] = `${part} when the step's work was recorded; now ${pending.why}`;
    }
  }
  for (const g of gatesInOrder(step)) {
    if (g.kind === "agent") parts.push(reviewResult(c, g, step, state, "<any required fix still open, and any fix made after the last review, which no reviewer has seen>"));
  }
  return `VERIFICATION: ${parts.join("; ") || "none"}`;
}

// A review gate's part of a VERIFICATION line, with `rest` after the rounds.
function reviewResult(c: Ctx, g: Gate, step: Step, state: StepState, rest: string): string {
  if ((state.accepted_gates ?? []).includes(gateNumber(step, g))) return `review (${g.text}): accepted by the owner as it was`;
  return `review (${g.text}): <rounds used> of ${capOf(c, g, state)} rounds, ${rest}`;
}

function stepsWithArtifacts(c: Ctx, step: Step): string {
  return c.wf.steps
    .slice(0, c.wf.steps.indexOf(step) + 1)
    .map((s) => {
      const paths = place(c, [...s.produces, ...s.updates]).map((a) => a.path);
      return paths.length ? `${s.id} (${paths.join(", ")})` : s.id;
    })
    .join(", ");
}

// When it is the owner's turn: the hand-over block, pre-filled.
function handOver(c: Ctx, ws: Workstream, step: Step | undefined): string[] {
  const skipped = skippedSteps(c, ws);
  const intro =
    "OWNER'S TURN: end your message with this hand-over block. Replace each <...> part, keep the lines in this " +
    "order, and give the owner's options with your recommendation first, with its reason. Write the block for " +
    "the owner: name steps, phases and artifacts in plain words, and leave out fuse-flow, its commands and the " +
    "workstream's state file unless the owner asks how the workflow works.";

  if (!step) {
    const done = c.wf.steps.filter((s) => stateOf(ws, s.id).status === "COMPLETED");
    const produced = done.map((s) => `${s.id}: ${producedLine(c, s, stateOf(ws, s.id)).replace(/^PRODUCED: /, "")}`).filter((l) => !l.endsWith(": none"));
    const verified = done.flatMap((s) => (stateOf(ws, s.id).verification ?? []).map((v) => `${s.id}: ${v}`));
    // The engine prints each review's cap; the agent counts the rounds it used.
    const reviews = done.flatMap((s) => {
      const state = stateOf(ws, s.id);
      return s.gates
        .filter((g) => g.kind === "agent")
        .map((g) => `${s.id}: ${reviewResult(c, g, s, state, `counted from the findings files of the step's last pass, ${findingsFile(c, g, s, state)}`)}`);
    });
    const handOffs = c.wf.hands_off_to;
    const next = handOffs.length
      ? `NEXT STEP: <what the owner may want next, with the workflow that comes after this one where it applies: ${handOffs
          .map((h) => `${refName(c, h.workflow)}${h.when ? ` (${h.when})` : ""}`)
          .join("; or ")}>`
      : "NEXT STEP: <what the owner may want next, for example reviewing or landing the work>";
    const forYou: string[] = [];
    for (const h of handOffs) {
      // A `when` can rule a hand-off out, such as a pull request workflow in a
      // project with no pull requests; then the owner is not asked at all.
      const offer = h.when
        ? `This workflow hands off to ${refName(c, h.workflow)}, ${h.when}. Offer it to the owner where that applies, and do not mention it where it does not`
        : `This workflow hands off to ${refName(c, h.workflow)}. Offer it to the owner`;
      forYou.push(
        `  - ${offer}; start it only once the owner agrees, with \`${FUSE_FLOW} start <new-slug> --workflow ${shellQuote(h.workflow)} --after ${c.slug}\`, ` +
          "which gives it this workstream's documents.",
      );
    }
    if (ws.parent) {
      const gone = parentGone(c.root, c.slug, ws.parent);
      forYou.push(
        gone
          ? `  - Step ${ws.parent.step} of workstream ${ws.parent.slug} no longer waits for this workstream: ${gone}. Tell the ` +
              "owner, who decides whether this workstream's work is still needed there."
          : `  - Step ${ws.parent.step} of workstream ${ws.parent.slug} waits for this workstream. Go on there: ` +
              `\`${FUSE_FLOW} start ${ws.parent.slug}\` prints that step, with what this workstream returns to it.`,
      );
    }
    const decisions = decisionLines(c, ws, true);
    return [
      intro,
      "",
      `SUMMARY: <the work, in a sentence>. Workstream ${c.slug}, all ${c.wf.steps.length} steps of ${c.wf.name}.${skipped}`,
      "STATUS: workflow complete",
      `PRODUCED: ${produced.join("; ") || "none"}`,
      `VERIFICATION: ${[...verified, ...reviews].join("; ") || "none"}`,
      next,
      ...decisions,
      ...(forYou.length ? ["", "FOR YOU, NOT FOR THE OWNER:", ...forYou] : []),
    ];
  }

  const state = stateOf(ws, step.id);
  const ff = `${FUSE_FLOW} continue ${c.slug}`;
  const routes = routesBack(step);
  // The first step has no earlier step; the owner can still send the work
  // back to the step itself.
  const backOption =
    (c.wf.steps.indexOf(step) === 0 ? "Send the work back to redo this step, with what to change" : "Send the work back to an earlier step, with what to change") +
    (routes.length ? `; the step's gates suggest ${routes.join(" or ")}` : "") +
    ".";
  const backCommand =
    `The owner sends the work back: run \`${ff} --back-to <step> --note "<the owner's decision>"\`. ` +
    `To rework an artifact, name the step that produces it: ${stepsWithArtifacts(c, step)}.`;
  const lines = [
    intro,
    "",
    `SUMMARY: <the task you worked on, in a sentence>. Workstream ${c.slug}, step ${step.id}, ${position(c, step)}.${skipped}`,
  ];
  const commands: string[] = [];
  if (state.status === "AWAITING_OWNER") {
    // A workflow edited while the step waited may no longer name the owner's action.
    const asks = ownerGates(step).map((g) => g.text).join(", and ") || "approve the step's work";
    // A child that became unfinished, such as when its workflow gained a
    // step, holds the approval back, as continue --owner-approved does.
    const pending = waitingFor(c, step);
    lines.push(
      `STATUS: awaiting owner action. The owner is asked to ${asks}.${pending ? ` It cannot be approved yet: ${pending.why}.` : ""}`,
      producedLine(c, step, state),
      verificationLine(c, step, state),
      "NEXT STEP:",
    );
    if (pending) {
      // Only this pass's own unfinished child can be finished to satisfy the
      // gate; a missing or unusable one needs the recovery its reason names.
      const approval = `then run \`${FUSE_FLOW} start ${c.slug}\` for the owner's approval.`;
      if (pending.child === "unfinished") {
        lines.push(`  - Finish workstream ${pending.slug} first, then ${asks}.`);
        commands.push(
          `  - The owner has workstream ${pending.slug} finished first: run \`${FUSE_FLOW} start ${pending.slug}\`, which prints its current step, ` +
            `and run it to its end; ${approval}`,
        );
      } else if (pending.child === "missing") {
        lines.push(`  - Restore workstream ${pending.slug}, or send the work back to this step for a new child workstream, then ${asks}.`);
        commands.push(
          `  - The owner has workstream ${pending.slug} restored: restore \`${relative(c.root, workstreamFile(c.root, pending.slug))}\` ` +
            `from version control or a backup, ${approval}`,
        );
      } else {
        lines.push(`  - Correct what holds the approval back, as the status says, then ${asks}.`);
        commands.push(`  - The owner has what holds the approval back corrected: do what the status above says, ${approval}`);
      }
      lines.push(`  - Skip this step, without what workstream ${pending.slug} would return.`);
      commands.push(`  - The owner skips the step: run \`${ff} --skip "<the owner's reason>"\`.`);
    } else {
      lines.push(`  - ${capitalize(asks)}.`);
      commands.push(`  - The owner does what the step asks (${asks}): run \`${ff} --owner-approved --note "<what the owner said>"\`.`);
    }
    lines.push(`  - ${backOption}`);
    commands.push(`  - ${backCommand}`);
  } else {
    const why = state.history.findLast((h) => h.includes("blocked"))?.replace(/^\S+ /, "") ?? "blocked";
    const pending = waitingFor(c, step);
    lines.push(`STATUS: blocked. ${why}`, producedLine(c, step, state), verificationLine(c, step, state), "NEXT STEP:");
    if (pending) {
      lines.push(`  - Skip this step, without what workstream ${pending.slug} would return.`);
      commands.push(`  - The owner skips the step: run \`${ff} --skip "<the owner's reason>"\`.`);
    } else {
      // Accepting the step completes it, so the gates not yet passed never
      // run; the options name them. When the agent said which review it was
      // blocked at, the owner can accept that review alone instead.
      const gates = gatesInOrder(step);
      const open = (i: number) => gates[i].kind !== "owner-action" && !(state.accepted_gates ?? []).includes(i + 1);
      const at = state.blocked_gate;
      const passed = (g: Gate) =>
        g.kind === "workflow" ||
        ((g.kind === "check" || g.kind === "script") &&
          (state.verification ?? []).some((v) => v === `${mechanical(c, g).label}: passed` || v === `${mechanical(c, g).label}: not configured in this project`));
      const skipped = gates.filter((g, i) => open(i) && (at === undefined ? !passed(g) : i >= at)).map((g) => gateLabel(c, step, state, g));
      // Accepting the whole step also completes it without the owner's actions.
      const owners = ownerGates(step).map((g) => gateLabel(c, step, state, g));
      const bypassed = [...skipped, ...owners];
      const reaches = owners.length ? `awaits the owner action${owners.length > 1 ? "s" : ""}: ${owners.join(", and ")}` : "";
      const accept = `run \`${ff} --owner-approved --note "<the owner's decision>"\``;
      if (at !== undefined) {
        // Accepting the review alone hands the step back to the agent even
        // when no gate is ahead: its plain continue still reruns the checks,
        // records the work and reaches any owner action.
        lines.push(
          skipped.length
            ? `  - Accept this review as it is, and go on with the gates still ahead: ${skipped.join(", ")}${reaches && `; the step then ${reaches}`}.`
            : `  - Accept this review as it is, and finish the step${reaches && `; it then ${reaches}`}.`,
          bypassed.length ? `  - Accept the whole step as it is, without the gates still ahead: ${bypassed.join(", ")}.` : "  - Accept the whole step as it is.",
        );
        commands.push(
          `  - The owner accepts this review as it is: run \`${ff} --owner-approved --gate ${at} --note "<the owner's decision>"\`.`,
          `  - The owner accepts the whole step as it is: ${accept}.`,
        );
      } else if (!bypassed.length) {
        lines.push("  - Accept the step as it is.");
        commands.push(`  - The owner accepts the step as it is: ${accept}.`);
      } else {
        lines.push(`  - Accept the whole step as it is, without the gates not recorded as passed: ${bypassed.join(", ")}.`);
        commands.push(`  - The owner accepts the step as it is: ${accept}.`);
      }
    }
    if (step.gates.some((g) => g.kind === "agent")) {
      lines.push("  - Allow more review rounds, and how many.");
      commands.push(`  - The owner grants more review rounds: run \`${ff} --more-rounds <n> --note "<the owner's decision>"\`.`);
    }
    lines.push(`  - ${backOption}`);
    commands.push(`  - ${backCommand}`);
  }
  return [
    ...lines,
    ...decisionLines(c, ws, false),
    "",
    "FOR YOU, NOT FOR THE OWNER: once the owner has decided, run the matching command.",
    ...commands,
  ];
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

// --------------------------------------------------------------------- start
// Mint a workstream that follows `workflowRef` (a workflow name or an
// absolute path), or resume the one that exists. Either way it prints the
// current step, so an agent that lost its context can pick the work up here.
// `from` starts a new workstream at a later step, as the owner's decision.
// `after` names the earlier workstream whose documents bind this one's
// inputs; `inputs` binds inputs to files (absolute paths) and wins over it.

export interface StartLinks {
  after?: string;
  inputs: Record<string, string>;
}

export function start(root: string, slug: string, workflowRef?: string, from?: string, given: StartLinks = { inputs: {} }): string[] {
  const resumed = workstreamExists(root, slug);
  let ref = workflowRef;
  if (resumed) {
    const recorded = readWorkstream(root, slug).workflow;
    if (ref !== undefined && ref !== recorded) {
      throw new FlowError(`workstream ${slug} follows workflow ${recorded}, not ${ref}`);
    }
    if (from !== undefined) throw new FlowError(`workstream ${slug} exists; --from starts a new one. To jump forward, use continue --forward-to`);
    if (given.after !== undefined || Object.keys(given.inputs).length) {
      throw new FlowError(`workstream ${slug} exists; --after and --input bind inputs only when a workstream starts`);
    }
    ref = recorded;
  } else if (ref === undefined) {
    throw new FlowError(`a new workstream needs --workflow <name or path>, for example --workflow _k-full-sdlc`);
  }
  const path = findWorkflow(root, ref);
  const wf = loadWorkflow(path);
  const fromIndex = from === undefined ? 0 : wf.steps.findIndex((s) => s.id === from);
  if (fromIndex < 0) throw new FlowError(`no step "${from}" in workflow ${wf.name}`);
  const p = loadProject(root);
  // A new workstream started --from a later step skips the steps before it.
  refuseBadReviewGuides(p, wf, path, resumed ? unfinishedIn(readWorkstream(root, slug)) : (step) => wf.steps.indexOf(step) >= fromIndex);
  let inputs: Record<string, string> = {};
  if (!resumed) {
    const { errors } = crossCheck(root, path, wf, (step) => wf.steps.indexOf(step) >= fromIndex);
    if (errors.length) throw new FlowError([`workflow ${wf.name} cannot start:`, ...errors.map((e) => `  ${e}`)].join("\n"));
    inputs = bindInputs(root, p, wf, slug, given);
  }
  updateWorkstream(
    root,
    slug,
    (ws) => {
      // Another start may have minted the workstream since it was found
      // missing, perhaps with another workflow; resuming happens only above.
      if (!resumed && workstreamExists(root, slug)) {
        throw new FlowError(`workstream ${slug} was started by another fuse-flow command meanwhile; run fuse-flow start ${slug} to resume it`);
      }
      // List every step in the state file, so it reads as a complete checklist.
      wf.steps.forEach((step, i) => {
        const state = stateOf(ws, step.id);
        if (!resumed && i < fromIndex) {
          state.status = "SKIPPED";
          const reason = SKIP_REASON.startedAt(from ?? step.id);
          state.skip_reason = reason;
          state.history.push(stamp(EVENT.skipped(reason)));
        }
      });
    },
    {
      workflow: ref,
      started: localDate(),
      ...baseNow(root),
      ...(given.after !== undefined ? { after: given.after } : {}),
      ...(Object.keys(inputs).length ? { inputs } : {}),
      steps: {},
    },
  );
  const ws = readWorkstream(root, slug);
  const c: Ctx = { root, slug, wf, p, date: startedOn(ws) };
  convertOldState(c, ws);
  const header = [`${resumed ? "resumed" : "minted"} workstream ${slug}`, `workflow: ${path}`, `state:    ${workstreamFile(root, slug)}`];
  const base = baseText(root, ws, true);
  if (base) header.push(`base:     ${base}`);
  if (ws.after) header.push(`after:    ${ws.after}`);
  if (ws.parent) {
    const gone = parentGone(root, slug, ws.parent);
    header.push(`parent:   step ${ws.parent.step} of workstream ${ws.parent.slug}, which ${gone ? `no longer waits for this one: ${gone}` : "waits for this one"}`);
  }
  if (wf.inputs.length) header.push(`inputs:   ${inputsSummary(c, ws)}`);
  return [...header, "", ...present(c)];
}

// The workflow's inputs bound for a new workstream: --input first, then the
// document of the same id in the --after workstream. Refuses an --input the
// workflow does not declare, and a required input that stays unbound.
function bindInputs(root: string, p: Project, wf: Workflow, slug: string, given: StartLinks): Record<string, string> {
  const declared = new Set(wf.inputs.map((i) => i.artifact));
  for (const id of Object.keys(given.inputs)) {
    if (!declared.has(id)) {
      const known = wf.inputs.map((i) => i.artifact).join(", ") || "none";
      throw new FlowError(`--input ${id}: workflow ${wf.name} declares no such input (its inputs: ${known})`);
    }
  }
  if (given.after !== undefined) {
    if (given.after === slug) throw new FlowError(`--after names the workstream being started, ${slug}`);
    if (!workstreamExists(root, given.after)) throw new FlowError(`--after ${given.after}: no workstream "${given.after}" in ${root}`);
  }
  const bound: Record<string, string> = {};
  for (const input of wf.inputs) {
    const file = own(given.inputs, input.artifact);
    const path = file !== undefined ? display(p, file) : given.after !== undefined ? documentOf(root, given.after, input.artifact) : undefined;
    if (path !== undefined) bound[input.artifact] = path;
  }
  const missing = wf.inputs.filter((i) => i.required && !has(bound, i.artifact));
  if (missing.length) {
    const ids = missing.map((i) => i.artifact).join(", ");
    throw new FlowError(
      `workflow ${wf.name} requires the input${missing.length === 1 ? "" : "s"} ${ids}` +
        (given.after !== undefined ? `, and workstream ${given.after} has no document of that id` : "") +
        `; give ${missing.length === 1 ? "it" : "each"} with --input <id>=<path>${given.after === undefined ? " or --after <earlier workstream>" : ""}`,
    );
  }
  return bound;
}

// The workflow's inputs as bound, for status and the start header.
function inputsSummary(c: Ctx, ws: Workstream): string {
  return c.wf.inputs
    .map((i) => {
      const path = own(ws.inputs, i.artifact);
      return path !== undefined ? `${i.artifact}=${path}` : `${i.artifact} (not given)`;
    })
    .join(", ");
}

// ------------------------------------------------------------------ continue

export interface Continue {
  ownerApproved: boolean;
  note?: string;
  blocked?: string;
  gate?: number; // with blocked: the review the step is blocked at; with ownerApproved: the review the owner accepts
  skip?: string;
  moreRounds?: number;
  backTo?: string;
  forwardTo?: string;
  updated: Named[];
  unchanged: Record<string, string>;
  notProduced: Record<string, string>;
}

// A file the agent named with --updated: an absolute path, with the artifact
// it counts for when the agent wrote --updated <artifact>=<file>.
export interface Named {
  artifact?: string;
  file: string;
  // When the file is on disk neither under the current directory nor under
  // the root, as a deleted one is: the other of the two paths.
  alternative?: string;
}

export function continueWorkstream(root: string, slug: string, input: Continue): string[] {
  const initial = readWorkstream(root, slug);
  // The owner's skip, or jump forward, passes over the steps before the one
  // it reaches, so their review guides are never printed and need not exist.
  const reached = (wf: Workflow) => {
    const at = currentStep(wf, initial);
    if (at && input.skip !== undefined) return wf.steps.indexOf(at) + 1;
    if (at && input.forwardTo !== undefined) return Math.max(0, wf.steps.findIndex((s) => s.id === input.forwardTo));
    return 0;
  };
  const c = context(root, slug, initial, false, reached);
  handOut(c);
  const ws = readWorkstream(root, slug);
  const step = currentStep(c.wf, ws);
  if (!step) throw new FlowError("workflow complete; there is nothing to continue");
  const status = stateOf(ws, step.id).status;

  // A decision is about the step it was made for. When this command's hand-out
  // moved the workstream past that step, as a condition that now skips it
  // does, the decision is not applied to the step the hand-out reached.
  const aimed = currentStep(c.wf, initial);
  const decides = [input.forwardTo, input.skip, input.moreRounds, input.backTo].some((v) => v !== undefined) || input.ownerApproved;
  if (decides && aimed && aimed !== step) {
    // The guide check above passed over the steps the decision would have
    // skipped; the decision is not applied, so the steps from the one the
    // hand-out reached print their guides and must have them.
    const first = c.wf.steps.indexOf(step);
    const problems = reviewGuideProblems(c.p, c.wf, findWorkflow(root, ws.workflow), (s) => c.wf.steps.indexOf(s) >= first && unfinishedIn(ws)(s));
    throw new FlowError(
      [
        `step "${aimed.id}" is ${stateOf(ws, aimed.id).status} now, so this command did not apply its decision to it, nor to step ` +
          `"${step.id}", which the workstream moved on to and which is handed out now. Tell the owner, then run the command again if the decision still holds.`,
        "",
        ...(problems.length ? ["a review guide cannot be followed:", ...problems.map((l) => `  ${l}`)] : present(c)),
      ].join("\n"),
    );
  }

  if (input.forwardTo !== undefined) return forwardTo(c, step, input.forwardTo, input.note);
  if (input.skip !== undefined) return skipStep(c, step, input.skip);
  if (input.moreRounds !== undefined) return grantRounds(c, step, input.moreRounds, input.note);
  if (input.backTo !== undefined) return sendBack(c, step, input.backTo, input.note, input.updated);
  if (input.ownerApproved && input.gate !== undefined) return acceptReview(c, step, input.gate, input.note);
  if (input.ownerApproved) return approveStep(c, step, input.note);

  if (status === "AWAITING_OWNER" || status === "BLOCKED") {
    const rounds = status === "BLOCKED" && step.gates.some((g) => g.kind === "agent");
    throw new FlowError(
      `step "${step.id}" is ${status}; only the owner can move it on, with --owner-approved, --back-to, ` +
        `${rounds ? "--more-rounds, " : ""}--skip or --forward-to. Run \`${FUSE_FLOW} start ${c.slug}\` to print the hand-over block for the owner.`,
    );
  }
  if (status === "PENDING") throw new FlowError(present(c).join("\n"));
  // A step this command handed out, such as one added to the workflow or the
  // first step of a child nobody started, is the agent's to do first: the
  // agent has not seen it, so its report cannot be about it.
  if (stateOf(initial, step.id).status !== "IN_PROGRESS") {
    throw new FlowError(
      [`step "${step.id}" had not been handed out, so this command did not finish it; it is handed out now. Do the step, then run continue again.`, "", ...present(c)].join("\n"),
    );
  }
  if (input.blocked !== undefined) return blockStep(c, step, input.blocked, input.gate, input.updated);
  return finishStep(c, step, input);
}

// The step must still be the current step, in one of `allowed`, and when
// `pass` is given still in that pass, when the state is written: another
// command may have moved it, or sent the work back to it, while this one ran.
function expectState(c: Ctx, ws: Workstream, step: Step, allowed: StepStatus[], pass?: number): StepState {
  const state = stateOf(ws, step.id);
  const reopened = pass !== undefined && (state.pass ?? 1) !== pass;
  if (currentStep(c.wf, ws) !== step || !allowed.includes(state.status) || reopened) {
    throw new FlowError(
      (reopened
        ? `step "${step.id}" was sent back to while this command ran and is in pass ${state.pass ?? 1} now, so the checks this command ran ` +
          `on pass ${pass} are not recorded for it`
        : `step "${step.id}" is ${state.status} now: another fuse-flow command moved it while this one ran`) +
        `. Run \`${FUSE_FLOW} start ${c.slug}\` to see where the workstream stands before you decide what to run`,
    );
  }
  return state;
}

// The refusal is recorded only in the pass the refused command started in:
// the owner may have sent the work back to the step while its checks ran.
function refuse(c: Ctx, step: Step, pass: number, reason: string, output = "", verification?: string[]): FlowError {
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS"], pass);
    state.history.push(stamp(EVENT.refused(reason)));
    if (verification) state.verification = verification;
  });
  const ws = readWorkstream(c.root, c.slug);
  return new FlowError([reason, ...(output ? [output] : []), "", ...stepBlock(c, ws, step, stateOf(ws, step.id), reason)].join("\n"));
}

// A path with "./" and trailing slashes removed, "." for the repository root.
const tidy = (path: string) => path.replace(/^(\.\/+)+/, "").replace(/\/+$/, "") || ".";

// Key the reasons given with `--<flag> <artifact> <reason>` by artifact id. The
// agent may name an artifact by its id or by its path as the step block shows
// it; an id wins when a name is both. A path that more than one of the
// artifacts uses is refused, since it does not say which one is meant.
function byArtifactId(c: Ctx, flag: string, verb: string, artifacts: Artifact[], given: Record<string, string>): Record<string, string> {
  const placed = place(c, artifacts);
  const known = placed.map((a) => `${a.artifact.artifact} (${a.path})`).join(", ") || `it ${verb} none`;
  const out: Record<string, string> = {};
  for (const [name, why] of Object.entries(given)) {
    let id = placed.find((a) => a.artifact.artifact === name)?.artifact.artifact;
    if (id === undefined) {
      const at = (path: string) => {
        const rel = relative(c.p.root, path);
        return isAbsolute(rel) || rel === ".." || rel.startsWith("../") ? [] : placed.filter((a) => tidy(a.path) === tidy(rel));
      };
      // A relative path is read from the current directory, else from the
      // repository root, as the step block prints it; an artifact the step
      // did not produce is found nowhere on disk, so its declared path decides.
      let matches = at(resolve(name));
      if (!matches.length && !isAbsolute(name)) matches = at(resolve(c.p.root, name));
      if (matches.length > 1) {
        throw new FlowError(`--${flag} "${name}" is the path of ${matches.map((a) => a.artifact.artifact).join(" and ")}; name the artifact by its id`);
      }
      id = matches[0]?.artifact.artifact;
    }
    if (id === undefined) {
      throw new FlowError(`--${flag} names an artifact the step ${verb}, by its id or its path; "${name}" is neither (${known})`);
    }
    out[id] = why;
  }
  return out;
}

function finishStep(c: Ctx, step: Step, given: Continue): string[] {
  const input: Continue = {
    ...given,
    unchanged: byArtifactId(c, "unchanged", "updates", step.updates, given.unchanged),
    notProduced: byArtifactId(c, "not-produced", "produces", step.produces, given.notProduced),
  };
  const before = stateOf(readWorkstream(c.root, c.slug), step.id);
  const pass = before.pass ?? 1;
  const named = namedFiles(c, step, input.updated);
  // What the step wrote, by artifact: the files named now and what earlier
  // commands recorded, in this pass or an earlier one.
  const entries = [...named, ...(before.files ?? [])].filter((f) => stands(c, step, f));
  const wrote = (id: string, thisPass: boolean) => entries.some((f) => f.artifact === id && (!thisPass || f.pass === "this"));

  // The child workstream comes first: the step's own work builds on it.
  const verification: string[] = [];
  const gate = childGate(step);
  if (gate) {
    const child = childOf(c, stateOf(readWorkstream(c.root, c.slug), step.id), step)!;
    // A child that does not exist yet is created now, as start would; one
    // that cannot be created is the step's blocker, not something to start.
    if (!workstreamExists(c.root, child)) {
      try {
        ensureChild(c, step);
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
        throw refuse(
          c,
          step,
          pass,
          `workstream ${child}, which this step waits for, cannot be created: ${e.message}. If you cannot resolve this, ` +
            `report the step blocked: run \`${FUSE_FLOW} continue ${c.slug} --blocked "<the reason above>"\`, so the owner decides.`,
        );
      }
    }
    let why: string | undefined;
    let run = true;
    try {
      why = childNotDone(c, step);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      why = e.message;
      run = false;
    }
    if (why) throw refuse(c, step, pass, run ? `${why}. Run it to its end with \`${FUSE_FLOW} start ${child}\`, then continue this step.` : `${why}.`);
    verification.push(`workstream ${child} (${refName(c, gate.text)}): complete`);
  }

  const produced = place(c, step.produces);
  // An empty folder holds no work yet.
  const empty = (a: Placed) => isDirectory(resolve(c.root, a.path)) && readdirSync(resolve(c.root, a.path)).length === 0;
  const missing = produced.filter((a) => (!onDisk(c, a.path) || empty(a)) && !has(input.notProduced, a.artifact.artifact));
  if (missing.length) {
    throw refuse(
      c,
      step,
      pass,
      `missing artifact(s): ${missing.map((a) => `${a.path} (${a.artifact.artifact})${empty(a) ? ", an empty folder" : ""}`).join(", ")}. Write each, or report one ` +
        `the step rightly does not produce with --not-produced <artifact> "<reason>".`,
    );
  }
  const unaccounted = place(c, step.updates).filter((a) => !has(input.unchanged, a.artifact.artifact) && !wrote(a.artifact.artifact, true));
  if (unaccounted.length) {
    throw refuse(
      c,
      step,
      pass,
      `not accounted for: ${unaccounted.map((a) => `${a.artifact.artifact} (${a.path})`).join(", ")}. Report each file you ` +
        `revised with --updated <file>, or an artifact you left as it was with --unchanged <artifact> "<reason>".`,
    );
  }
  // An artifact this command names files for was not left unchanged, nor
  // left unwritten.
  const contradicted = [...Object.keys(input.unchanged).map((id) => ["unchanged", id]), ...Object.keys(input.notProduced).map((id) => ["not-produced", id])]
    .map(([flag, id]) => ({ flag, id, files: named.filter((f) => f.artifact === id).map((f) => f.path) }))
    .filter((x) => x.files.length);
  if (contradicted.length) {
    throw refuse(
      c,
      step,
      pass,
      contradicted
        .map((x) => `--${x.flag} ${x.id} contradicts --updated ${x.files.join(", ")}, which this command names for ${x.id}; report one or the other.`)
        .join(" "),
    );
  }
  // Nor was an artifact left unchanged that an earlier command in this pass,
  // such as a blocked report, recorded as updated. Files an earlier pass
  // updated do not count: a new pass may rightly leave the artifact as it is.
  const recordedEarlier = Object.keys(input.unchanged)
    .map((id) => ({ id, files: unique((before.files ?? []).filter((f) => f.artifact === id && f.pass === "this" && f.kind === "file").map((f) => f.path)) }))
    .filter((x) => x.files.length);
  if (recordedEarlier.length) {
    throw refuse(
      c,
      step,
      pass,
      recordedEarlier
        .map(
          (x) =>
            `--unchanged ${x.id} contradicts ${x.files.join(", ")}, which an earlier command in this pass of the step recorded as updated for ${x.id}; ` +
            `the step finishes with that update when you run continue without --unchanged ${x.id}.`,
        )
        .join(" "),
    );
  }
  // A folder that existed before the step, such as a research folder shared
  // with other work, does not say which files in it are this workstream's.
  // Files an earlier pass wrote in it count while they are there.
  const unnamed = produced.filter(
    (a) => !has(input.notProduced, a.artifact.artifact) && shared(c, before, a) && !wrote(a.artifact.artifact, false),
  );
  if (unnamed.length) {
    throw refuse(
      c,
      step,
      pass,
      unnamed
        .map(
          (a) =>
            `${a.path} (${a.artifact.artifact}) existed before the step: name each file the step wrote in it with ` +
            `${fileFlag(c, step, a)}, or report it with --not-produced ${a.artifact.artifact} "<reason>".`,
        )
        .join(" "),
    );
  }

  // The checks run without holding the state file's lock, so a long test run
  // does not stall fuse-flow commands for other workstreams. A refusal records
  // every result so far, and the gates not run, for the hand-over block.
  const mechanicalGates = gatesInOrder(step).filter((g) => g.kind === "check" || g.kind === "script");
  const failWith = (i: number, result: string, reason: string, output = "") => {
    verification.push(result, ...mechanicalGates.slice(i + 1).map((g) => `${mechanical(c, g).label}: not run`));
    return refuse(c, step, pass, reason, output, verification);
  };
  for (const [i, g] of mechanicalGates.entries()) {
    const m = mechanical(c, g);
    if (m.kind === "unbound") throw failWith(i, `${m.label}: not run, no command is bound`, bindInstruction(c, m.check));
    if (m.kind === "none") {
      verification.push(`${m.label}: not configured in this project`);
      continue;
    }
    const r = runCommand(c, m.command, step.id);
    if (r.exitCode !== 0) {
      const failed = `${m.label} failed (exit ${r.exitCode ?? "none, killed by a signal"})`;
      throw failWith(i, `${m.label}: failed (exit ${r.exitCode ?? "none"})`, failed, r.output);
    }
    verification.push(`${m.label}: passed`);
  }

  const awaitsOwner = ownerGates(step).length > 0;
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS"], pass);
    // Without an owner gate no owner has approved the work: it is done, and
    // approved only once a later owner gate approves it with that gate's step.
    record(c, step, state, named, awaitsOwner ? "draft" : "done", "finish", input.notProduced);
    setOrDelete(state, "unchanged", Object.keys(input.unchanged).length ? input.unchanged : undefined);
    setOrDelete(state, "not_produced", Object.keys(input.notProduced).length ? input.notProduced : undefined);
    setOrDelete(state, "verification", verification.length ? verification : undefined);
    state.status = awaitsOwner ? "AWAITING_OWNER" : "COMPLETED";
    state.history.push(stamp(awaitsOwner ? EVENT.awaitingOwner() : EVENT.completed()));
  });
  return [`${step.id}: ${awaitsOwner ? "work recorded; the step awaits the owner's action" : "COMPLETED"}`, "", ...present(c)];
}

function setOrDelete<K extends keyof StepState>(state: StepState, key: K, value: StepState[K] | undefined): void {
  if (value === undefined) delete state[key];
  else state[key] = value;
}

// A produces folder that existed before the step, such as a research folder
// shared with other work: only the files the step names in it are the step's.
const shared = (c: Ctx, state: StepState, a: Placed) => (state.existed ?? []).includes(a.path) && isFolder(c, a.path);

// The files the agent named with --updated, each under the artifact it counts
// for: the one it names, or the one whose declared path holds the file. A
// file in the paths of two artifacts must say which; a file outside every
// declared path counts for none.
function namedFiles(c: Ctx, step: Step, given: Named[]): Written[] {
  const declared = declaredOf(c, step);
  const state = stateOf(readWorkstream(c.root, c.slug), step.id);
  return given.map(({ artifact, file: chosen, alternative }) => {
    const file = alternative === undefined ? chosen : meant(c, step, artifact, chosen, alternative);
    const path = display(c.p, file);
    const ids = holders(c, step, path);
    if (artifact !== undefined && !ids.includes(artifact)) {
      const own = declared.find((a) => a.artifact.artifact === artifact);
      const known = declared.map((a) => `${a.artifact.artifact} (${a.path})`).join(", ") || "it has none";
      throw new FlowError(`--updated ${artifact}=${path}: ${own ? `${path} is not inside ${own.path}, the path of ${artifact}` : `the step has no artifact ${artifact} (${known})`}`);
    }
    if (artifact === undefined && ids.length > 1) {
      throw new FlowError(
        `--updated ${path}: the file lies in the paths of ${ids.join(" and ")}, so name the artifact it counts for, as in ` +
          `${ids.map((id) => `--updated ${id}=${path}`).join(" or ")}; repeat the flag for each artifact it counts for`,
      );
    }
    const id = artifact ?? ids[0];
    // A declared folder named itself stands for the whole folder, unless it
    // existed before the step and may hold other work.
    const folder = declared.find((a) => a.artifact.artifact === id && isFolder(c, a.path) && tidy(a.path) === tidy(path));
    if (folder && !isUpdates(step, id) && shared(c, state, folder)) {
      throw new FlowError(
        `--updated ${folder.path}: ${folder.path} is the folder of ${id} itself, which existed before the step and may hold other ` +
          `work; name each file the step wrote in it, with ${fileFlag(c, step, folder).replace("<file>", `${tidy(folder.path)}/<file>`)}`,
      );
    }
    if (folder && !isUpdates(step, id)) return { artifact: id!, path: folder.path, kind: "whole", pass: "this", status: "draft" };
    return { ...(id === undefined ? {} : { artifact: id }), path: folder?.path ?? path, kind: "file", pass: "this", status: "draft" };
  });
}

// Which of two absent paths the agent meant by a file it named: the one a
// path of the step holds, for the artifact named if one is; where both or
// neither are held, the one git knows, in the index or in the history of
// HEAD, where a deletion staged or committed leaves it; else `chosen`.
function meant(c: Ctx, step: Step, artifact: string | undefined, chosen: string, alternative: string): string {
  const held = (file: string) => {
    const ids = holders(c, step, display(c.p, file));
    return artifact === undefined ? ids.length > 0 : ids.includes(artifact);
  };
  if (held(chosen) !== held(alternative)) return held(chosen) ? chosen : alternative;
  const git = (...args: string[]) => spawnSync("git", ["-C", c.root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const tracked = (file: string) =>
    git("ls-files", "--error-unmatch", "--", relative(c.root, file)).status === 0 ||
    Boolean(git("log", "-1", "--format=%H", "--", relative(c.root, file)).stdout?.trim());
  return !tracked(chosen) && tracked(alternative) ? alternative : chosen;
}

// Whether an entry still stands: the agent's report of a file it revised for
// an updates artifact, or of a file outside every declared path, stands for
// the pass it was made in; any other entry stands while its path is on disk.
const stands = (c: Ctx, step: Step, f: Written) =>
  onDisk(c, f.path) || (f.pass === "this" && f.kind === "file" && (f.artifact === undefined || isUpdates(step, f.artifact)));

// Record what the step wrote, for a finished, blocked or sent-back step
// alike: the files the agent named now, before what earlier commands
// recorded, and with `scan` the declared paths on disk. A blocked step
// records an updates path only when a file was named for it; a finished step
// records every one on disk. A produced folder the step created is recorded
// whole unless files were named for it in this pass; once recorded whole, it
// stands for the files of its own artifact in it, in any pass. A folder
// shared with other work is never recorded whole. Entries of an artifact
// reported not produced are removed, and only those. `artifacts`, which later
// steps, hand-overs and other workstreams read, follows from the entries.
function record(
  c: Ctx,
  step: Step,
  state: StepState,
  named: Written[],
  status: "draft" | "done",
  scan: "finish" | "block" | "none",
  notProduced: Record<string, string> = {},
): void {
  let files = [...named, ...(state.files ?? [])].filter((f) => !has(notProduced, f.artifact ?? "") && stands(c, step, f));
  const ours = (id: string) => files.some((f) => f.pass === "this" && f.artifact === id);
  const whole = (a: Placed): Written => ({ artifact: a.artifact.artifact, path: a.path, kind: "whole", pass: "this", status });
  if (scan !== "none") {
    for (const a of place(c, [...step.produces, ...step.optional_produces])) {
      if (has(notProduced, a.artifact.artifact) || !onDisk(c, a.path)) continue;
      if (!isFolder(c, a.path) || (!shared(c, state, a) && !ours(a.artifact.artifact))) files.push(whole(a));
    }
    for (const a of place(c, step.updates)) {
      if (onDisk(c, a.path) && (scan === "finish" || ours(a.artifact.artifact))) files.push(whole(a));
    }
  }
  const absorbed = (f: Written) =>
    f.kind === "file" &&
    !isUpdates(step, f.artifact) &&
    files.some((o) => o.kind === "whole" && o.artifact === f.artifact && tidy(o.path) !== tidy(f.path) && contains(o.path, f.path));
  // This pass's entry wins over an earlier pass's.
  files = once(files.filter((f) => !absorbed(f)).sort((a, b) => Number(a.pass === "earlier") - Number(b.pass === "earlier"))).map((f) => ({ ...f, status }));
  setOrDelete(state, "files", files.length ? files : undefined);
  state.artifacts = recordsOf(c, step, files);
}

// Each entry once, the first of each.
const once = (files: Written[]) => files.filter((f, i) => files.findIndex((o) => o.artifact === f.artifact && o.path === f.path && o.kind === f.kind) === i);

// What later steps read: each declared path recorded whole and each file of
// a produced artifact, in the order the step declares its artifacts. An
// updates artifact is recorded by its path, not by the files named for it.
function recordsOf(c: Ctx, step: Step, files: Written[]): StepState["artifacts"] {
  const order = declaredOf(c, step).map((a) => a.artifact.artifact);
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  // An artifact this pass recorded whole replaces the whole record an earlier
  // pass left at another path, as when the owner moved a file and sent the
  // step back: the earlier file stays in the step's files as history, but
  // later steps read the rewritten one alone, not a folder of both.
  const rewritten = (f: Written) => f.kind === "whole" && f.pass === "earlier" && files.some((o) => o.kind === "whole" && o.pass === "this" && o.artifact === f.artifact);
  const records = files.filter(
    (f): f is Written & { artifact: string } => f.artifact !== undefined && (f.kind === "whole" || !isUpdates(step, f.artifact)) && !rewritten(f),
  );
  // A file named for an updates artifact stands for its declared path, even
  // where nothing recorded the path whole, as after a send-back of a step
  // that was blocked or awaiting the owner.
  for (const a of place(c, step.updates)) {
    const named = files.find((f) => f.artifact === a.artifact.artifact && f.kind === "file");
    if (named && onDisk(c, a.path) && !records.some((r) => r.artifact === a.artifact.artifact)) {
      records.push({ artifact: a.artifact.artifact, path: a.path, kind: "whole", pass: named.pass, status: named.status });
    }
  }
  return records
    .filter((r, i) => records.findIndex((o) => o.artifact === r.artifact && tidy(o.path) === tidy(r.path)) === i)
    .sort((a, b) => rank(a.artifact) - rank(b.artifact))
    .map(({ artifact, path, status }) => ({ artifact, path, status }));
}

// State files written before `files` kept bare paths, `updated` and
// `earlier_pass`, beside the records. Converted once, each path placed as the
// old rules placed it: under the artifacts its records name, else under
// every declared path that holds it.
function convertOldState(c: Ctx, ws: Workstream): void {
  const old = (s: StepState) => s.updated !== undefined || s.earlier_pass !== undefined || (s.files === undefined && s.artifacts.length > 0);
  if (!Object.values(ws.steps).some(old)) return;
  updateWorkstream(c.root, c.slug, (fresh) => {
    for (const [id, s] of Object.entries(fresh.steps)) {
      if (!old(s)) continue;
      const step = c.wf.steps.find((x) => x.id === id);
      const declared = step ? declaredOf(c, step) : [];
      const ids = (path: string) => {
        const recorded = s.artifacts.flatMap((r) => (r.path === path && r.artifact !== undefined ? [r.artifact] : []));
        const held = step ? holders(c, step, path) : [];
        return recorded.length ? recorded : held.length ? held : [undefined];
      };
      const earlier = new Set(s.earlier_pass ?? []);
      const entry = (artifact: string | undefined, path: string, pass: Written["pass"], status: Written["status"] = "draft"): Written => {
        const whole = declared.some((a) => a.artifact.artifact === artifact && tidy(a.path) === tidy(path));
        return { ...(artifact === undefined ? {} : { artifact }), path, kind: whole ? "whole" : "file", pass, status };
      };
      const files = once([
        ...s.artifacts.map((r) => entry(r.artifact ?? ids(r.path)[0], r.path, earlier.has(r.path) ? "earlier" : "this", r.status)),
        // A named file counted for every updates path that held it, whatever
        // its records say: a report inside the code accounts for the code.
        ...(s.updated ?? []).flatMap((path) => [...new Set([...ids(path), ...(step ? holders(c, step, path) : [])])].map((a) => ({ ...entry(a, path, "this"), kind: "file" as const }))),
        ...[...earlier].filter((path) => !s.artifacts.some((r) => r.path === path)).flatMap((path) => ids(path).map((a) => entry(a, path, "earlier"))),
      ]);
      setOrDelete(s, "files", files.length ? files : undefined);
      delete s.updated;
      delete s.earlier_pass;
    }
  });
}

// The agent reports the step blocked. What it has written so far is recorded
// as draft, as when the step finishes, so the hand-over lists it, the
// owner's acceptance keeps it, and a later finish or block in this pass
// builds on it.
function blockStep(c: Ctx, step: Step, reason: string, gate: number | undefined, given: Named[]): string[] {
  if (gate !== undefined) reviewNumbered(step, gate);
  const named = namedFiles(c, step, given);
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS"]);
    record(c, step, state, named, "draft", "block");
    setOrDelete(state, "blocked_gate", gate);
    state.status = "BLOCKED";
    state.history.push(stamp(EVENT.blocked(reason)));
  });
  return [`${step.id}: BLOCKED: ${reason}`, "", ...present(c)];
}

function skipStep(c: Ctx, step: Step, reason: string): string[] {
  const dropped = dropUntouchedChild(c, step);
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED"]);
    // The agent decides a skip only where the step block asks it to judge an
    // agent condition; every other skip is the owner's decision.
    const agentsCall = state.status === "IN_PROGRESS" && step.condition?.kind === "agent";
    state.status = "SKIPPED";
    state.skip_reason = reason;
    state.history.push(stamp(agentsCall ? EVENT.skipped(reason) : EVENT.skippedOnRequest(reason)));
  });
  return [`${step.id}: SKIPPED: ${reason}`, ...dropped, "", ...present(c)];
}

// The owner raises the round cap of the step's agent gates by `n`, on a
// blocked step, which is handed back to the agent, or ahead of time on a step
// in progress.
function grantRounds(c: Ctx, step: Step, n: number, note?: string): string[] {
  if (!step.gates.some((g) => g.kind === "agent")) {
    throw new FlowError(`step "${step.id}" has no agent gate, so there are no review rounds to grant`);
  }
  const now = stateOf(readWorkstream(c.root, c.slug), step.id).status;
  if (now === "AWAITING_OWNER") {
    throw new FlowError(
      `step "${step.id}" is AWAITING_OWNER: its reviews are done and it waits for the owner, so there are no review rounds ` +
        "to grant. The owner approves it with --owner-approved, or sends the work back with --back-to, and the next pass " +
        "is reviewed again",
    );
  }
  if (now === "PENDING") throw new FlowError(`step "${step.id}" has not been handed out yet, so there are no review rounds to grant`);
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS", "BLOCKED"]);
    state.status = "IN_PROGRESS";
    state.rounds_granted = (state.rounds_granted ?? 0) + n;
    delete state.blocked_gate;
    state.history.push(stamp(EVENT.roundsGranted(n, note)));
  });
  return [`${step.id}: owner granted ${n} more review round${n === 1 ? "" : "s"}; the step is IN_PROGRESS`, "", ...present(c)];
}

// Reopen `step` and everything after it: PENDING, its artifacts draft again.
// The files the steps wrote stay where they are, and stay recorded: the next
// pass of a step that ran is told about them, and reviews count from it.
function reopen(state: StepState, line: string): void {
  // Handed out since the last send-back: a step that ran and was then
  // skipped still had a pass.
  const sentBack = state.history.findLastIndex((h) => / owner sent the work back /.test(h));
  const ran = state.history.slice(sentBack + 1).some((h) => /^\S+ handed out/.test(h));
  if (ran) state.pass = (state.pass ?? 1) + 1;
  state.status = "PENDING";
  for (const a of [...state.artifacts, ...(state.files ?? [])]) if (a.status === "approved" || a.status === "done") a.status = "draft";
  for (const f of state.files ?? []) f.pass = "earlier";
  for (const key of ["rounds_granted", "blocked_gate", "accepted_gates", "unchanged", "not_produced", "verification", "skip_reason"] as const) {
    delete state[key];
  }
  state.history.push(line);
}

// "If any of a, b keeps a status of its own ..." for the files whose guide
// defines a status, and the same in plain words for the other files that
// carry a status line. A folder, such as the code at ".", is named only when
// its guide defines a status.
function statusReminder(c: Ctx, records: StepState["artifacts"], to: "draft" | "approved"): string[] {
  const seen = new Map<string, boolean>();
  for (const r of records) seen.set(r.path, (seen.get(r.path) ?? false) || guideSetsStatus(c, r.artifact));
  const guided = [...seen].filter(([, g]) => g).map(([p]) => p);
  const plain = [...seen].filter(([p, g]) => !g && carriesStatus(c, p)).map(([p]) => p);
  const set = to === "draft" ? "set it back to draft" : "set it to approved";
  const example = to === "draft" ? "'Status: approved'" : "'Status: draft'";
  return [
    ...(guided.length ? [`If any of ${guided.join(", ")} keeps a status of its own, as its guide says, ${set}.`] : []),
    ...(plain.length ? [`If any of ${plain.join(", ")} records a status of its own, such as a ${example} line, ${set}.`] : []),
  ];
}

// Whether the artifact's guide or template gives it a draft or approved status.
function guideSetsStatus(c: Ctx, id: string | undefined): boolean {
  const entry = id === undefined ? undefined : libraryEntry(c.p, id);
  if (!entry?.guide) return false;
  return [entry.guide, entry.template].some((file) => file !== undefined && /\bstatus\b[*_`'"]*\s*:[\s*_`'"]*(draft|approved)\b/i.test(head(file)));
}

// Whether a file, not a folder, has a status line such as 'Status: draft'.
const carriesStatus = (c: Ctx, path: string) => {
  const full = resolve(c.root, path);
  return existsSync(full) && !isDirectory(full) && /^[\s>*_#-]*status[*_]*\s*:/im.test(head(full));
};

// The start of a text file, enough to find a status line; "" when it cannot be read.
function head(file: string): string {
  try {
    const fd = openSync(file, "r");
    try {
      const buffer = Buffer.alloc(64 * 1024);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

// The owner sends the work back from the current step, whatever its status,
// to `target`, the step itself or an earlier one. What the current step has
// written so far is recorded as draft first, so its next pass can build on it:
// a step in progress records it as a blocked step does; a finished or blocked
// step recorded it then, and adds only the files named now.
function sendBack(c: Ctx, step: Step, target: string, note: string | undefined, given: Named[]): string[] {
  const from = c.wf.steps.findIndex((s) => s.id === target);
  const at = c.wf.steps.indexOf(step);
  if (from < 0) throw new FlowError(`no step "${target}" in workflow ${c.wf.name}`);
  if (from > at) throw new FlowError(`step "${target}" comes after "${step.id}"; --back-to names "${step.id}" or a step before it`);
  // The reopened steps print their review guides again.
  const reopens = new Set(c.wf.steps.slice(from));
  refuseBadReviewGuides(c.p, c.wf, findWorkflow(c.root, readWorkstream(c.root, c.slug).workflow), (s) => reopens.has(s));
  const named = namedFiles(c, step, given);
  const reopened: StepState["artifacts"] = [];
  updateWorkstream(c.root, c.slug, (ws) => {
    const current = expectState(c, ws, step, ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED"]);
    record(c, step, current, named, "draft", current.status === "IN_PROGRESS" ? "block" : "none");
    // One line for the whole send-back, written to every reopened step, so
    // the steps carry the same time and a reader counts it once.
    const line = stamp(EVENT.sentBack(step.id, target, note));
    for (const s of c.wf.steps.slice(from)) {
      const state = stateOf(ws, s.id);
      if (state.status === "PENDING" && s !== step) continue;
      reopened.push(...state.artifacts);
      reopen(state, line);
    }
  });
  return [`${step.id}: owner sent the work back to ${target}`, ...statusReminder(c, reopened, "draft"), "", ...present(c)];
}

// The owner jumps forward: the current step and every step before `target`
// are SKIPPED with the owner's note.
function forwardTo(c: Ctx, step: Step, target: string, note?: string): string[] {
  const to = c.wf.steps.findIndex((s) => s.id === target);
  const at = c.wf.steps.indexOf(step);
  if (to < 0) throw new FlowError(`no step "${target}" in workflow ${c.wf.name}`);
  if (to <= at) throw new FlowError(`step "${target}" is not after "${step.id}"; --forward-to names a later step (use --back-to to go back)`);
  const reason = SKIP_REASON.jumpedForward(target, note);
  const dropped = dropUntouchedChild(c, step);
  updateWorkstream(c.root, c.slug, (ws) => {
    expectState(c, ws, step, ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED"]);
    for (const s of c.wf.steps.slice(at, to)) {
      const state = stateOf(ws, s.id);
      if (finished(state.status)) continue;
      state.status = "SKIPPED";
      state.skip_reason = reason;
      state.history.push(stamp(EVENT.skipped(reason)));
    }
  });
  return [`jumped forward from ${step.id} to ${target}`, ...dropped, "", ...present(c)];
}

function approveStep(c: Ctx, step: Step, note?: string): string[] {
  // A blocked step may still wait for its child, and a step awaiting the
  // owner waits again once its child became unfinished, such as when the
  // owner sent the child's work back or its workflow gained a step. The
  // owner's way past an unfinished child is to skip the step.
  const pending = waitingFor(c, step);
  if (pending) {
    throw new FlowError(
      `step ${step.id} cannot complete yet: ${pending.why}. To go on without it, the owner skips the step: ` +
        `\`${FUSE_FLOW} continue ${c.slug} --skip "<the owner's reason>"\``,
    );
  }
  let records: StepState["artifacts"] = [];
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = stateOf(ws, step.id);
    if (state.status !== "AWAITING_OWNER" && state.status !== "BLOCKED") {
      throw new FlowError(`step "${step.id}" is ${state.status}, not awaiting the owner or blocked; finish it and run continue without --owner-approved`);
    }
    state.status = "COMPLETED";
    delete state.blocked_gate;
    for (const a of [...state.artifacts, ...(state.files ?? [])]) a.status = "approved";
    // The owner's gate also approves the work of the steps before it that
    // have no owner gate of their own, such as a design that a later step's
    // gate approves together with the build order.
    const at = c.wf.steps.indexOf(step);
    let first = at;
    while (first > 0 && !ownerGates(c.wf.steps[first - 1]).length) first -= 1;
    const covered = c.wf.steps.slice(first, at).filter((s) => stateOf(ws, s.id).status === "COMPLETED");
    for (const s of covered) {
      const earlier = stateOf(ws, s.id);
      for (const a of [...earlier.artifacts, ...(earlier.files ?? [])]) if (a.status === "done") a.status = "approved";
    }
    records = covered.flatMap((s) => stateOf(ws, s.id).artifacts).concat(state.artifacts);
    state.history.push(stamp(EVENT.approved(note)));
  });
  return [`${step.id}: owner approved; COMPLETED`, ...statusReminder(c, records, "approved"), "", ...present(c)];
}

// The owner accepts the review the agent reported the step blocked at, as it
// is. The step goes back to the agent, which runs the gates still ahead; the
// accepted review is not run again in this pass.
function acceptReview(c: Ctx, step: Step, n: number, note?: string): string[] {
  const g = reviewNumbered(step, n);
  const label = `review ${n} (${g.text})`;
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = stateOf(ws, step.id);
    if (state.status !== "BLOCKED") {
      throw new FlowError(`step "${step.id}" is ${state.status}, not blocked; --owner-approved --gate accepts the review a blocked step stopped at`);
    }
    const at = state.blocked_gate;
    if (at === undefined) {
      throw new FlowError(
        `the agent did not say which review step "${step.id}" is blocked at; the owner accepts the whole step with --owner-approved alone`,
      );
    }
    if (at !== n) {
      throw new FlowError(`the step was blocked at review ${at} (${gatesInOrder(step)[at - 1].text}); --gate ${n} accepts only that review`);
    }
    state.status = "IN_PROGRESS";
    delete state.blocked_gate;
    state.accepted_gates = [...new Set([...(state.accepted_gates ?? []), n])];
    state.history.push(stamp(EVENT.reviewAccepted(label, note)));
  });
  return [`${step.id}: owner accepted ${label} as it is; the step is IN_PROGRESS`, "", ...present(c)];
}

// -------------------------------------------------------------------- status

export function status(root: string, slug: string): string[] {
  const ws = readWorkstream(root, slug);
  const c = context(root, slug, ws, true);
  const width = Math.max(...c.wf.steps.map((s) => s.id.length));
  const current = currentStep(c.wf, ws);
  // Each file shows once, under the latest step that records it; the earlier
  // steps that recorded it too are named there.
  const recordedBy = new Map<string, string[]>();
  for (const step of c.wf.steps) {
    for (const a of stateOf(ws, step.id).artifacts) recordedBy.set(a.path, unique([...(recordedBy.get(a.path) ?? []), step.id]));
  }
  const rows = c.wf.steps.map((step) => {
    const state = stateOf(ws, step.id);
    const shown = state.artifacts
      .filter((a) => recordedBy.get(a.path)!.at(-1) === step.id)
      .map((a) => {
        const also = recordedBy.get(a.path)!.slice(0, -1);
        return `${a.path} (${a.status}${also.length ? `; also recorded by ${also.join(", ")}` : ""})`;
      });
    const details = [shown.join(", "), state.skip_reason ?? ""].filter(Boolean);
    // A waiting step names the child of its current pass, recorded or not
    // yet created, and its earlier passes' children apart from it.
    const child = childGate(step) && !finished(state.status) && state.status !== "PENDING" ? childOf(c, state, step) : undefined;
    const others = (state.children ?? []).map((ch) => ch.slug).filter((s) => s !== child);
    if (child) {
      details.push(`waits for workstream ${child}, which ${whereIs(root, child)}`);
      if (others.length) details.push(`earlier child workstream${others.length > 1 ? "s" : ""} ${others.join(", ")}`);
    } else if (others.length) details.push(`child workstream${others.length > 1 ? "s" : ""} ${others.join(", ")}`);
    const marker = step === current ? "> " : "  ";
    // Each review shows its cap, so the rounds the agent counts can be read against it.
    const gates = step.gates.length
      ? step.gates.map((g) => (g.kind === "agent" ? `${describeGate(g)} [cap ${statusCap(c, g, state)}]` : describeGate(g))).join(", ")
      : "none";
    const columns = [step.id.padEnd(width), state.status.padEnd(14), `gates ${gates.padEnd(6)}`];
    return `${marker}${[...columns, details.join("; ")].join("  ")}`.trimEnd();
  });
  const footer = current ? `current step: ${current.id}; ${FUSE_FLOW} start ${slug} prints what to do` : "workflow complete";
  const related = links(root, slug, ws);
  const header = [`workstream ${slug} (${c.wf.name})`];
  const base = baseText(root, ws, true);
  if (base) header.push(`  base: ${base}`);
  if (related.after) header.push(`  after: ${related.after}`);
  if (related.parent) {
    const gone = parentGone(root, slug, related.parent);
    header.push(`  child of: step ${related.parent.step} of workstream ${related.parent.slug}, which ${gone ? `no longer waits for it: ${gone}` : "waits for it"}`);
  }
  if (c.wf.inputs.length) header.push(`  inputs: ${inputsSummary(c, ws)}`);
  const started = related.startedAfter.length ? [`started after it: ${related.startedAfter.join(", ")}`] : [];
  return [...header, ...rows, footer, ...started];
}

// ---------------------------------------------------------------------- list
// What an agent needs to pick up or start work: the workstreams in this
// project with their current step, and every workflow it can start, by the
// name `start --workflow` takes, with its description. A file that is not a
// valid workflow, or a name that cannot be started, is listed with the reason,
// so one broken file does not hide the others.

export function list(root: string): string[] {
  const lines: string[] = [];
  const dir = workstreamsDir(root);
  const slugs = isDirectory(dir)
    ? readdirSync(dir)
        .filter((name) => name.endsWith(".yml"))
        .map((name) => name.slice(0, -4))
        .sort()
    : [];
  lines.push(slugs.length ? `WORKSTREAMS in this project; \`${FUSE_FLOW} start <slug>\` resumes one:` : "WORKSTREAMS in this project: none");
  for (const slug of slugs) {
    try {
      const ws = readWorkstream(root, slug);
      const c = context(root, slug, ws, true);
      const step = currentStep(c.wf, ws);
      const where = step ? `step ${step.id}, ${position(c, step)}, ${stateOf(ws, step.id).status}` : "workflow complete";
      const from = [ws.after && `after ${ws.after}`, ws.parent && `child of ${ws.parent.slug}, step ${ws.parent.step}`].filter(Boolean).join(", ");
      lines.push(`  ${slug} (${c.wf.name}, started ${c.date}${from ? `, ${from}` : ""}): ${where}`);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      lines.push(`  ${slug}: cannot be read: ${e.message.replaceAll("\n", "\n    ")}`);
    }
  }

  lines.push("", `WORKFLOWS by the name \`${FUSE_FLOW} start <slug> --workflow <name>\` takes; where a name is in several locations, the first wins:`);
  const labels = ["this project", "yours", "shipped with fuse-flow"];
  // A name resolves as findWorkflow does: to the first location with a file
  // of that name, valid or not, and is refused when that location has two.
  const nameOf = (file: string) => (file.endsWith(".yml") ? basename(file, ".yml") : undefined);
  const locations = workflowDirs(root).map((dir) => ({ dir, files: isDirectory(dir) ? workflowFilesBelow(root, dir) : [] }));
  const owner = new Map<string, { at: number; count: number }>(); // name -> where it resolves
  locations.forEach(({ files }, i) => {
    for (const file of files) {
      const name = nameOf(file);
      if (!name) continue;
      const o = owner.get(name);
      if (!o) owner.set(name, { at: i, count: 1 });
      else if (o.at === i) o.count += 1;
    }
  });
  locations.forEach(({ dir, files }, i) => {
    lines.push(`${labels[i]}, ${dir}:${files.length ? "" : " none"}`);
    for (const file of files) {
      const name = nameOf(file);
      const shown = relative(dir, file);
      let wf: Workflow;
      try {
        wf = loadWorkflow(file);
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
        lines.push(`  ${shown}: not a valid workflow; \`${FUSE_FLOW} validate ${shellQuote(file)}\` says why`);
        continue;
      }
      const o = name ? owner.get(name)! : undefined;
      let note = "";
      if (!o) note = " (start it by its path; only .yml files are found by name)";
      else if (o.at === i && o.count > 1) note = " (ambiguous in this location; start it by its path, or rename one)";
      else if (o.at !== i && o.count > 1) note = ` (start it by its path; the name is ambiguous in ${labels[o.at]})`;
      else if (o.at !== i) note = ` (start it by its path; the name starts the one in ${labels[o.at]})`;
      lines.push(`  ${name ?? shown} (${shown})${note}`);
      if (wf.description) lines.push(`      ${wf.description.replace(/\s+/g, " ").trim()}`);
    }
  });
  return lines;
}

// ------------------------------------------------------------------ validate
// Check workflow files without starting a workstream. Each reference is a
// workflow name, a file, or a directory, which stands for every .yml and .yaml
// file below it, in nested folders too. Every file is checked and reported;
// the command is refused when any of them is invalid.

export function validate(root: string, refs: string[]): string[] {
  const lines: string[] = [];
  let checked = 0;
  let invalid = 0;
  const seen = new Set<string>();
  for (const ref of refs) {
    let files: string[];
    try {
      files = isDirectory(ref) ? workflowFilesBelow(root, ref) : [findWorkflow(root, ref)];
      if (files.length === 0) throw new FlowError(`no .yml or .yaml files in ${ref} or below it`);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      checked += 1;
      invalid += 1;
      lines.push(`invalid: ${e.message}`);
      continue;
    }
    for (const file of files) {
      if (seen.has(file)) continue;
      seen.add(file);
      checked += 1;
      try {
        const wf = loadWorkflow(file);
        const { errors, warnings } = crossCheck(root, file, wf);
        const guides = reviewGuideProblems(loadProject(root), wf, file);
        if (guides.length) {
          invalid += 1;
          lines.push(`invalid: ${file} names a review guide that cannot be followed:`, ...guides.map((g) => `  ${g}`));
        } else if (errors.length) {
          invalid += 1;
          lines.push(`invalid: ${file} refers to other workflows wrongly:`, ...errors.map((e) => `  ${e}`));
        } else {
          lines.push(`valid:   ${file}`);
        }
        lines.push(...warnings.map((w) => `  warning: ${w}`));
        // A workflow is found by its file name, so a different `name` is one
        // that start --workflow cannot take. The warning names the reference
        // start does take: the file name where a lookup by it finds this
        // file, else the path.
        const fileName = basename(file).replace(/\.ya?ml$/, "");
        if (wf.name !== fileName) {
          let found: string | undefined;
          let why = "names are looked up only in the workflows folders";
          try {
            found = realpathSync(findWorkflow(root, fileName));
            why = `the name ${fileName} finds ${found}`;
          } catch (e) {
            if (!(e instanceof FlowError)) throw e;
            if (e.message.includes("ambiguous")) why = e.message;
          }
          if (file.endsWith(".yaml")) why = "only .yml files are found by name";
          lines.push(
            found === realpathSync(file)
              ? `  warning: name "${wf.name}" differs from the file name; fuse-flow finds the workflow by its file name, ${fileName}`
              : `  warning: name "${wf.name}" differs from the file name; start this workflow by its path, ${file}; ${why}`,
          );
        }
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
        invalid += 1;
        lines.push(`invalid: ${e.message}`);
      }
    }
  }
  if (invalid > 0) throw new FlowError([`${invalid} of ${checked} workflows are invalid`, ...lines].join("\n"));
  return [...lines, `${checked} workflow${checked === 1 ? "" : "s"} valid`];
}
