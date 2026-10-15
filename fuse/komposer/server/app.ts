// SPDX-License-Identifier: Apache-2.0
// Komposer's local server: the JSON API the app uses to read and write the
// workflow files and the library of one project, to show the workstreams of
// that project, of every project in ~/.konductor/projects.yml and of the
// example runs that ship with Komposer, and the
// built app itself. Every location rule comes from fuse-flow's own code.
//
// The server writes files, so it guards itself: it listens on 127.0.0.1 only,
// wants the token it was started with on every API request, refuses a foreign
// Host header (DNS rebinding), and writes only .yml files inside the three
// workflow locations, its own working-copy folder and the projects list. The
// workflow file a run of another project follows is read, never written. It
// reads a review guide
// that a workflow names only when the guide's real path, with symlinks
// resolved, lies inside the project, the three libraries or the three
// workflow locations, or is a file of a shipped package-library entry; any other guide is
// reported as outside those locations, without its content.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { summarizeRun, runEvents } from "../../flow/src/history.ts";
import { parseWorkflowText } from "../../flow/src/parse.ts";
import { display, libraryEntry, listLibrary, loadProject, reviewGuideSource } from "../../flow/src/policy.ts";
import { findRepoRoot, isDirectory, libraryDirs, workflowDirs, workflowFilesBelow, workstreamsDir } from "../../flow/src/project.ts";
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

// How far below the folder given to "add projects" Komposer looks for runs,
// and how many folders it reads at most, so a home directory stays quick.
const SCAN_DEPTH = 4;
const SCAN_FOLDERS = 20_000;

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// Whether a project has at least one workstream state file.
const hasRuns = (project: string) =>
  isDirectory(workstreamsDir(project)) && readdirSync(workstreamsDir(project)).some((n) => n.endsWith(".yml"));

// Every project at or below `dir` that has runs: a folder holding
// .konductor/workstreams/*.yml. Folders inside .konductor, .git and
// node_modules are not searched; worktrees below a project are.
function findProjects(dir: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const walk = (folder: string, depth: number) => {
    let real: string;
    try {
      real = realpathSync(folder);
    } catch {
      return;
    }
    if (seen.has(real) || seen.size >= SCAN_FOLDERS) return;
    seen.add(real);
    if (hasRuns(real)) found.push(real);
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
  return found;
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

  // The location a path is in, by its resolved form, and only for .yml files.
  const locate = (path: unknown): { location: Location; path: string; rel: string } => {
    if (typeof path !== "string" || !path) throw new HttpError(400, "path is required");
    const full = resolve(path);
    if (extname(full) !== ".yml") throw new HttpError(403, `${full} is not a .yml file`);
    for (const location of locations) {
      if (full.startsWith(location.path + sep)) return { location, path: full, rel: relative(location.path, full) };
    }
    throw new HttpError(403, `${full} is not inside a workflow location`);
  };

  const workingCopyPath = (location: Location, rel: string) => join(editorDir, location.id, rel);
  const inLocation = (path: string) => locations.some((l) => path.startsWith(l.path + sep));

  // The projects whose runs are shown: this one first, then the registered
  // ones, then the example runs. A broken projects file leaves this project
  // and the examples, with the reason.
  const projects = (): { paths: string[]; error?: string } => {
    const last = examples && examples !== root ? [examples] : [];
    try {
      const registered = readProjects().filter((p) => p !== examples);
      return { paths: [...new Set([root, ...registered]), ...last] };
    } catch (e) {
      return { paths: [root, ...last], error: (e as Error).message };
    }
  };

  const runs = (): (WorkstreamListing & { project: string })[] =>
    projects()
      .paths.filter(isDirectory)
      .flatMap((project) => listWorkstreams(project).map((w) => ({ ...w, project })));

  // The workflow files runs follow that lie outside the three locations, such
  // as another project's own workflows: listed read-only, so its runs can be shown.
  const runWorkflows = () => {
    const out = new Map<string, Record<string, unknown>>();
    for (const run of runs()) {
      const path = run.workflowPath;
      if (!path || out.has(path) || inLocation(path) || !/\.ya?ml$/.test(path)) continue;
      const text = readFileSync(path, "utf8");
      out.set(path, { location: "run", project: run.project, dir: "", file: basename(path), path, onDisk: true, text, hash: sha(text) });
    }
    return [...out.values()];
  };

  const listWorkflows = () => {
    const out: Record<string, unknown>[] = [];
    for (const location of locations) {
      const seen = new Set<string>();
      const files = existsSync(location.path) ? workflowFilesBelow(root, location.path).filter((p) => p.endsWith(".yml")) : [];
      for (const path of files) {
        const rel = relative(location.path, path);
        seen.add(rel);
        const text = readFileSync(path, "utf8");
        const copy = workingCopyPath(location, rel);
        out.push({
          location: location.id,
          dir: dirname(rel) === "." ? "" : dirname(rel),
          file: basename(rel),
          path,
          onDisk: true,
          text,
          hash: sha(text),
          ...(existsSync(copy) ? { workingCopy: readFileSync(copy, "utf8") } : {}),
        });
      }
      // Working copies of new workflows that were never saved.
      const copies = join(editorDir, location.id);
      if (!existsSync(copies)) continue;
      for (const copy of workflowFilesBelow(root, copies)) {
        const rel = relative(copies, copy);
        if (seen.has(rel) || !rel.endsWith(".yml")) continue;
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
    return [...out, ...runWorkflows()];
  };

  const updateOriginal = (body: any) => {
    const { path } = locate(body.path);
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    if (!existsSync(path)) throw new HttpError(404, `${path} does not exist; save it as a new file`);
    const current = readFileSync(path, "utf8");
    if (sha(current) !== body.baseHash) throw new HttpError(409, `${path} changed on disk`);
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
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body.text, { flag: "wx" });
    return { path, hash: sha(body.text) };
  };

  const putWorkingCopy = (body: any) => {
    const { location, rel } = locate(body.path);
    if (typeof body.text !== "string") throw new HttpError(400, "text is required");
    mkdirSync(editorDir, { recursive: true });
    const ignore = join(editorDir, ".gitignore");
    if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    const copy = workingCopyPath(location, rel);
    mkdirSync(dirname(copy), { recursive: true });
    writeFileSync(copy, body.text);
    return { path: copy };
  };

  const deleteWorkingCopy = (body: any) => {
    const { location, rel } = locate(body.path);
    rmSync(workingCopyPath(location, rel), { force: true });
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

  const library = () => ({
    entries: listLibrary(root).map((e) => {
      const files: Record<string, string> = {};
      if (e.guide) files["guide.md"] = readFileSync(e.guide, "utf8");
      if (e.template && e.templateFile) files[e.templateFile] = readFileSync(e.template, "utf8");
      if (e.review) files["review.md"] = readFileSync(e.review, "utf8");
      const links = Object.fromEntries(
        Object.keys(files).flatMap((name) => {
          const target = linkTarget(join(e.folder, name));
          return target ? [[name, target]] : [];
        }),
      );
      return {
        id: e.id,
        level: e.level,
        folder: e.folder,
        group: e.group,
        ...(Object.keys(links).length ? { links } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.entryProblem ? { entryProblem: e.entryProblem } : {}),
        files,
        ...(e.guideMissing ? { guideMissing: e.guideMissing } : {}),
        ...(e.hides ? { hides: e.hides } : {}),
        ...(e.hiddenBy ? { hiddenBy: e.hiddenBy } : {}),
      };
    }),
  });

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
    const within = (path: string) => roots.some((r) => path === r || path.startsWith(r + sep));
    const shipped = new Set(
      listLibrary(root)
        .filter((e) => e.level === "package")
        .flatMap((e) => [e.guide, e.template, e.review].filter((f): f is string => !!f && existsSync(f)).map((f) => realpathSync(f))),
    );
    return (file: string): { readable: boolean; outside: boolean } => {
      if (!existsSync(file)) return { readable: false, outside: !within(resolve(file)) };
      const real = realpathSync(file);
      const inside = within(real) || shipped.has(real);
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
    const ref = (file: string) => {
      const { readable, outside } = scope(file);
      if (readable) files[file] ??= readFileSync(file, "utf8");
      return { path: file, display: display(p, file), ...(outside ? { outside: true } : {}) };
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

  const workstreams = () => ({
    workstreams: runs().map((w) => {
      if (!w.workstream) return { project: w.project, slug: w.slug, error: w.error };
      let stepIds = Object.keys(w.workstream.steps);
      if (w.workflowPath) {
        const parsed = parseWorkflowText(readFileSync(w.workflowPath, "utf8"));
        if (parsed.ok) stepIds = parsed.workflow.steps.map((s) => s.id);
      }
      return {
        project: w.project,
        slug: w.slug,
        workflow: w.workstream.workflow,
        ...(w.workflowPath ? { workflowPath: w.workflowPath } : {}),
        steps: w.workstream.steps,
        events: runEvents(w.workstream),
        summary: summarizeRun(w.workstream, stepIds),
      };
    }),
  });

  // The projects list for the app: each project with its run count, this one
  // marked current, a registered folder that is gone marked missing.
  const listProjects = () => {
    const { paths, error } = projects();
    return {
      projects: paths.map((path) => {
        const missing = !isDirectory(path);
        return {
          path,
          name: basename(path),
          current: path === root,
          ...(path === examples ? { example: true } : {}),
          ...(missing ? { missing: true } : { runs: listWorkstreams(path).length }),
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
  // fuse-flow's own code, so the file stays the one fuse-flow writes.
  const addProjects = (body: any) => {
    const dir = folderArg(body.path);
    if (!isDirectory(dir)) throw new HttpError(400, `${dir} is not a folder`);
    const found = findProjects(dir).filter((p) => p !== examples);
    const added = found.filter((p) => p !== root && registerProject(p));
    return { found, added };
  };

  const removeProject = (body: any) => {
    if (typeof body.path !== "string" || !body.path) throw new HttpError(400, "path is required");
    if (resolve(body.path) === root) throw new HttpError(400, "Komposer was started on this project; it cannot be removed.");
    if (resolve(body.path) === examples) throw new HttpError(400, "The example runs ship with Komposer; they cannot be removed.");
    return { removed: unregisterProject(body.path) };
  };

  // Server-sent events for one file: its new hash each time it changes. The
  // folder is watched, not the file, because editors save by replacing it.
  const watchFile = (path: string, signal: AbortSignal): Response => {
    const { path: full } = locate(path);
    const encoder = new TextEncoder();
    const read = () => (existsSync(full) ? sha(readFileSync(full, "utf8")) : null);
    let last = read();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": watching\n\n"));
        if (!existsSync(dirname(full))) return;
        const watcher = watch(dirname(full), (_event, name) => {
          if (name && name !== basename(full)) return;
          const hash = read();
          if (hash === last) return;
          last = hash;
          controller.enqueue(encoder.encode(`event: change\ndata: ${JSON.stringify({ path: full, hash })}\n\n`));
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
        return Response.json({ workflows: listWorkflows() });
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
