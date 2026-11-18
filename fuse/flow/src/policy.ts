// SPDX-License-Identifier: Apache-2.0
// What the policy files and the libraries say for one project: the command a
// kind of check is bound to, the round cap and review guide of an agent gate,
// an artifact's path, guide and template. Each answer follows one override
// order, from the general to the specific: the engine's defaults, the user's
// policy, the workflow, the team's policy, the user's local policy for the
// project.

import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, type Stats, statSync } from "node:fs";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { FlowError } from "./errors.ts";
import { own } from "./own.ts";
import { libraryDirs, policyFiles } from "./project.ts";
import { describeGate } from "./parse.ts";
import { DEFAULT_MAX_ROUNDS, type Gate } from "./schemas/gate.ts";
import { LibraryEntrySchema } from "./schemas/library.ts";
import { type Policy, PolicySchema } from "./schemas/policy.ts";
import type { Artifact, Step } from "./schemas/step.ts";
import { isGuidePath, LIBRARY_GUIDE } from "./schemas/step.ts";
import type { Workflow } from "./schemas/workflow.ts";

interface Layer {
  file: string;
  policy: Policy;
}

export interface Project {
  root: string;
  user?: Layer;
  team?: Layer;
  local?: Layer;
}

function readLayer(file: string): Layer | undefined {
  if (!existsSync(file)) return undefined;
  let yaml: unknown;
  try {
    yaml = YAML.parse(readFileSync(file, "utf8")) ?? {};
  } catch (e) {
    throw new FlowError(`${file} is not valid YAML: ${(e as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(yaml);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".") || "(top level)"}: ${i.message}`);
    throw new FlowError(`${file} is not a valid policy file:\n${issues.join("\n")}`);
  }
  // Whether review.guide is there is checked where it applies, by
  // reviewGuideProblems: a more specific file's guide replaces it.
  return { file, policy: parsed.data };
}

// The local policy file is the user's own for this checkout, so the fuse-flow
// command line keeps it out of git, as it does the workstream state and the
// reviews. It writes the rule to the checkout's own exclude file, which is
// never committed, so keeping the file out adds no file to the project.
// Nothing to do while the file does not exist, or outside a repository whose
// root is this one.
// A failure here only says so: it never stops the command that called it.
export function ignoreLocalPolicy(root: string): void {
  const file = policyFiles(root).local;
  if (!existsSync(file)) return;
  const rel = relative(root, file);
  try {
    keepOutOfGit(root, rel);
  } catch (e) {
    process.stderr.write(`fuse-flow: could not keep ${rel} out of git: ${(e as Error).message}\n`);
  }
}

// Every command runs this, before it takes any workstream's lock, so several
// may run it at once, also from linked worktrees that share the exclude file:
// the exclude file is only ever appended to.
function keepOutOfGit(root: string, rel: string): void {
  const git = (...args: string[]) => spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  const top = git("rev-parse", "--show-toplevel");
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(root)) return;
  // Git's own answer is the authority. --no-index, so the answer is the
  // rules' also for a file git tracks. A rule that already ignores the file,
  // such as the .konductor/.gitignore earlier versions wrote, is left as it
  // is: fuse-flow never removes it, so the file is never left unprotected.
  const ignored = () => git("check-ignore", "-q", "--no-index", "--", rel).status === 0;
  if (ignored()) return;
  const info = git("rev-parse", "--git-path", "info/exclude");
  if (info.status !== 0) return;
  const exclude = resolve(root, info.stdout.trim());
  const line = `/${rel.split(sep).join("/")}`;
  const holds = () => (readIfThere(exclude) ?? "").split(/\r?\n/).includes(line);
  if (!holds()) {
    const text = readIfThere(exclude) ?? "";
    mkdirSync(dirname(exclude), { recursive: true });
    appendFileSync(exclude, `${text && !text.endsWith("\n") ? "\n" : ""}${line}\n`);
    if (!holds()) throw new Error(`the rule did not reach ${exclude}`);
  }
  // The exclude file ranks below the project's .gitignore files, so a rule
  // there can still un-ignore the file. fuse-flow does not edit the project's
  // ignore files; it says so.
  if (!ignored()) {
    process.stderr.write(
      `fuse-flow: ${rel} is still not ignored after fuse-flow added it to ${relative(root, exclude)}: a rule in the ` +
        "project's ignore files un-ignores it. Tell the owner, and keep the file out of commits.\n",
    );
  }
}

// A file's text, or undefined when it is not there.
function readIfThere(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export function loadProject(root: string): Project {
  const files = policyFiles(root);
  const user = readLayer(files.user);
  // The user's policy fills in only what a workflow leaves open, and a
  // workflow always says where each artifact goes, so an artifact path in the
  // user's file could never take effect. Refuse it instead of ignoring it.
  if (user?.policy.artifacts) {
    throw new FlowError(
      `${user.file} sets artifacts, which only a project's policy can do: a workflow always says where its ` +
        `artifacts go, and this file fills in only what a workflow leaves open. Move the entry to ` +
        `.konductor/policy-overrides.yml or .konductor/policy-overrides.local.yml in the project.`,
    );
  }
  return { root, user, team: readLayer(files.team), local: readLayer(files.local) };
}

// The project's layers, most specific first, then the user's.
const projectLayers = (p: Project) => [p.local, p.team].filter((l): l is Layer => l !== undefined);

// A path as the agent should see it: relative to the repository root when it
// is inside it.
export function display(p: Project, path: string): string {
  const rel = relative(p.root, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

// ------------------------------------------------------------------ checks

export type CheckBinding = { command: string; file: string } | { command: "none"; file: string } | undefined;

export function checkBinding(p: Project, kind: string): CheckBinding {
  for (const layer of [p.local, p.team, p.user]) {
    const command = own(layer?.policy.checks, kind);
    if (command !== undefined) return { command, file: layer!.file };
  }
  return undefined;
}

// ------------------------------------------------------------------ review

export function maxRounds(p: Project, gate: Gate): number {
  for (const layer of projectLayers(p)) {
    if (layer.policy.review?.max_rounds !== undefined) return layer.policy.review.max_rounds;
  }
  return gate.max_rounds ?? p.user?.policy.review?.max_rounds ?? DEFAULT_MAX_ROUNDS;
}

export function reviewer(p: Project): string | undefined {
  for (const layer of [p.local, p.team, p.user]) {
    if (layer?.policy.review?.reviewer) return layer.policy.review.reviewer;
  }
  return undefined;
}

export type Launch = "subagent" | { command: string };
export type Reviewers = Record<string, { model: string; effort?: string; launch?: Launch }>;

// The reviewer for each author model, merged across the layers: a more
// specific file's row for a model replaces a more general file's.
export function reviewers(p: Project): Reviewers {
  return Object.assign({}, p.user?.policy.review?.reviewers, p.team?.policy.review?.reviewers, p.local?.policy.review?.reviewers);
}

export function launch(p: Project): Launch {
  return launchSetting(p) ?? "subagent";
}

// The launch a policy file sets, if any. Without one, the house rules may
// still say how reviewers are started.
export function launchSetting(p: Project): Launch | undefined {
  for (const layer of [p.local, p.team, p.user]) {
    if (layer?.policy.review?.launch) return layer.policy.review.launch;
  }
  return undefined;
}

// Every layer's rulings, the user's first and the local file's last.
export function rulings(p: Project): string[] {
  return [p.user, p.team, p.local].flatMap((l) => l?.policy.rulings ?? []);
}

// What start does about a checkout that is not a clean branch of its own.
export function checkoutSetting(p: Project): "warn" | "refuse" {
  for (const layer of [p.local, p.team, p.user]) {
    if (layer?.policy.checkout) return layer.policy.checkout;
  }
  return "warn";
}

// After how many days without a recorded change an unfinished workstream is idle.
export function idleDays(p: Project): number {
  for (const layer of [p.local, p.team, p.user]) {
    if (layer?.policy.idle_days !== undefined) return layer.policy.idle_days;
  }
  return 7;
}

function policyGuide(layer: Layer | undefined): string | undefined {
  const guide = layer?.policy.review?.guide;
  return guide === undefined ? undefined : isAbsolute(guide) ? guide : resolve(dirname(layer!.file), guide);
}

export type ReviewGuideSource =
  | "local policy"
  | "team policy"
  | "project library"
  | "gate"
  | "user policy"
  | "user library"
  | "package library";

// What a guide is to a review: the artifact's authoring guide, which says how
// a good artifact is built; the artifact's own review guide, its review.md;
// or the guide of the gate, which says how this workflow reviews.
export type ReviewGuideRole = "authoring" | "review" | "gate";

export interface AppliedGuide {
  path: string;
  source: ReviewGuideSource;
  role: ReviewGuideRole;
}

const LIBRARY_SOURCE: Record<LibraryLevel, ReviewGuideSource> = {
  project: "project library",
  user: "user library",
  package: "package library",
};

// How much of a guide is read to find its front matter.
const FRONT_MATTER_BYTES = 16 * 1024;

// The start of a guide, if it is a regular file; undefined otherwise. A
// device or a pipe named as a guide is never read. `authorize`, given the
// opened file's status, decides whether it may be read, so a caller that
// limits which files it reads checks the file actually opened.
export function guideStart(path: string, authorize?: (opened: Stats) => boolean): string | undefined {
  try {
    // Opened without blocking and checked through the descriptor, so a pipe
    // swapped in after a check of the path cannot hold the read.
    const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || (authorize && !authorize(opened))) return undefined;
      const buffer = Buffer.alloc(FRONT_MATTER_BYTES);
      return buffer.toString("utf8", 0, readSync(fd, buffer, 0, buffer.length, 0));
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

// Whether a guide's text hands the gate's judgement to the agent that did the
// work: its YAML front matter sets `judged_by: working-agent`.
export function declaresWorkingAgent(text: string | undefined): boolean {
  const front = text === undefined ? null : /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/.exec(text);
  if (!front) return false;
  try {
    const data = YAML.parse(front[1]);
    return data !== null && typeof data === "object" && (data as Record<string, unknown>).judged_by === "working-agent";
  } catch {
    return false;
  }
}

// Whether a guide file hands the judgement to the agent that did the work. A
// guide that is not a regular file, or cannot be read, does not.
export const judgedByWorkingAgent = (path: string | undefined) => (path ? declaresWorkingAgent(guideStart(path)) : false);

// Whether the agent that did the work judges agent gate `gate` itself, by the
// gate's own guide, rather than an independent reviewer. `read` gives the
// guide's text; a caller that may read only some files, such as Komposer's
// server, passes its own reader.
export const workingAgentJudges = (gate: Gate, read: (path: string) => string | undefined = guideStart) =>
  gate.kind === "agent" && gate.guide !== undefined && declaresWorkingAgent(read(gate.guide));

// The guide a gate applies to every artifact it reviews, and which layer it
// comes from: a team's or local policy's review.guide replaces the gate's
// guide, which replaces the user's policy's. Undefined when there is none. A
// gate whose guide hands the judgement to the working agent keeps that guide:
// a review guide written for reviewers does not say how to judge it.
export function gateReviewGuide(
  p: Project,
  gate: Gate,
  read?: (path: string) => string | undefined,
): { path: string; source: ReviewGuideSource } | undefined {
  if (workingAgentJudges(gate, read)) return { path: gate.guide!, source: "gate" };
  const order: [ReviewGuideSource, () => string | undefined][] = [
    ["local policy", () => policyGuide(p.local)],
    ["team policy", () => policyGuide(p.team)],
    ["gate", () => gate.guide],
    ["user policy", () => policyGuide(p.user)],
  ];
  for (const [source, find] of order) {
    const path = find();
    if (path) return { path, source };
  }
  return undefined;
}

// Every guide an agent gate's reviewer follows for one of the step's
// artifacts, or for the step itself when `artifactId` is undefined: the
// artifact's authoring guide, its review.md and the gate's guide, in that
// order. An artifact's guides come from the winning library entry only: the
// entry wins as a whole, and the libraries it replaces are not looked at. The
// guides add up, so a gate's guide never hides how the artifact is built or
// checked. Two of them may be the same file; each keeps its own role and
// source, so the gate's guide is still checked and a policy's is still the
// owner's. Callers that read or show the files name each file once.
export function reviewGuides(p: Project, gate: Gate, artifactId: string | undefined, read?: (path: string) => string | undefined): AppliedGuide[] {
  // The working agent judges by the gate's guide alone; the artifacts' review
  // guides are written for an independent reviewer.
  if (workingAgentJudges(gate, read)) return [{ path: gate.guide!, source: "gate", role: "gate" }];
  const found: AppliedGuide[] = [];
  const add = (g: AppliedGuide) => found.push(g);
  const entry = artifactId ? libraryEntry(p, artifactId) : undefined;
  if (entry) {
    const source = LIBRARY_SOURCE[entry.level];
    if (entry.guide) add({ path: entry.guide, source, role: "authoring" });
    const review = existing(join(entry.folder, "review.md"));
    if (review) add({ path: review, source, role: "review" });
  }
  const fromGate = gateReviewGuide(p, gate, read);
  if (fromGate) add({ ...fromGate, role: "gate" });
  return found;
}

// Why a review guide cannot be followed, or undefined when it can: the step
// block tells the reviewer to follow it, so it must be a file, a symlink to
// one counting as one.
function notAGuide(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return stat.isFile() ? undefined : stat.isDirectory() ? "is a folder, not a file" : "is not a file";
  } catch {
    return "does not exist";
  }
}

// The review guides the workflow's agent gates use, once the policy files and
// the libraries have had their say, that cannot be followed: one line each,
// naming where the guide was set. A gate's guide that a policy's replaces is
// never read, so it need not exist. An authoring guide that cannot be read is
// the author's concern, and the step block says so. `file` is the workflow
// file. With `only`, the steps it names; the step block prints the guides of
// those alone.
export function reviewGuideProblems(
  p: Project,
  wf: Workflow,
  file: string,
  only?: (step: Step) => boolean,
  read?: (path: string) => string | undefined,
): string[] {
  return reviewGuideFindings(p, wf, file, only, read).map((f) => f.line);
}

// A reader that reads no guide, for a caller that must not open files. With it,
// whether a gate's own guide hands the judgement to the working agent is not known.
export const READS_NO_GUIDE = (_path: string): string | undefined => undefined;

// reviewGuideProblems with, for each line, whether it is uncertain: given
// READS_NO_GUIDE, a line about a policy's or an artifact's review guide on a gate
// that has a guide of its own is uncertain, since the gate's guide may declare the
// working agent, and then no other review guide applies. Every other line is certain.
export function reviewGuideFindings(
  p: Project,
  wf: Workflow,
  file: string,
  only?: (step: Step) => boolean,
  read?: (path: string) => string | undefined,
): { line: string; uncertain: boolean }[] {
  const problems = new Map<string, boolean>();
  const add = (line: string, uncertain: boolean) => problems.set(line, (problems.get(line) ?? true) && uncertain);
  wf.steps.forEach((step, i) => {
    if (only && !only(step)) return;
    const ids = [...step.produces, ...step.optional_produces, ...step.updates].map((a) => a.artifact);
    for (const gate of step.gates) {
      if (gate.kind !== "agent") continue;
      const applied = (ids.length ? ids : [undefined]).flatMap((id) => reviewGuides(p, gate, id, read).map((found) => ({ id, found })));
      for (const { id, found } of applied) {
        const why = found.role !== "authoring" && notAGuide(found.path);
        if (!why) continue;
        const layer = { "local policy": p.local, "team policy": p.team, "user policy": p.user }[found.source as string];
        const uncertain = read === READS_NO_GUIDE && gate.guide !== undefined && found.source !== "gate";
        if (layer) add(`${layer.file} sets review.guide to ${layer.policy.review?.guide}, and ${found.path} ${why}`, uncertain);
        else if (found.source === "gate") add(`${file}: steps.${i} (${step.id}): the review guide of ${describeGate(gate)} ${why}: ${found.path}`, false);
        else add(`the review guide ${found.path} of artifact ${id} ${why}`, uncertain);
      }
    }
  });
  return [...problems].map(([line, uncertain]) => ({ line, uncertain }));
}

// Refuse a workflow whose review guides, as they apply, cannot be followed;
// with `only`, in the steps it names.
export function refuseBadReviewGuides(p: Project, wf: Workflow, file: string, only?: (step: Step) => boolean): void {
  const problems = reviewGuideProblems(p, wf, file, only);
  if (problems.length) throw new FlowError(`a review guide cannot be followed:\n${problems.map((l) => `  ${l}`).join("\n")}`);
}

// Whether a review guide comes from where the owner or the project put it, in
// their own library or a policy file, rather than shipping with fuse or with
// the workflow. Such a guide is a house rule: a shipped step instruction does
// not win over it by default. Decided by where the guide was found, not where
// a symlinked file leads. A gate's guide is the owner's when the gate names a
// file in the project's or the user's library, by the path the gate gives.
export function ownersReviewGuide(p: Project, found: { path: string; source: ReviewGuideSource }, gate?: Gate): boolean {
  if (found.source === "package library") return false;
  if (found.source !== "gate") return true;
  const named = gate?.guide;
  if (!named) return false;
  const dirs = libraryDirs(p.root);
  return [dirs.project, dirs.user].some((dir) => named.startsWith(join(dir, "artifacts") + sep));
}

// ------------------------------------------------------------------ step guides

// One guide a step names, as it applies in this project: `ref` as the
// workflow writes it, `path` the real path of the file it names when there is
// one, and `problem` why it names none. A library guide comes from the entry
// that wins, as an artifact's guide does; a path is relative to the workflow
// file `file`, or absolute, as a gate's guide is. `owners` says whether the
// guide is the owner's or the project's own, by the same rule as review
// guides: found in the project's or the user's library.
export interface StepGuide {
  ref: string;
  path?: string;
  problem?: string;
  owners: boolean;
}

export function stepGuides(p: Project, step: Step, file: string): StepGuide[] {
  const dirs = libraryDirs(p.root);
  const inOwnLibrary = (path: string) => [dirs.project, dirs.user].some((dir) => path.startsWith(join(dir, "artifacts") + sep));
  return step.guides.map((ref) => {
    if (isGuidePath(ref)) {
      const named = isAbsolute(ref) ? ref : resolve(dirname(file), ref);
      const why = notAGuide(named);
      return why ? { ref, problem: `${why}: ${named}`, owners: false } : { ref, path: realpathSync(named), owners: inOwnLibrary(named) };
    }
    const [, id, name] = LIBRARY_GUIDE.exec(ref)!;
    const entry = libraryEntry(p, id);
    if (!entry) return { ref, problem: `names ${id}, which no library has`, owners: false };
    const named = join(entry.folder, name);
    const why = notAGuide(named);
    return why ? { ref, problem: `${why}: ${named}`, owners: false } : { ref, path: realpathSync(named), owners: entry.level !== "package" };
  });
}

// The step guides of workflow `wf`, saved at `file`, that name no file: for
// each, the index of its step, the line that names the step and the guide as
// the workflow writes it, and the line without the place it starts with.
export function stepGuideProblems(p: Project, wf: Workflow, file: string): { step: number; line: string; detail: string }[] {
  return wf.steps.flatMap((step, i) =>
    stepGuides(p, step, file)
      .filter((g) => g.problem)
      .map((g) => {
        const detail = `the guide ${g.ref} ${g.problem}`;
        return { step: i, line: `${file}: steps.${i} (${step.id}): ${detail}`, detail };
      }),
  );
}

// ------------------------------------------------------------------ artifacts

// Where an artifact lives in this workstream, relative to the repository root.
// `date` is the day the workstream started, YYYY-MM-DD, so the path stays the
// same for the whole workstream.
export function artifactPath(p: Project, artifact: Artifact, slug: string, date: string): string {
  const override = projectLayers(p)
    .map((l) => own(l.policy.artifacts, artifact.artifact))
    .find((o) => o !== undefined);
  const path = (override?.path ?? artifact.path).replaceAll("{slug}", slug).replaceAll("{date}", date);
  // In the form the agent's files are reported in, so docs/../src/ holds
  // src/a.ts. normalize keeps a trailing slash.
  return posix.normalize(path);
}

function existing(path: string): string | undefined {
  // The real path, so a guide that is a symlink to a skill's SKILL.md is read
  // where its relative references work.
  return existsSync(path) ? realpathSync(path) : undefined;
}

// Every entry folder below <library>/artifacts/, at any depth, following
// symlinks. A folder that holds only folders groups entries; any other folder
// is an entry, named by the folder, so an id is found wherever it is filed.
// `group` is the path of the grouping folders above it, "" at the top.
export interface EntryFolder {
  id: string;
  folder: string;
  group: string;
}

function entryFoldersIn(libraryDir: string): EntryFolder[] {
  const base = join(libraryDir, "artifacts");
  if (!statSafe(base)) return [];
  const seen = new Set<string>();
  const found: EntryFolder[] = [];
  const walk = (folder: string, group: string) => {
    const real = realpathSync(folder);
    if (seen.has(real)) return; // a symlink loop is walked once
    seen.add(real);
    for (const name of readdirSync(folder).sort()) {
      const path = join(folder, name);
      if (name.startsWith(".") || !statSafe(path)) continue;
      // Hidden files count: a .keep makes a folder an entry with no guide.
      const children = readdirSync(path);
      if (children.length > 0 && children.every((c) => statSafe(join(path, c)))) {
        walk(path, group ? `${group}/${name}` : name);
      } else {
        found.push({ id: name, folder: path, group });
      }
    }
  };
  walk(base, "");
  return found;
}

// An id's folder in one library. An id filed twice in one library is refused
// rather than guessed, as a workflow name is.
function entryFolder(libraryDir: string, id: string): string | undefined {
  const matches = entryFoldersIn(libraryDir).filter((e) => e.id === id);
  if (matches.length > 1) {
    throw new FlowError(`artifact "${id}" is ambiguous; rename one of: ${matches.map((m) => m.folder).join(", ")}`);
  }
  return matches[0]?.folder;
}

// An artifact's folder in the library: the project's own replaces the user's,
// which replaces the package's. Its guide and template
// come from that folder only; undefined when no library has the artifact. A
// folder without guide.md is an artifact without a guide; a guide.md that
// cannot be read, such as a symlink to a skill that is not installed, is a
// missing guide.
export function libraryEntry(
  p: Project,
  id: string,
): { folder: string; level: LibraryLevel; guide?: string; guideMissing?: string; template?: string } | undefined {
  const dirs = libraryDirs(p.root);
  // The first library that has the id wins; the ones it replaces are not looked at.
  let folder: string | undefined;
  let level: LibraryLevel = "package";
  for (const [l, dir] of [["project", dirs.project], ["user", dirs.user], ["package", dirs.package]] as const) {
    folder = entryFolder(dir, id);
    level = l;
    if (folder) break;
  }
  if (!folder) return undefined;
  const template = readdirSync(folder)
    .sort()
    .find((f) => /^template\.[^.]+$/.test(f));
  const guidePath = join(folder, "guide.md");
  const guide = existing(guidePath);
  const linked = !guide && isSymlink(guidePath);
  return { folder, level, guide, guideMissing: linked ? guidePath : undefined, template: template && existing(join(folder, template)) };
}

export type LibraryLevel = "project" | "user" | "package";

export interface LibraryListing {
  id: string;
  level: LibraryLevel;
  folder: string;
  // The grouping folders between artifacts/ and the entry, such as "writing"; "" at the top.
  group: string;
  guide?: string;
  guideMissing?: string;
  template?: string;
  // The template's file name in the folder, such as template.md.
  templateFile?: string;
  review?: string;
  // From the folder's entry.yml, when it has one that matches its schema.
  description?: string;
  // Why entry.yml could not be read, when it exists but does not match.
  entryProblem?: string;
  // The level of the entry with the same id that this one replaces, or that
  // replaces it: the most specific level wins as a whole.
  hides?: LibraryLevel;
  hiddenBy?: LibraryLevel;
}

// Every entry in the three libraries, at any depth, most specific level first.
export function listLibrary(root: string): LibraryListing[] {
  const dirs = libraryDirs(root);
  const levels: LibraryLevel[] = ["project", "user", "package"];
  const found: LibraryListing[] = [];
  for (const level of levels) {
    const inLevel = entryFoldersIn(dirs[level]);
    for (const { id, folder, group } of inLevel) {
      const twins = inLevel.filter((e) => e.id === id && e.folder !== folder);
      const files = readdirSync(folder).sort();
      const template = files.find((f) => /^template\.[^.]+$/.test(f));
      const guidePath = join(folder, "guide.md");
      const guide = existing(guidePath);
      const linked = !guide && isSymlink(guidePath);
      const entryFile = readEntryFile(join(folder, "entry.yml"));
      if (twins.length) {
        entryFile.entryProblem = `the id is ambiguous in this library; rename one of: ${[folder, ...twins.map((t) => t.folder)].join(", ")}`;
      }
      found.push({
        id,
        level,
        folder,
        group,
        ...(guide ? { guide } : {}),
        ...(linked ? { guideMissing: guidePath } : {}),
        ...(template && existing(join(folder, template)) ? { template: existing(join(folder, template)), templateFile: template } : {}),
        ...(existing(join(folder, "review.md")) ? { review: existing(join(folder, "review.md")) } : {}),
        ...entryFile,
      });
    }
  }
  for (const entry of found) {
    const same = found.filter((e) => e.id === entry.id);
    const winner = same[0];
    if (winner === entry && same.length > 1) entry.hides = same[1].level;
    if (winner !== entry) entry.hiddenBy = winner.level;
  }
  return found;
}

// An entry's entry.yml. A file that does not match its schema is reported on
// the entry, so one bad file does not hide the rest of the library.
function readEntryFile(path: string): { description?: string; entryProblem?: string } {
  if (!existsSync(path)) return {};
  let yaml: unknown;
  try {
    yaml = YAML.parse(readFileSync(path, "utf8")) ?? {};
  } catch (e) {
    return { entryProblem: `${path} is not valid YAML: ${(e as Error).message}` };
  }
  const parsed = LibraryEntrySchema.safeParse(yaml);
  if (parsed.success) return { description: parsed.data.description };
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(top level)"}: ${i.message}`);
  return { entryProblem: `${path}: ${issues.join("; ")}` };
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}
