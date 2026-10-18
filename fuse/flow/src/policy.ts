// SPDX-License-Identifier: Apache-2.0
// What the policy files and the libraries say for one project: the command a
// kind of check is bound to, the round cap and review guide of an agent gate,
// an artifact's path, guide and template. Each answer follows one override
// order, from the general to the specific: the engine's defaults, the user's
// policy, the workflow, the team's policy, the user's local policy for the
// project.

import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { FlowError } from "./errors.ts";
import { own } from "./own.ts";
import { libraryDirs, policyFiles } from "./project.ts";
import { describeGate } from "./parse.ts";
import { DEFAULT_MAX_ROUNDS, type Gate } from "./schemas/gate.ts";
import { LibraryEntrySchema } from "./schemas/library.ts";
import { type Policy, PolicySchema } from "./schemas/policy.ts";
import type { Artifact, Step } from "./schemas/step.ts";
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
// reviews: with a line in .konductor/.gitignore, unless git already ignores
// it. Nothing to do while the file does not exist.
export function ignoreLocalPolicy(root: string): void {
  const file = policyFiles(root).local;
  if (!existsSync(file)) return;
  const name = basename(file);
  // Git's own answer is the authority where there is one: when it says the
  // file is not ignored, a line of ours goes last, and git then says it is.
  // --no-index, so the answer is the rules' also for a file git tracks.
  const ignored = spawnSync("git", ["-C", root, "check-ignore", "-q", "--no-index", "--", relative(root, file)]);
  if (ignored.status === 0) return;
  const gitignore = join(dirname(file), ".gitignore");
  const text = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  // Without an answer from git, as outside a repository, our own line is
  // taken as enough, so it is not added twice.
  if (ignored.status !== 1 && text.split(/\r?\n/).includes(`/${name}`)) return;
  try {
    writeFileSync(gitignore, `${text}${text && !text.endsWith("\n") ? "\n" : ""}/${name}\n`);
  } catch (e) {
    process.stderr.write(`fuse-flow: could not add ${name} to ${gitignore}: ${(e as Error).message}\n`);
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

// The review guide an agent gate uses for one of the step's artifacts, and
// which layer it comes from, or undefined when there is none: the generic
// review text applies then.
export function reviewGuideSource(
  p: Project,
  gate: Gate,
  artifactId: string | undefined,
): { path: string; source: ReviewGuideSource } | undefined {
  const dirs = libraryDirs(p.root);
  // Only the winning entry's review.md counts: the entry wins as a whole, as
  // for its guide and template, and the libraries it replaces are not looked at.
  const winner = artifactId ? libraryEntry(p, artifactId)?.folder : undefined;
  const inLibrary = (dir: string) =>
    winner && winner.startsWith(join(dir, "artifacts") + sep) ? existing(join(winner, "review.md")) : undefined;
  const order: [ReviewGuideSource, () => string | undefined][] = [
    ["local policy", () => policyGuide(p.local)],
    ["team policy", () => policyGuide(p.team)],
    ["project library", () => inLibrary(dirs.project)],
    ["gate", () => gate.guide],
    ["user policy", () => policyGuide(p.user)],
    ["user library", () => inLibrary(dirs.user)],
    ["package library", () => inLibrary(dirs.package)],
  ];
  for (const [source, find] of order) {
    const path = find();
    if (path) return { path, source };
  }
  return undefined;
}

export function reviewGuide(p: Project, gate: Gate, artifactId: string | undefined): string | undefined {
  return reviewGuideSource(p, gate, artifactId)?.path;
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
// naming where the guide was set. A guide that a more specific one replaces is
// never read, so it need not exist. `file` is the workflow file. With
// `only`, the steps it names; the step block prints the guides of those alone.
export function reviewGuideProblems(p: Project, wf: Workflow, file: string, only?: (step: Step) => boolean): string[] {
  const problems = new Set<string>();
  wf.steps.forEach((step, i) => {
    if (only && !only(step)) return;
    const ids = [...step.produces, ...step.optional_produces, ...step.updates].map((a) => a.artifact);
    for (const gate of step.gates) {
      if (gate.kind !== "agent") continue;
      for (const id of ids.length ? ids : [undefined]) {
        const found = reviewGuideSource(p, gate, id);
        const why = found && notAGuide(found.path);
        if (!found || !why) continue;
        const layer = { "local policy": p.local, "team policy": p.team, "user policy": p.user }[found.source as string];
        if (layer) problems.add(`${layer.file} sets review.guide to ${layer.policy.review?.guide}, and ${found.path} ${why}`);
        else if (found.source === "gate") problems.add(`${file}: steps.${i} (${step.id}): the review guide of ${describeGate(gate)} ${why}: ${found.path}`);
        else problems.add(`the review guide ${found.path} of artifact ${id} ${why}`);
      }
    }
  });
  return [...problems];
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
