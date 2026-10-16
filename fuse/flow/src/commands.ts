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
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { currentBase, resolveBase } from "./base.ts";
import { FlowError } from "./errors.ts";
import { EVENT, SKIP_REASON, stamp } from "./history.ts";
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
  reviewer,
  reviewers,
  reviewGuide,
  rulings,
} from "./policy.ts";
import { findWorkflow, isDirectory, isWorkflowPath, reviewsDir, workflowDirs, workflowFilesBelow, workstreamFile, workstreamsDir } from "./project.ts";
import { type Artifact, type Condition, describeGates, type Gate, loadWorkflow, type Step, type Workflow } from "./workflow.ts";
import {
  childGate,
  childSlug,
  crossCheck,
  documentOf,
  firstUnfinished,
  isComplete,
  links,
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

function context(root: string, slug: string, ws: Workstream): Ctx {
  return { root, slug, wf: loadWorkflow(findWorkflow(root, ws.workflow)), p: loadProject(root), date: startedOn(ws) };
}

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

// The id of the step's artifact whose path holds `file`, if any.
function artifactHolding(c: Ctx, step: Step, file: string): string | undefined {
  return place(c, [...step.produces, ...step.optional_produces, ...step.updates]).find((a) => contains(a.path, file))?.artifact.artifact;
}

// Whether a library entry gives the artifact a guide of its own.
const hasGuide = (c: Ctx, id: string | undefined) => (id === undefined ? false : Boolean(libraryEntry(c.p, id)?.guide));

// Whether a skipped step was skipped because it was not needed: its condition
// did not hold, or the owner answered it no. A step passed over when the
// owner started later or jumped forward may still have work to restore.
const notNeeded = (step: Step, state: StepState) =>
  step.condition !== undefined &&
  !state.skip_reason?.startsWith(SKIP_REASON.startedAt("")) &&
  !state.skip_reason?.startsWith(SKIP_REASON.jumpedForward(""));

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

// Runs from the repository root with the caller's environment, like a
// Makefile target. Keeps only the end of the output: enough to see why it
// failed without flooding the agent's context. The output goes to a file
// rather than into memory, so a check that prints any amount still finishes
// and reports its own exit code.
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
      if (!state.pass) {
        const recorded = recordedPaths(ws2);
        const existed = place(c, [...step.produces, ...step.optional_produces])
          .map((a) => a.path)
          .filter((path) => onDisk(c, path) && !recorded.has(path));
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
        ...stopEarly(c, ws, step),
      ];
    }
    case "IN_PROGRESS": {
      try {
        ensureChild(c, step);
      } catch (e) {
        if (!(e instanceof FlowError)) throw e;
        return [
          `STEP ${step.id} (${position(c, step)}) waits for a child workstream that cannot be created: ${e.message}.`,
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
    return `READ ${id}: step ${source.id} was skipped (${state.skip_reason ?? "no reason recorded"}), so no child workstream returned it and there is nothing to read.`;
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
// one that follows another workflow, or belongs to another parent step.
function checkChild(c: Ctx, step: Step, gate: Gate, slug: string): void {
  const child = readWorkstream(c.root, slug);
  if (workflowFile(c.root, child.workflow) !== workflowFile(c.root, gate.text)) {
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
// is complete. The same check as on continue.
function waitingFor(c: Ctx, step: Step): { slug: string; why: string } | undefined {
  if (!childGate(step)) return undefined;
  const slug = childOf(c, stateOf(readWorkstream(c.root, c.slug), step.id), step)!;
  try {
    const why = childNotDone(c, step);
    return why ? { slug, why } : undefined;
  } catch (e) {
    if (!(e instanceof FlowError)) throw e;
    return { slug, why: e.message };
  }
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
    refuseCycle(c.root, c.slug, gate.text);
    const targetPath = findWorkflow(c.root, gate.text);
    const target = loadWorkflow(targetPath);
    // The checks a new workstream of that workflow gets from start.
    const { errors } = crossCheck(c.root, targetPath, target);
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

// What the agent does now.
function stepBlock(c: Ctx, ws: Workstream, step: Step, state: StepState): string[] {
  const lines = [`STEP ${step.id} (${position(c, step)}): ${step.instruction.replace(/\s+/g, " ").trim()}`];
  const owned = rulings(c.p);
  if (owned.length) {
    lines.push("RULINGS: where this workflow and other installed rules overlap, the owner ruled:", ...owned.map((r) => `  - ${r}`));
  }
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

  const gate = childGate(step);
  const child = gate ? childOf(c, state, step) : undefined;
  if (gate && child && !workstreamExists(c.root, child)) {
    lines.push(`DELEGATE: this step waits for workstream ${child}, which follows workflow ${refName(c, gate.text)}. It does not exist; fuse-flow creates it when it prints this step with \`${FUSE_FLOW} start ${c.slug}\`.`);
  } else if (gate && child) {
    const given = Object.keys(readWorkstream(c.root, child).inputs ?? {});
    lines.push(
      `DELEGATE: this step waits for workstream ${child}, which follows workflow ${refName(c, gate.text)} and was ` +
        `created for it${given.length ? `, given ${given.join(", ")}` : ""}. First run it to its end: ` +
        `\`${FUSE_FLOW} start ${child}\` prints its current step. Run it yourself or in a subagent, as suits the ` +
        "work; the owner's decisions in it are made there. Then do this step's work.",
    );
    if (cond?.kind === "agent" || cond?.kind === "owner-action") {
      lines.push(`If this step does not apply, skip it before you start ${child}; fuse-flow then removes ${child}, since nothing has happened in it.`);
    }
  }

  for (const id of step.consumes) {
    const before = c.wf.steps.slice(0, c.wf.steps.indexOf(step)).reverse();
    const source = before.find(
      (s) => [...s.produces, ...s.optional_produces, ...s.updates].some((a) => a.artifact === id) || has(childGate(s)?.returns, id),
    );
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
    // shared with other work.
    const files = sourceState.artifacts.filter((a) => a.artifact === id && a.path !== path && contains(path, a.path)).map((a) => a.path);
    if (sourceState.status === "SKIPPED" && notNeeded(source, sourceState)) {
      lines.push(`READ ${id}: step ${source.id} was skipped (${sourceState.skip_reason}), so there is nothing from it to read.`);
    } else if (sourceState.status === "COMPLETED" && own(sourceState.not_produced, id)) {
      lines.push(`READ ${id}: step ${source.id} did not produce it (${own(sourceState.not_produced, id)}), so there is nothing from it to read.`);
    } else if (files.length) {
      lines.push(`READ ${files.join(", ")} (from step ${source.id}).`);
    } else if (sourceState.status === "COMPLETED" && (sourceState.existed ?? []).includes(path) && isFolder(c, path)) {
      // A folder shared with other work, in which the step recorded nothing.
      lines.push(`READ ${id}: step ${source.id} wrote nothing in ${path}, so there is nothing from it to read.`);
    } else {
      lines.push(
        onDisk(c, path)
          ? `READ ${path} (from step ${source.id}).`
          : `READ ${path} (from step ${source.id}). ${RESTORE}`,
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
          ? `READ ${path} (${id}, returned by workstream ${child}).`
          : complete
            ? `RETURNS ${id}: workstream ${child} recorded no ${childId}, so there is nothing to read.`
            : `RETURNS ${id}: workstream ${child}'s ${childId}, once ${child} is complete; read it then.`,
      );
    }
  }

  const existed = new Set(state.existed ?? []);
  const earlier = state.earlier_pass ?? [];
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
  for (const a of place(c, step.produces)) {
    let note: string | undefined;
    if (existed.has(a.path) && earlier.some((f) => contains(a.path, f))) {
      note = `${a.path} existed before this workstream; the files this workstream wrote in it are listed under EARLIER PASS.`;
    } else if (existed.has(a.path)) {
      note =
        `${a.path} already existed when the step was handed out, and this workstream did not write it. Do what ` +
        "the instruction or the guide says about it; if they say nothing, judge whether to ask the owner to " +
        "update it, replace it, or use a different path.";
    }
    if (existed.has(a.path) && isFolder(c, a.path)) note += " Name each file you write in it with --updated <file>.";
    lines.push(artifactLine("PRODUCE", a, note));
  }
  for (const a of place(c, step.optional_produces)) {
    const shared = existed.has(a.path) && isFolder(c, a.path);
    lines.push(artifactLine("PRODUCE (optional)", a, shared ? `${a.path} existed before the step; name each file you write in it with --updated <file>.` : undefined));
  }
  for (const a of place(c, step.updates)) {
    lines.push(
      artifactLine("UPDATE", a, onDisk(c, a.path) ? undefined : `${a.path} does not exist yet; create it and report it with --updated.`),
    );
  }
  if (earlier.length) {
    lines.push(
      `EARLIER PASS: this step ran before the owner sent the work back, and wrote ${earlier.join(", ")}. Check each ` +
        "against what changed since: keep it, update it, or redo it, and propose to the owner which.",
    );
  }

  const reviewed = place(c, [...step.produces, ...step.optional_produces, ...step.updates]);
  const guided = reviewed.some((a) => libraryEntry(c.p, a.artifact.artifact)?.guide);
  // A step instruction may deliberately depart from a shared guide; say which wins.
  if (guided) {
    lines.push(
      "GUIDES: where the step instruction above and a guide disagree, follow the instruction, and name each " +
        "disagreement in your hand-over block.",
    );
  }
  lines.push("WHEN THE WORK IS DONE:");
  let n = 0;
  for (const g of gatesInOrder(step)) {
    if (g.kind === "workflow") {
      lines.push(`  ${++n}. Make sure workstream ${child} is complete. fuse-flow checks it on continue and refuses the step until it is.`);
    } else if (g.kind === "check" || g.kind === "script") {
      const m = mechanical(c, g);
      const again = "fuse-flow runs it again on continue and refuses the step while it fails.";
      if (m.kind === "run") {
        const what = g.kind === "check" ? `, the project's ${g.text} check (bound in ${display(c.p, checkBinding(c.p, g.text)!.file)})` : "";
        lines.push(`  ${++n}. Run \`${m.command}\`${what}. Fix the work, or the check if the check is wrong, until it passes. ${again}`);
      } else if (m.kind === "none") {
        lines.push(`  ${++n}. The ${g.text} check is not configured in this project (bound to none in ${m.file}); there is nothing to run.`);
      } else {
        lines.push(`  ${++n}. ${bindInstruction(c, m.check)} Then run it and fix the work until it passes. ${again}`);
      }
    } else if (g.kind === "agent") {
      lines.push(`  ${++n}. ${reviewText(c, ws, g, step, state, reviewed)}`);
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
function stopEarly(c: Ctx, ws: Workstream, step: Step): string[] {
  const reviews = step.gates.filter((g) => g.kind === "agent").length > 0;
  return [
    "IF YOU STOP BEFORE THE STEP IS DONE: end your message with these five lines, written for the owner, with each " +
      "<...> part replaced. If you cannot finish the step at all, report it blocked instead.",
    `  SUMMARY: <the task, in a sentence>. Workstream ${c.slug}, step ${step.id}, ${position(c, step)}.${skippedSteps(c, ws)}`,
    "  STATUS: <needs input, when you need an answer or a decision from the owner; paused, when the work only " +
      "waits for the owner's request to continue>",
    "  PRODUCED: <the files written or changed so far, and why any artifact will not be written; or none>",
    `  VERIFICATION: <the check results so far${reviews ? ", the review rounds used of the cap, and any required fix still open" : ""}; or none>`,
    "  NEXT STEP: <two to four options for the owner, your recommendation first, with its reason>",
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

function reviewText(c: Ctx, ws: Workstream, g: Gate, step: Step, state: StepState, reviewed: Placed[]): string {
  let text = `Have an independent agent ${g.text.replace(/\.$/, "")}.`;
  const guided: string[] = [];
  const parts: string[] = [];
  let ownGuide = false;
  for (const a of reviewed) {
    const guide = reviewGuide(c.p, g, a.artifact.artifact);
    if (guide) {
      guided.push(guide);
      parts.push(`${a.path} against ${display(c.p, guide)}`);
    } else {
      const own = libraryEntry(c.p, a.artifact.artifact)?.guide;
      if (own) ownGuide = true;
      parts.push(own ? `${a.path}, with its guide ${display(c.p, own)} as the definition of a good artifact` : a.path);
    }
  }
  if (reviewed.length === 0) {
    const guide = reviewGuide(c.p, g, undefined);
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
  const startedBy = (l: Launch) => (l === "subagent" ? "as a fresh subagent in your own harness" : `with \`${l.command}\``);
  if (table.length) {
    const rows = table.map(([author, r]) => {
      const row = `if you run on ${author}, ${r.model}${r.effort ? ` at ${r.effort} effort` : ""}`;
      return r.launch && !same(r.launch, how) ? `${row}, started ${startedBy(r.launch)}` : row;
    });
    text += ` Pick the reviewer's model by the model you run on: ${rows.join("; ")}. If yours is not listed, follow the review guide.`;
  }
  const rowLaunches = table.flatMap(([, r]) => (r.launch && !same(r.launch, how) ? [r.launch] : []));
  text += ` ${rowLaunches.length ? "Unless its row says otherwise, start" : "Start"} the reviewer ${startedBy(how)}, with none of your context.`;
  if (how !== "subagent" || rowLaunches.some((l) => l !== "subagent")) {
    text +=
      " In a launch command, replace {model} and {effort} with the reviewer's, {prompt_file} with a file you " +
      "write the review request to, and {findings_file} with the findings file.";
  }
  const agentGates = step.gates.filter((x) => x.kind === "agent");
  const gateName = agentGates.length > 1 ? `-gate${agentGates.indexOf(g) + 1}` : "";
  const dir = display(c.p, reviewsDir(c.root, c.slug));
  const findings = `${dir}/${step.id}${gateName}${state.pass ? `-pass-${state.pass}` : ""}-round-<n>.json`;
  text +=
    ` The reviewer writes its findings to ${findings}, where <n> is the round, following ` +
    `${display(c.p, FINDINGS_SCHEMA)}; read them from there.`;
  text +=
    " Classify each finding as fix required or false positive, with the reason; a finding the owner already " +
    "accepted or deferred is not a required fix. Fix what is required and review again, until a round ends with " +
    "no required fix.";
  if (guided.length) text += " The review guide decides what counts as a required fix and when a round passes.";
  if (guided.length || ownGuide) {
    text +=
      " Give the reviewer the step instruction as well: where it and a guide disagree, the instruction wins, so " +
      "following the instruction is not a required fix.";
  }
  if (state.pass) {
    text +=
      ` This is pass ${state.pass} of this step, because the owner sent the work back: count only this pass's rounds ` +
      "against the cap. The review covers the whole artifact. Give the reviewer the findings files of the earlier " +
      `passes of this step, in ${dir}/, with how each finding was handled.`;
  }
  text +=
    " Every round that ends with a required fix counts, whatever the cause. After " +
    `${capOf(c, g, state)} such rounds, do not start another; run \`${FUSE_FLOW} continue ${c.slug} --blocked ` +
    `"<what is still open, and why the review does not converge>"\`.`;
  return text;
}

// The PRODUCED line: the files the step created or changed, and the reasons
// for what it left out.
function producedLine(c: Ctx, step: Step, state: StepState): string {
  const existed = new Set(state.existed ?? []);
  const files: string[] = [];
  const updatesPaths = place(c, step.updates).map((a) => a.path);
  const updatesIds = new Set(step.updates.map((a) => a.artifact));
  for (const a of state.artifacts) {
    if (a.artifact && updatesIds.has(a.artifact)) continue; // listed by file below
    files.push(`${a.path} (${existed.has(a.path) ? "updated" : "new"})`);
  }
  for (const f of state.updated ?? []) {
    files.push(updatesPaths.some((p) => contains(p, f)) ? `${f} (updated)` : `${f} (updated, outside the declared paths)`);
  }
  const parts: string[] = [];
  if (files.length >= 5) {
    const dirs = files.map((f) => dirname(f.split(" (")[0]));
    let common = dirs[0];
    while (common !== "." && !dirs.every((d) => d === common || d.startsWith(`${common}/`))) common = dirname(common);
    parts.push(`${files.length} files${common === "." ? "" : ` under ${common}/`}; summarize them, for example "12 files under src/checkout/, with their tests"`);
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
  for (const g of gatesInOrder(step)) {
    if (g.kind === "agent") parts.push(`review (${g.text}): <rounds used> of ${capOf(c, g, state)} rounds, <any required fix still open>`);
  }
  return `VERIFICATION: ${parts.join("; ") || "none"}`;
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
    const reviews = done.filter((s) => s.gates.some((g) => g.kind === "agent")).map((s) => `${s.id}: <review rounds used>`);
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
      forYou.push(
        `  - Step ${ws.parent.step} of workstream ${ws.parent.slug} waits for this workstream. Go on there: ` +
          `\`${FUSE_FLOW} start ${ws.parent.slug}\` prints that step, with what this workstream returns to it.`,
      );
    }
    return [
      intro,
      "",
      `SUMMARY: <the work, in a sentence>. Workstream ${c.slug}, all ${c.wf.steps.length} steps of ${c.wf.name}.${skipped}`,
      "STATUS: workflow complete",
      `PRODUCED: ${produced.join("; ") || "none"}`,
      `VERIFICATION: ${[...verified, ...reviews].join("; ") || "none"}`,
      next,
      ...(forYou.length ? ["", "FOR YOU, NOT FOR THE OWNER:", ...forYou] : []),
    ];
  }

  const state = stateOf(ws, step.id);
  const ff = `${FUSE_FLOW} continue ${c.slug}`;
  const routes = routesBack(step);
  const backOption =
    "Send the work back to an earlier step, with what to change" +
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
    const asks = ownerGates(step).map((g) => g.text).join(", and ");
    lines.push(
      `STATUS: awaiting owner action. The owner is asked to ${asks}.`,
      producedLine(c, step, state),
      verificationLine(c, step, state),
      "NEXT STEP:",
      `  - ${capitalize(asks)}.`,
      `  - ${backOption}`,
    );
    commands.push(
      `  - The owner does what the step asks (${asks}): run \`${ff} --owner-approved --note "<what the owner said>"\`.`,
      `  - ${backCommand}`,
    );
  } else {
    const why = state.history.findLast((h) => h.includes("blocked"))?.replace(/^\S+ /, "") ?? "blocked";
    const pending = waitingFor(c, step);
    lines.push(
      `STATUS: blocked. ${why}`,
      producedLine(c, step, state),
      verificationLine(c, step, state),
      "NEXT STEP:",
      pending ? `  - Skip this step, without what workstream ${pending.slug} would return.` : "  - Accept the step as it is.",
    );
    commands.push(
      pending
        ? `  - The owner skips the step: run \`${ff} --skip "<the owner's reason>"\`.`
        : `  - The owner accepts the step as it is: run \`${ff} --owner-approved --note "<the owner's decision>"\`.`,
    );
    if (step.gates.some((g) => g.kind === "agent")) {
      lines.push("  - Allow more review rounds, and how many.");
      commands.push(`  - The owner grants more review rounds: run \`${ff} --more-rounds <n> --note "<the owner's decision>"\`.`);
    }
    lines.push(`  - ${backOption}`);
    commands.push(`  - ${backCommand}`);
  }
  return [...lines, "", "FOR YOU, NOT FOR THE OWNER: once the owner has decided, run the matching command.", ...commands];
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
  let inputs: Record<string, string> = {};
  if (!resumed) {
    const { errors } = crossCheck(root, path, wf);
    if (errors.length) throw new FlowError([`workflow ${wf.name} cannot start:`, ...errors.map((e) => `  ${e}`)].join("\n"));
    inputs = bindInputs(root, p, wf, slug, given);
  }
  updateWorkstream(
    root,
    slug,
    (ws) => {
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
  const header = [`${resumed ? "resumed" : "minted"} workstream ${slug}`, `workflow: ${path}`, `state:    ${workstreamFile(root, slug)}`];
  const base = baseText(root, ws, true);
  if (base) header.push(`base:     ${base}`);
  if (ws.after) header.push(`after:    ${ws.after}`);
  if (ws.parent) header.push(`parent:   step ${ws.parent.step} of workstream ${ws.parent.slug}, which waits for this one`);
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
  skip?: string;
  moreRounds?: number;
  backTo?: string;
  forwardTo?: string;
  updated: string[]; // absolute paths
  unchanged: Record<string, string>;
  notProduced: Record<string, string>;
}

export function continueWorkstream(root: string, slug: string, input: Continue): string[] {
  const initial = readWorkstream(root, slug);
  const c = context(root, slug, initial);
  handOut(c);
  const ws = readWorkstream(root, slug);
  const step = currentStep(c.wf, ws);
  if (!step) throw new FlowError("workflow complete; there is nothing to continue");
  const status = stateOf(ws, step.id).status;

  if (input.forwardTo !== undefined) return forwardTo(c, step, input.forwardTo, input.note);
  if (input.skip !== undefined) return skipStep(c, step, input.skip);
  if (input.moreRounds !== undefined) return grantRounds(c, step, input.moreRounds, input.note);
  if (input.backTo !== undefined) return sendBack(c, step, input.backTo, input.note, input.updated);
  if (input.ownerApproved) return approveStep(c, step, input.note);

  if (status === "AWAITING_OWNER" || status === "BLOCKED") {
    throw new FlowError(
      `step "${step.id}" is ${status}; only the owner can move it on, with --owner-approved, --back-to` +
        (status === "BLOCKED" ? " or --more-rounds" : ""),
    );
  }
  if (status === "PENDING") throw new FlowError(present(c).join("\n"));
  if (input.blocked !== undefined) return blockStep(c, step, input.blocked);
  return finishStep(c, step, input);
}

// The step must still be the current step, in one of `allowed`, when the
// state is written: another command may have moved it while this one ran.
function expectState(c: Ctx, ws: Workstream, step: Step, allowed: StepStatus[]): StepState {
  const state = stateOf(ws, step.id);
  if (currentStep(c.wf, ws) !== step || !allowed.includes(state.status)) {
    throw new FlowError(`step "${step.id}" is ${state.status} now; run the command again`);
  }
  return state;
}

function refuse(c: Ctx, step: Step, reason: string, output = "", verification?: string[]): FlowError {
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS"]);
    state.history.push(stamp(EVENT.refused(reason)));
    if (verification) state.verification = verification;
  });
  const ws = readWorkstream(c.root, c.slug);
  return new FlowError([reason, ...(output ? [output] : []), "", ...stepBlock(c, ws, step, stateOf(ws, step.id))].join("\n"));
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
      const rel = relative(c.p.root, resolve(name));
      const matches = isAbsolute(rel) || rel === ".." || rel.startsWith("../") ? [] : placed.filter((a) => tidy(a.path) === tidy(rel));
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
  const updated = [...new Set(input.updated.map((f) => display(c.p, f)))];

  // The child workstream comes first: the step's own work builds on it.
  const verification: string[] = [];
  const gate = childGate(step);
  if (gate) {
    const child = childOf(c, stateOf(readWorkstream(c.root, c.slug), step.id), step)!;
    let why: string | undefined;
    let run = true;
    try {
      why = childNotDone(c, step);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      why = e.message;
      run = false;
    }
    if (why) throw refuse(c, step, run ? `${why}. Run it to its end with \`${FUSE_FLOW} start ${child}\`, then continue this step.` : `${why}.`);
    verification.push(`workstream ${child} (${refName(c, gate.text)}): complete`);
  }

  const produced = place(c, step.produces);
  const missing = produced.filter((a) => !onDisk(c, a.path) && !has(input.notProduced, a.artifact.artifact));
  if (missing.length) {
    throw refuse(
      c,
      step,
      `missing artifact(s): ${missing.map((a) => `${a.path} (${a.artifact.artifact})`).join(", ")}. Write each, or report one ` +
        `the step rightly does not produce with --not-produced <artifact> "<reason>".`,
    );
  }
  const unaccounted = place(c, step.updates).filter(
    (a) => !has(input.unchanged, a.artifact.artifact) && !updated.some((f) => contains(a.path, f)),
  );
  if (unaccounted.length) {
    throw refuse(
      c,
      step,
      `not accounted for: ${unaccounted.map((a) => `${a.artifact.artifact} (${a.path})`).join(", ")}. Report each file you ` +
        `revised with --updated <file>, or an artifact you left as it was with --unchanged <artifact> "<reason>".`,
    );
  }
  // A folder that existed before the step, such as a research folder shared
  // with other work, does not say which files in it are this workstream's.
  const before = stateOf(readWorkstream(c.root, c.slug), step.id);
  const kept = (before.earlier_pass ?? []).filter((f) => onDisk(c, f));
  const shared = (a: Placed) => (before.existed ?? []).includes(a.path) && isFolder(c, a.path);
  const unnamed = produced.filter(
    (a) => !has(input.notProduced, a.artifact.artifact) && shared(a) && ![...updated, ...kept].some((f) => contains(a.path, f)),
  );
  if (unnamed.length) {
    throw refuse(
      c,
      step,
      unnamed
        .map(
          (a) =>
            `${a.path} (${a.artifact.artifact}) existed before the step: name each file the step wrote in it with ` +
            `--updated <file>, or report it with --not-produced ${a.artifact.artifact} "<reason>".`,
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
    return refuse(c, step, reason, output, verification);
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
    const state = expectState(c, ws, step, ["IN_PROGRESS"]);
    const status = awaitsOwner ? "draft" : "approved";
    // A folder artifact is recorded file by file when the agent named the
    // files it wrote in it, so the record says which files are this step's.
    const inFolders: string[] = [];
    const records: StepState["artifacts"] = [];
    for (const a of [...produced, ...place(c, step.optional_produces)]) {
      if (has(input.notProduced, a.artifact.artifact) || !onDisk(c, a.path)) continue;
      const files = isFolder(c, a.path) ? updated.filter((f) => contains(a.path, f) && onDisk(c, f)) : [];
      inFolders.push(...files);
      if (files.length) records.push(...files.map((path) => ({ artifact: a.artifact.artifact, path, status })));
      // A shared folder is never recorded whole; the files kept from an
      // earlier pass are added below.
      else if (!shared(a)) records.push({ artifact: a.artifact.artifact, path: a.path, status });
    }
    for (const a of place(c, step.updates)) {
      if (onDisk(c, a.path)) records.push({ artifact: a.artifact.artifact, path: a.path, status });
    }
    // Files from an earlier pass that are still there, and that the agent
    // kept rather than redid, stay recorded, unless the agent reported their
    // artifact not produced this time.
    for (const path of kept) {
      const artifact = artifactHolding(c, step, path);
      if (artifact !== undefined && has(input.notProduced, artifact)) continue;
      if (!records.some((r) => r.path === path)) records.push({ artifact, path, status });
    }
    state.artifacts = records;
    const rest = updated.filter((f) => !inFolders.includes(f));
    setOrDelete(state, "updated", rest.length ? rest : undefined);
    setOrDelete(state, "unchanged", Object.keys(input.unchanged).length ? input.unchanged : undefined);
    setOrDelete(state, "not_produced", Object.keys(input.notProduced).length ? input.notProduced : undefined);
    setOrDelete(state, "verification", verification.length ? verification : undefined);
    if (!awaitsOwner) delete state.earlier_pass;
    state.status = awaitsOwner ? "AWAITING_OWNER" : "COMPLETED";
    state.history.push(stamp(awaitsOwner ? EVENT.awaitingOwner() : EVENT.completed()));
  });
  return [`${step.id}: ${awaitsOwner ? "work recorded; the step awaits the owner's action" : "COMPLETED"}`, "", ...present(c)];
}

function setOrDelete<K extends keyof StepState>(state: StepState, key: K, value: StepState[K] | undefined): void {
  if (value === undefined) delete state[key];
  else state[key] = value;
}

function blockStep(c: Ctx, step: Step, reason: string): string[] {
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS"]);
    state.status = "BLOCKED";
    state.history.push(stamp(EVENT.blocked(reason)));
  });
  return [`${step.id}: BLOCKED: ${reason}`, "", ...present(c)];
}

function skipStep(c: Ctx, step: Step, reason: string): string[] {
  const dropped = dropUntouchedChild(c, step);
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED"]);
    state.status = "SKIPPED";
    state.skip_reason = reason;
    // An owner-action condition is the owner's answer, so its skip is the
    // owner's, like a skip of a step without a condition.
    const ownersCall = !step.condition || step.condition.kind === "owner-action";
    state.history.push(stamp(ownersCall ? EVENT.skippedOnRequest(reason) : EVENT.skipped(reason)));
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
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = expectState(c, ws, step, ["IN_PROGRESS", "BLOCKED"]);
    state.status = "IN_PROGRESS";
    state.rounds_granted = (state.rounds_granted ?? 0) + n;
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
  const earlier = unique([...(state.earlier_pass ?? []), ...state.artifacts.map((a) => a.path), ...(state.updated ?? [])]);
  if (earlier.length) state.earlier_pass = earlier;
  if (ran) state.pass = (state.pass ?? 1) + 1;
  state.status = "PENDING";
  for (const a of state.artifacts) if (a.status === "approved") a.status = "draft";
  for (const key of ["rounds_granted", "updated", "unchanged", "not_produced", "verification", "skip_reason"] as const) {
    delete state[key];
  }
  state.history.push(line);
}

// "If any of a, b keeps a status of its own ..." for the files that have a
// guide, and the same in plain words for the files that do not.
function statusReminder(c: Ctx, records: StepState["artifacts"], to: "draft" | "approved"): string[] {
  const seen = new Map<string, boolean>();
  for (const r of records) seen.set(r.path, (seen.get(r.path) ?? false) || hasGuide(c, r.artifact));
  const guided = [...seen].filter(([, g]) => g).map(([p]) => p);
  const plain = [...seen].filter(([, g]) => !g).map(([p]) => p);
  const set = to === "draft" ? "set it back to draft" : "set it to approved";
  const example = to === "draft" ? "'Status: approved'" : "'Status: draft'";
  return [
    ...(guided.length ? [`If any of ${guided.join(", ")} keeps a status of its own, as its guide says, ${set}.`] : []),
    ...(plain.length ? [`If any of ${plain.join(", ")} records a status of its own, such as a ${example} line, ${set}.`] : []),
  ];
}

// The owner sends the work back from the current step, whatever its status,
// to `target`, the step itself or an earlier one. What the current step has
// written so far is recorded as draft first, so its next pass can build on it.
function sendBack(c: Ctx, step: Step, target: string, note: string | undefined, given: string[]): string[] {
  const from = c.wf.steps.findIndex((s) => s.id === target);
  const at = c.wf.steps.indexOf(step);
  if (from < 0) throw new FlowError(`no step "${target}" in workflow ${c.wf.name}`);
  if (from > at) throw new FlowError(`step "${target}" comes after "${step.id}"; --back-to names "${step.id}" or a step before it`);
  const updated = unique(given.map((f) => display(c.p, f)));
  const reopened: StepState["artifacts"] = [];
  updateWorkstream(c.root, c.slug, (ws) => {
    const current = expectState(c, ws, step, ["PENDING", "IN_PROGRESS", "AWAITING_OWNER", "BLOCKED"]);
    const known = (path: string) => current.artifacts.some((a) => a.path === path);
    const existed = current.existed ?? [];
    for (const a of place(c, step.produces)) {
      if (!known(a.path) && onDisk(c, a.path) && !isFolder(c, a.path) && !existed.includes(a.path)) {
        current.artifacts.push({ artifact: a.artifact.artifact, path: a.path, status: "draft" });
      }
    }
    for (const path of updated) {
      if (!known(path)) current.artifacts.push({ artifact: artifactHolding(c, step, path), path, status: "draft" });
    }
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
  // An owner gate is reached only once the child is complete; a blocked step
  // may still wait for its child, and the owner's way past an unfinished
  // child is to skip the step.
  if (stateOf(readWorkstream(c.root, c.slug), step.id).status === "BLOCKED") {
    const pending = waitingFor(c, step);
    if (pending) {
      throw new FlowError(
        `step ${step.id} cannot complete yet: ${pending.why}. To go on without it, the owner skips the step: ` +
          `\`${FUSE_FLOW} continue ${c.slug} --skip "<the owner's reason>"\``,
      );
    }
  }
  let records: StepState["artifacts"] = [];
  updateWorkstream(c.root, c.slug, (ws) => {
    const state = stateOf(ws, step.id);
    if (state.status !== "AWAITING_OWNER" && state.status !== "BLOCKED") {
      throw new FlowError(`step "${step.id}" is ${state.status}, not awaiting the owner or blocked; finish it and run continue without --owner-approved`);
    }
    state.status = "COMPLETED";
    for (const a of state.artifacts) a.status = "approved";
    delete state.earlier_pass;
    records = state.artifacts;
    state.history.push(stamp(EVENT.approved(note)));
  });
  return [`${step.id}: owner approved; COMPLETED`, ...statusReminder(c, records, "approved"), "", ...present(c)];
}

// -------------------------------------------------------------------- status

export function status(root: string, slug: string): string[] {
  const ws = readWorkstream(root, slug);
  const c = context(root, slug, ws);
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
    const child = childGate(step) && !finished(state.status) ? state.children?.find((ch) => ch.pass === (state.pass ?? 1))?.slug : undefined;
    if (child) details.push(`waits for workstream ${child}, which ${whereIs(root, child)}`);
    else if (state.children?.length) details.push(`child workstream${state.children.length > 1 ? "s" : ""} ${state.children.map((ch) => ch.slug).join(", ")}`);
    const marker = step === current ? "> " : "  ";
    const columns = [step.id.padEnd(width), state.status.padEnd(14), `gates ${describeGates(step.gates).padEnd(6)}`];
    return `${marker}${[...columns, details.join("; ")].join("  ")}`.trimEnd();
  });
  const footer = current ? `current step: ${current.id}; ${FUSE_FLOW} start ${slug} prints what to do` : "workflow complete";
  const related = links(root, slug, ws);
  const header = [`workstream ${slug} (${c.wf.name})`];
  const base = baseText(root, ws, true);
  if (base) header.push(`  base: ${base}`);
  if (related.after) header.push(`  after: ${related.after}`);
  if (related.parent) header.push(`  child of: step ${related.parent.step} of workstream ${related.parent.slug}, which waits for it`);
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
      const c = context(root, slug, ws);
      const step = currentStep(c.wf, ws);
      const where = step ? `step ${step.id}, ${position(c, step)}, ${stateOf(ws, step.id).status}` : "workflow complete";
      const from = [ws.after && `after ${ws.after}`, ws.parent && `child of ${ws.parent.slug}, step ${ws.parent.step}`].filter(Boolean).join(", ");
      lines.push(`  ${slug} (${c.wf.name}, started ${c.date}${from ? `, ${from}` : ""}): ${where}`);
    } catch (e) {
      if (!(e instanceof FlowError)) throw e;
      lines.push(`  ${slug}: cannot be read: ${e.message}`);
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
        if (errors.length) {
          invalid += 1;
          lines.push(`invalid: ${file} refers to other workflows wrongly:`, ...errors.map((e) => `  ${e}`));
        } else {
          lines.push(`valid:   ${file}`);
        }
        lines.push(...warnings.map((w) => `  warning: ${w}`));
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
