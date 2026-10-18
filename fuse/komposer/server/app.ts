// SPDX-License-Identifier: Apache-2.0
// Komposer's local server: the JSON API the app uses to read and write the
// workflow files and the library of one project, to show the workstreams of
// that project, of every project in ~/.konductor/projects.yml and of the
// example runs that ship with Komposer, and the
// built app itself. Every location rule comes from fuse-flow's own code.
//
// The server writes files, so it guards itself: it listens on 127.0.0.1 only,
// wants the token it was started with on every API request, refuses a foreign
// Host header (DNS rebinding), and writes only .yml and .yaml files inside
// the three workflow locations, its own working-copy folder and the projects
// list, judged by the real path a write leads to, with symlinks resolved. The
// workflow files of another project are read, never written. It
// reads a review guide
// that a workflow names only when the guide's real path, with symlinks
// resolved, lies inside the project, the three libraries or the three
// workflow locations, or is a file of a shipped package-library entry; any other guide is
// reported as outside those locations, without its content.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { summarizeRun, runEvents } from "../../flow/src/history.ts";
import { parseWorkflowText } from "../../flow/src/parse.ts";
import { display, libraryEntry, listLibrary, loadProject, reviewGuideSource } from "../../flow/src/policy.ts";
import { findRepoRoot, isDirectory, libraryDirs, policyFiles, projectsFile, workflowDirs, workflowFilesBelow, workstreamsDir } from "../../flow/src/project.ts";
import { readProjects, registerProject, unregisterProject } from "../../flow/src/registry.ts";
import { listWorkstreams, type WorkstreamListing } from "../../flow/src/workstream.ts";

export interface ServerOptions {
  root: string;
  port: number;
  token: string;
  // The built app (dist/); not served when absent.
  appDir?: string;
  // A folder of example runs that ships with Komposer, listed after the
  // other projects so a fresh clone has runs to show; never registered.
  examplesDir?: string;
}

export interface KomposerServer {
  url: string;
  stop(): void;
}

type LocationId = "project" | "personal" | "fuse-flow";

interface Location {
  id: LocationId;
  label: string;
  path: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const FILE_NAME = /^[a-z0-9][a-z0-9-]*$/;
const FOLDER_NAME = /^[a-z0-9][a-z0-9._-]*$/;
// The files fuse-flow reads a workflow from; a name it looks up is <name>.yml.
const WORKFLOW_FILE = /\.ya?ml$/;

// How far below the folder given to "add projects" Komposer looks for runs,
// and how many folders it reads at most, so a home directory stays quick.
const SCAN_DEPTH = 4;
const SCAN_FOLDERS = 20_000;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// The real form of a path, with every symlink resolved, also when its last
// parts do not exist yet: the real path of the nearest part that exists, with
// the missing parts appended. A path that leads through a symlink whose
// target is missing has none.
function realForm(path: string): string | undefined {
  const missing: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      lstatSync(at);
      break;
    } catch {
      const up = dirname(at);
      if (up === at) break;
      missing.unshift(basename(at));
      at = up;
    }
  }
  try {
    return join(realpathSync(at), ...missing);
  } catch {
    return undefined;
  }
}

// Whether a path is one of the folders or lies below one.
const within = (path: string, folders: string[]) => folders.some((f) => path === f || path.startsWith(f + sep));

// Whether a project has at least one workstream state file. A folder that
// cannot be read has none that Komposer could show.
const hasRuns = (project: string) => {
  try {
    return isDirectory(workstreamsDir(project)) && readdirSync(workstreamsDir(project)).some((n) => n.endsWith(".yml"));
  } catch {
    return false;
  }
};

// Every project at or below `dir` that has runs: a folder holding
// .konductor/workstreams/*.yml. Folders inside .konductor, .git and
// node_modules are not searched; worktrees below a project are. A folder
// reached again, through a symlink, is searched again only when it is now
// fewer levels down, so its folders within the depth limit are not missed.
// `truncated` says the scan stopped at the folder limit.
function findProjects(dir: string): { found: string[]; truncated: boolean } {
  const found = new Set<string>();
  let truncated = false;
  // Each real folder read, by the fewest levels down it was reached at.
  const seen = new Map<string, number>();
  const walk = (folder: string, depth: number) => {
    let real: string;
    try {
      real = realpathSync(folder);
    } catch {
      return;
    }
    const before = seen.get(real);
    if (before !== undefined && before <= depth) return;
    if (before === undefined && seen.size >= SCAN_FOLDERS) {
      truncated = true;
      return;
    }
    seen.set(real, depth);
    if (hasRuns(real)) found.add(real);
    if (depth === SCAN_DEPTH) return;
    let names: string[];
    try {
      names = readdirSync(real).sort();
    } catch {
      return; // not readable
    }
    for (const name of names) {
      if (name === ".konductor" || name === ".git" || name === "node_modules") continue;
      const path = join(real, name);
      if (isDirectory(path)) walk(path, depth + 1);
    }
  };
  walk(dir, 0);
  return { found: [...found], truncated };
}

export function startServer(options: ServerOptions): KomposerServer {
  const { root, token } = options;
  const examples = options.examplesDir && isDirectory(options.examplesDir) ? realpathSync(options.examplesDir) : undefined;
  const [project, personal, pkg] = workflowDirs(root);
  const locations: Location[] = [
    { id: "project", label: "Project", path: project },
    { id: "personal", label: "Personal", path: personal },
    { id: "fuse-flow", label: "fuse-flow", path: resolve(pkg) },
  ];
  const editorDir = join(root, ".konductor", "editor");

  // A path in the form Komposer lists it. One that lies in a workflow
  // location only by its real folder, such as a personal workflow that a run
  // names by the real path of a symlinked home directory, is given in the
  // location's own form, so it is listed once and can be saved. The file
  // itself is not resolved, so a workflow linked in from elsewhere keeps its
  // place in the location.
  const listedForm = (path: string): string => {
    const full = resolve(path);
    if (locations.some((l) => full.startsWith(l.path + sep))) return full;
    const folder = realForm(dirname(full));
    if (!folder) return full;
    const real = join(folder, basename(full));
    for (const location of locations) {
      const base = realForm(location.path);
      if (base && real.startsWith(base + sep)) return join(location.path, relative(base, real));
    }
    return full;
  };

  // The location a path is in, by its listed form, and only for .yml and
  // .yaml files, the two fuse-flow reads a workflow from.
  const locate = (path: unknown): { location: Location; path: string; rel: string } => {
    if (typeof path !== "string" || !path) throw new HttpError(400, "path is required");
    const full = listedForm(path);
    if (!WORKFLOW_FILE.test(full)) throw new HttpError(403, `${full} is not a .yml or .yaml file`);
    for (const location of locations) {
      if (full.startsWith(location.path + sep)) return { location, path: full, rel: relative(location.path, full) };
    }
    throw new HttpError(403, `${full} is not inside a workflow location`);
  };

  const workingCopyPath = (location: Location, rel: string) => join(editorDir, location.id, rel);
  const inLocation = (path: string) => locations.some((l) => listedForm(path).startsWith(l.path + sep));

  // Every write is judged by the real path it leads to, with symlinks
  // resolved, as a review guide's read is: a workflow file must lead to a
  // .yml or .yaml file inside the real folder of a workflow location, and a
  // working copy or its .gitignore to a file inside the project's own
  // working-copy folder, which must not be a link itself. A link that leads
  // elsewhere, such as a team/ folder linked to another repository, is
  // refused.
  const writable = (path: string, roots: (string | undefined)[], pattern: RegExp, what: string) => {
    const real = realForm(path);
    if (real && pattern.test(real) && within(real, roots.filter((r): r is string => !!r))) return;
    throw new HttpError(403, `${path} leads to ${real ?? "a link whose target is missing"}, which is not ${what}`);
  };
  const workflowWritable = (path: string) =>
    writable(path, locations.map((l) => realForm(l.path)), WORKFLOW_FILE, "a .yml or .yaml file inside a workflow location");
  const editorRoot = () => {
    const konductor = realForm(join(root, ".konductor"));
    return konductor ? join(konductor, "editor") : undefined;
  };
  // A working copy's path, once it and the folder's .gitignore are known to
  // lead into the working-copy folder.
  const writableCopy = (location: Location, rel: string) => {
    const copy = workingCopyPath(location, rel);
    for (const file of [copy, join(editorDir, ".gitignore")]) writable(file, [editorRoot()], /./, "inside Komposer's working-copy folder");
    return copy;
  };
  // Whether a working copy exists and its real path lies in the working-copy
  // folder; one that leads elsewhere is not read.
  const readableCopy = (copy: string) => {
    const real = existsSync(copy) ? realForm(copy) : undefined;
    const editor = editorRoot();
    return !!real && !!editor && within(real, [editor]);
  };

  // The projects whose runs are shown: this one first, then the registered
  // ones, then the example runs. A registered path is compared by its real
  // form, so one written through a symlink is not listed again beside this
  // project, the examples or another entry; it keeps its own form, which
  // removing it from the list needs. A broken projects file leaves this
  // project and the examples, with the reason.
  const projects = (): { paths: string[]; error?: string } => {
    const last = examples && examples !== root ? [examples] : [];
    try {
      const seen = new Set([root, ...last]);
      const registered = readProjects().filter((p) => {
        const real = realForm(p) ?? resolve(p);
        if (seen.has(real)) return false;
        seen.add(real);
        return true;
      });
      return { paths: [root, ...registered, ...last] };
    } catch (e) {
      return { paths: [root, ...last], error: (e as Error).message };
    }
  };

  // The runs of one project, or why its runs cannot be read, so one
  // unreadable project leaves the others to be shown.
  const projectRuns = (project: string): { runs: (WorkstreamListing & { project: string })[]; error?: string } => {
    try {
      return { runs: listWorkstreams(project).map((w) => ({ ...w, project })) };
    } catch (e) {
      return { runs: [], error: (e as Error).message };
    }
  };

  const runs = (): (WorkstreamListing & { project: string })[] =>
    projects()
      .paths.filter(isDirectory)
      .flatMap((project) => projectRuns(project).runs);

  // A file's text, or undefined when it cannot be read.
  const readText = (path: string): string | undefined => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };

  // Workflow files outside the three locations, listed read-only: every file
  // in another project's own workflow folder, where fuse-flow looks up a name
  // in that project's runs first, and any other file a run follows. A file
  // that cannot be read, and a project's workflow folder that cannot be
  // searched, are listed as unavailable with the reason: fuse-flow still
  // picks that file by its name, and fails a name looked up in that folder,
  // so a link to such a name must not lead to a shared workflow instead.
  const runWorkflows = () => {
    const out = new Map<string, Record<string, unknown>>();
    const unavailable = new Map<string, Record<string, unknown>>();
    const add = (path: string, project: string) => {
      if (out.has(path) || unavailable.has(path) || inLocation(path) || !/\.ya?ml$/.test(path)) return;
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        unavailable.set(path, { location: "run", project, kind: "file", path, reason: (e as Error).message });
        return;
      }
      out.set(path, { location: "run", project, dir: "", file: basename(path), path, onDisk: true, text, hash: sha(text) });
    };
    for (const project of projects().paths.filter((p) => p !== root)) {
      const folder = workflowDirs(project)[0];
      let files: string[] = [];
      try {
        files = isDirectory(folder) ? workflowFilesBelow(project, folder) : [];
      } catch (e) {
        unavailable.set(folder, { location: "run", project, kind: "folder", path: folder, reason: (e as Error).message });
      }
      for (const path of files) add(path, project);
    }
    for (const run of runs()) if (run.workflowPath) add(run.workflowPath, run.project);
    return { files: [...out.values()], unavailable: [...unavailable.values()] };
  };

  // The workflow files of one location with their text, found as fuse-flow's
  // workflowFilesBelow finds them, and what fuse-flow cannot use there, so
  // one of these leaves the rest of the listing intact: a folder that cannot
  // be searched, which fails every name fuse-flow looks up in the location; a
  // file that cannot be read; and a link whose target is missing, which
  // fuse-flow skips without a word.
  const scanLocation = (location: Location) => {
    const files: { path: string; text: string }[] = [];
    const unavailable: Record<string, unknown>[] = [];
    const missing = (kind: string, path: string, reason: string) => unavailable.push({ location: location.id, kind, path, reason });
    const skip = new Set([join(root, ".git"), workstreamsDir(root), ...Object.values(libraryDirs(root))].filter(existsSync).map((p) => realpathSync(p)));
    const notWorkflows = new Set([projectsFile(), ...Object.values(policyFiles(root))].filter(existsSync).map((p) => realpathSync(p)));
    const walk = (folder: string) => {
      let names: string[];
      try {
        const real = realpathSync(folder);
        if (skip.has(real)) return;
        skip.add(real); // a symlink loop is walked once
        names = readdirSync(folder).sort();
      } catch (e) {
        return missing("folder", folder, (e as Error).message);
      }
      for (const name of names) {
        if (name === "node_modules" || name === ".git") continue;
        const path = join(folder, name);
        if (isDirectory(path)) walk(path);
        else if (!WORKFLOW_FILE.test(name)) continue;
        else if (!existsSync(path)) {
          let target = "";
          try {
            target = readlinkSync(path);
          } catch {
            continue; // gone since the folder was read
          }
          missing("link", path, `it is a link to ${target}, which does not exist`);
        } else if (!notWorkflows.has(realpathSync(path))) {
          try {
            files.push({ path, text: readFileSync(path, "utf8") });
          } catch (e) {
            missing("file", path, (e as Error).message);
          }
        }
      }
    };
    if (existsSync(location.path)) walk(location.path);
    return { files, unavailable };
  };

  const listWorkflows = () => {
    const out: Record<string, unknown>[] = [];
    const unavailable: Record<string, unknown>[] = [];
    for (const location of locations) {
      const seen = new Set<string>();
      const scanned = scanLocation(location);
      unavailable.push(...scanned.unavailable);
      for (const u of scanned.unavailable) if (u.kind !== "folder") seen.add(relative(location.path, u.path as string));
      for (const { path, text } of scanned.files) {
        const rel = relative(location.path, path);
        seen.add(rel);
        const copy = workingCopyPath(location, rel);
        out.push({
          location: location.id,
          dir: dirname(rel) === "." ? "" : dirname(rel),
          file: basename(rel),
          path,
          onDisk: true,
          text,
          hash: sha(text),
          ...(readableCopy(copy) ? { workingCopy: readFileSync(copy, "utf8") } : {}),
        });
      }
      // Working copies of new workflows that were never saved.
      const copies = join(editorDir, location.id);
      if (!existsSync(copies)) continue;
      for (const copy of workflowFilesBelow(root, copies)) {
        const rel = relative(copies, copy);
        if (seen.has(rel) || !rel.endsWith(".yml") || !readableCopy(copy)) continue;
        out.push({
          location: location.id,
          dir: dirname(rel) === "." ? "" : dirname(rel),
          file: basename(rel),
          path: join(location.path, rel),
          onDisk: false,
          text: "",
          hash: sha(""),
          workingCopy: readFileSync(copy, "utf8"),
        });
      }
    }
    const other = runWorkflows();
    return { workflows: [...out, ...other.files], unavailable: [...unavailable, ...other.unavailable] };
  };

  const updateOriginal = (body: any) => {
    const { path } = locate(body.path);
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    if (!existsSync(path)) throw new HttpError(404, `${path} does not exist; save it as a new file`);
    const current = readFileSync(path, "utf8");
    if (sha(current) !== body.baseHash) throw new HttpError(409, `${path} changed on disk`);
    workflowWritable(path);
    writeFileSync(path, body.text);
    return { path, hash: sha(body.text) };
  };

  const saveNew = (body: any) => {
    const location = locations.find((l) => l.id === body.location);
    if (!location) throw new HttpError(400, `unknown location ${JSON.stringify(body.location)}`);
    const folder = typeof body.folder === "string" ? body.folder.replace(/^\/+|\/+$/g, "") : "";
    if (folder && !folder.split("/").every((part: string) => FOLDER_NAME.test(part) && part !== "..")) {
      throw new HttpError(400, "Folder names are lower-case letters, digits, dots, hyphens and underscores.");
    }
    if (typeof body.file !== "string" || !FILE_NAME.test(body.file)) {
      throw new HttpError(400, "Lower-case letters, digits and hyphens.");
    }
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    const { path } = locate(join(location.path, folder, `${body.file}.yml`));
    if (existsSync(path)) throw new HttpError(409, "A workflow with this file name exists there.");
    workflowWritable(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body.text, { flag: "wx" });
    return { path, hash: sha(body.text) };
  };

  const putWorkingCopy = (body: any) => {
    const { location, rel } = locate(body.path);
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    const copy = writableCopy(location, rel);
    mkdirSync(editorDir, { recursive: true });
    const ignore = join(editorDir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, body.text);
    return { path: copy };
  };

  const deleteWorkingCopy = (body: any) => {
    const { location, rel } = locate(body.path);
    rmSync(writableCopy(location, rel), { force: true });
    return {};
  };

  // Where a file that is a symlink leads, shown relative to the repository
  // that holds it, so a guide that is a Konductor skill reads as
  // skills/<name>/SKILL.md.
  const linkTarget = (path: string): { path: string; display: string } | undefined => {
    try {
      if (!lstatSync(path).isSymbolicLink() || !existsSync(path)) return undefined;
    } catch {
      return undefined;
    }
    const real = realpathSync(path);
    return { path: real, display: relative(findRepoRoot(dirname(real)), real) };
  };

  // Each entry's files with their text; one that cannot be read is named
  // under `unreadable` with the reason. A file whose real path lies outside
  // the locations a review guide may be read from, by the same rule as
  // guideScope below, is sent without its text: it is named under `links`
  // with its full real path and `outside: true`.
  const library = () => {
    const scope = guideScope();
    return {
      entries: listLibrary(root).map((e) => {
        const files: Record<string, string> = {};
        const outside: Record<string, { path: string; display: string; outside: true }> = {};
        const unreadable: Record<string, string> = {};
        const read = (name: string, file: string) => {
          if (scope(file).readable) {
            // One that cannot be read is left out with the reason, not a failed listing.
            try {
              files[name] = readFileSync(file, "utf8");
            } catch (e) {
              unreadable[name] = (e as Error).message;
            }
          } else if (existsSync(file)) {
            const real = realpathSync(file);
            outside[name] = { path: real, display: real, outside: true };
          }
        };
        if (e.guide) read("guide.md", e.guide);
        if (e.template && e.templateFile) read(e.templateFile, e.template);
        if (e.review) read("review.md", e.review);
        const links = {
          ...Object.fromEntries(
            Object.keys(files).flatMap((name) => {
              const target = linkTarget(join(e.folder, name));
              return target ? [[name, target]] : [];
            }),
          ),
          ...outside,
        };
        return {
          id: e.id,
          level: e.level,
          folder: e.folder,
          group: e.group,
          ...(Object.keys(links).length ? { links } : {}),
          ...(e.description ? { description: e.description } : {}),
          ...(e.entryProblem ? { entryProblem: e.entryProblem } : {}),
          files,
          ...(Object.keys(unreadable).length ? { unreadable } : {}),
          ...(e.guideMissing ? { guideMissing: e.guideMissing } : {}),
          ...(e.hides ? { hides: e.hides } : {}),
          ...(e.hiddenBy ? { hiddenBy: e.hiddenBy } : {}),
        };
      }),
    };
  };

  // Whether a guide may be read: its real path lies inside the project, a
  // library or a workflow location, or it is a file of an entry in the
  // package library, which ships with fuse-konductor and links its guides to
  // skills in the same clone. Links in the project and user libraries get no
  // such exception. A path that does not exist is judged by its own form, so
  // the answer for a path outside these locations does not tell whether the
  // file exists.
  const guideScope = () => {
    const bases = [root, ...Object.values(libraryDirs(root)), ...locations.map((l) => l.path)];
    const roots = [...new Set([...bases, ...bases.filter((b) => existsSync(b)).map((b) => realpathSync(b))])];
    const shipped = new Set(
      listLibrary(root)
        .filter((e) => e.level === "package")
        .flatMap((e) => [e.guide, e.template, e.review].filter((f): f is string => !!f && existsSync(f)).map((f) => realpathSync(f))),
    );
    return (file: string): { readable: boolean; outside: boolean } => {
      if (!existsSync(file)) return { readable: false, outside: !within(resolve(file), roots) };
      const real = realpathSync(file);
      const inside = within(real, roots) || shipped.has(real);
      return { readable: inside && statSync(real).isFile(), outside: !inside };
    };
  };

  // The review guide each agent gate of the sent text uses for each artifact
  // of its step, with the layer it comes from (the engine's own rule), the
  // gate's own guide, and the text of every file named that may be read. The
  // text sent is the open version, saved or not; a gate's guide is relative to
  // the workflow file, as the engine reads it.
  const reviewGuides = (body: any) => {
    const { path } = locate(body.path);
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    const parsed = parseWorkflowText(body.text);
    if (!parsed.ok) return { gates: [], files: {} };
    const p = loadProject(root);
    const scope = guideScope();
    const files: Record<string, string> = {};
    const unreadable: Record<string, string> = {};
    // A file that may be read but cannot be is sent without its text and
    // with the reason, so it is not mistaken for one that does not exist.
    const ref = (file: string) => {
      const { readable, outside } = scope(file);
      if (readable && !(file in files) && !(file in unreadable)) {
        try {
          files[file] = readFileSync(file, "utf8");
        } catch (e) {
          unreadable[file] = (e as Error).message;
        }
      }
      return { path: file, display: display(p, file), ...(outside ? { outside: true } : {}), ...(file in unreadable ? { unreadable: unreadable[file] } : {}) };
    };
    // A gate guide outside the allowed locations is not said to exist.
    const gateGuide = (file: string) => {
      const out = ref(file);
      return { ...out, exists: !out.outside && existsSync(file) };
    };
    const gates = parsed.workflow.steps.flatMap((step, stepIndex) =>
      step.gates.flatMap((gate, gateIndex) => {
        if (gate.kind !== "agent") return [];
        const resolved = { ...gate, ...(gate.guide ? { guide: isAbsolute(gate.guide) ? gate.guide : resolve(dirname(path), gate.guide) } : {}) };
        const artifacts = [...step.produces, ...step.optional_produces, ...step.updates].map((a) => a.artifact);
        const reviews = (artifacts.length ? artifacts : [undefined]).map((artifact) => {
          const found = reviewGuideSource(p, resolved, artifact);
          if (found) return { ...(artifact ? { artifact } : {}), guide: { ...ref(found.path), source: found.source } };
          const own = artifact ? libraryEntry(p, artifact)?.guide : undefined;
          return { ...(artifact ? { artifact } : {}), ...(own ? { ownGuide: ref(own) } : {}) };
        });
        return [
          {
            step: stepIndex,
            gate: gateIndex,
            ...(resolved.guide ? { gateGuide: gateGuide(resolved.guide) } : {}),
            reviews,
          },
        ];
      }),
    );
    return { gates, files };
  };

  // Each workstream with the runs it links to: the one it was started after,
  // the ones started after it, the parent whose step waits for it, and the
  // children its steps wait for, in step order and pass order. The newest
  // child of a step is the one the step waits for. Links are slugs, so they
  // resolve within the run's own project.
  const workstreams = () => {
    const listed = runs();
    return {
      workstreams: listed.map((w) => {
        if (!w.workstream) return { project: w.project, slug: w.slug, error: w.error };
        const ws = w.workstream;
        let stepIds = Object.keys(ws.steps);
        const text = w.workflowPath ? readText(w.workflowPath) : undefined;
        if (text !== undefined) {
          const parsed = parseWorkflowText(text);
          if (parsed.ok) stepIds = parsed.workflow.steps.map((s) => s.id);
        }
        const inOrder = [...stepIds, ...Object.keys(ws.steps).filter((id) => !stepIds.includes(id))];
        return {
          project: w.project,
          slug: w.slug,
          workflow: ws.workflow,
          ...(w.workflowPath ? { workflowPath: listedForm(w.workflowPath) } : {}),
          ...(ws.after ? { after: ws.after } : {}),
          ...(ws.parent ? { parent: ws.parent } : {}),
          ...(ws.inputs ? { inputs: ws.inputs } : {}),
          startedAfter: listed
            .filter((other) => other.project === w.project && other.workstream?.after === w.slug)
            .map((other) => other.slug),
          children: inOrder.flatMap((step) => (ws.steps[step]?.children ?? []).map((child) => ({ step, ...child }))),
          steps: ws.steps,
          events: runEvents(ws),
          summary: summarizeRun(ws, stepIds),
        };
      }),
    };
  };

  // The projects list for the app: each project with its run count and its
  // own workflow folder, this one marked current, a registered folder that is
  // gone marked missing, and one whose runs cannot be read with the reason.
  const listProjects = () => {
    const { paths, error } = projects();
    return {
      projects: paths.map((path) => {
        const missing = !isDirectory(path);
        const listed = missing ? undefined : projectRuns(path);
        return {
          path,
          name: basename(path),
          current: path === root,
          workflowsDir: workflowDirs(path)[0],
          ...(path === examples ? { example: true } : {}),
          ...(missing ? { missing: true } : listed?.error ? { error: listed.error } : { runs: listed?.runs.length }),
        };
      }),
      ...(error ? { error } : {}),
    };
  };

  const folderArg = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) throw new HttpError(400, "path is required");
    const raw = value.trim();
    const home = process.env.HOME ?? homedir();
    const path = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
    if (!isAbsolute(path)) throw new HttpError(400, "Give an absolute path, or one that starts with ~/.");
    return resolve(path);
  };

  // Add every project with runs at or below a folder. Registering goes through
  // fuse-flow's own code, so the file stays the one fuse-flow writes. A scan
  // that stopped at the folder limit says so: with nothing found it is
  // refused with the reason, since "no workstreams there" would be false;
  // otherwise it is marked `truncated`.
  const addProjects = (body: any) => {
    const dir = folderArg(body.path);
    if (!isDirectory(dir)) throw new HttpError(400, `${dir} is not a folder`);
    const scan = findProjects(dir);
    const found = scan.found.filter((p) => p !== examples);
    if (scan.truncated && !found.length) {
      throw new HttpError(
        422,
        `Komposer stopped after reading ${SCAN_FOLDERS.toLocaleString("en-US")} folders below ${dir} and found no workstreams in them; give a folder further down.`,
      );
    }
    const added = found.filter((p) => p !== root && registerProject(p));
    return { found, added, ...(scan.truncated ? { truncated: true } : {}) };
  };

  // A project is listed once for all the spellings registered for its real
  // path, so removing it removes every one of them.
  const removeProject = (body: any) => {
    if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
    if (resolve(body.path) === root) throw new HttpError(400, "Komposer was started on this project; it cannot be removed.");
    if (resolve(body.path) === examples) throw new HttpError(400, "The example workstreams ship with Komposer; they cannot be removed.");
    const real = realForm(body.path) ?? resolve(body.path);
    if (real === root || real === examples) return { removed: unregisterProject(body.path) };
    const spellings = readProjects().filter((p) => p === body.path || (realForm(p) ?? resolve(p)) === real);
    let removed = false;
    for (const p of new Set([body.path, ...spellings])) removed = unregisterProject(p) || removed;
    return { removed };
  };

  // Server-sent events for one file: its new hash each time it changes, null
  // when it is gone or cannot be read, with the reason it cannot. The folder
  // is watched, not the file, because editors save by replacing it. A read
  // error is reported, never thrown: the watch callback runs outside any
  // request, so a throw there would end the server.
  const watchFile = (path: string, signal: AbortSignal): Response => {
    const { path: full } = locate(path);
    const encoder = new TextEncoder();
    const read = (): { hash: string | null; error?: string } => {
      try {
        return { hash: existsSync(full) ? sha(readFileSync(full, "utf8")) : null };
      } catch (e) {
        return { hash: null, error: e instanceof Error ? e.message : String(e) };
      }
    };
    let last = JSON.stringify(read());
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": watching\n\n"));
        if (!existsSync(dirname(full))) return;
        const watcher = watch(dirname(full), (_event, name) => {
          if (name && name !== basename(full)) return;
          const now = read();
          if (JSON.stringify(now) === last) return;
          last = JSON.stringify(now);
          controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify({ path: full, ...now })}\n\n`));
        });
        // A watch that fails (its folder removed or made unreadable) ends
        // this stream only; an unhandled error event would end the server.
        watcher.on("error", () => {
          watcher.close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
        signal.addEventListener("abort", () => {
          watcher.close();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  };

  const serveApp = (pathname: string): Response => {
    const dir = options.appDir;
    if (!dir || !existsSync(dir)) return new Response("not found", { status: 404 });
    const file = resolve(dir, `.${decodeURIComponent(pathname)}`);
    const inside = file === resolve(dir) || file.startsWith(resolve(dir) + sep);
    const target = inside && existsSync(file) && statSync(file).isFile() ? file : join(dir, "index.html");
    return new Response(Bun.file(target));
  };

  const handle = async (req: Request, port: number): Promise<Response> => {
    const host = req.headers.get("host");
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      return Response.json({ error: "foreign Host header" }, { status: 403 });
    }
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/api/")) return serveApp(url.pathname);
    const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? url.searchParams.get("token");
    if (given !== token) return Response.json({ error: "missing or wrong token" }, { status: 401 });
    const body = req.method === "GET" ? {} : await req.json().catch(() => ({}));
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /api/session":
        return Response.json({ root, locations });
      case "GET /api/workflows":
        return Response.json(listWorkflows());
      case "PUT /api/workflows":
        return Response.json(updateOriginal(body));
      case "POST /api/workflows":
        return Response.json(saveNew(body));
      case "PUT /api/working-copies":
        return Response.json(putWorkingCopy(body));
      case "DELETE /api/working-copies":
        return Response.json(deleteWorkingCopy(body));
      case "GET /api/library":
        return Response.json(library());
      case "POST /api/review-guides":
        return Response.json(reviewGuides(body));
      case "GET /api/workstreams":
        return Response.json(workstreams());
      case "GET /api/projects":
        return Response.json(listProjects());
      case "POST /api/projects":
        return Response.json(addProjects(body));
      case "DELETE /api/projects":
        return Response.json(removeProject(body));
      case "GET /api/watch":
        return watchFile(url.searchParams.get("path") ?? "", req.signal);
      default:
        return Response.json({ error: `no route ${route}` }, { status: 404 });
    }
  };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port,
    idleTimeout: 0, // the watch stream stays open
    fetch: async (req, srv): Promise<Response> => {
      try {
        return await handle(req, srv.port ?? options.port);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 500;
        return Response.json({ error: (e as Error).message }, { status });
      }
    },
  });

  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}
