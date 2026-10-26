// SPDX-License-Identifier: Apache-2.0
// Kanvas's part of Komposer's server: the boards and comments of one design
// folder, the design build, the built frames and the bridge script.
//
//   GET    /kanvas/bridge.js                   the script every frame loads
//   GET    /kanvas/frame/<secret>/<path>       built designs, read-only
//   GET    /api/kanvas                         KanvasState
//   GET    /api/kanvas/events                  server-sent events: build, comments
//   POST   /api/kanvas/comments                { target, anchor, body }
//   PUT    /api/kanvas/comments                { id, state?, body? }
//   DELETE /api/kanvas/comments                { id }
//   PUT    /api/kanvas/selection               { target, anchor } or {}
//
// The frame routes take no token: a sandboxed frame has an opaque origin and
// cannot send one. They need the secret made at start, and serve only files
// inside design/.cache/build/. The /api/kanvas routes sit behind Komposer's
// token check like every other API route.
//
// State lives in design/.kanvas/: comments.json and selection.json. The
// agent reads them directly, and may set a comment's state to "addressed"
// with a note by editing comments.json; the page hears of it through the
// events stream.
//
// Prototype (workstream kanvas): no on/off setting, no content security
// policy on frames.

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { Anchor, BuildState, CommentState, KanvasComment, KanvasState } from "../../src/kanvas/model.ts";
import { readBoards } from "./board.ts";
import { watchDesigns } from "./build.ts";

const STATES: CommentState[] = ["open", "addressed", "resolved"];

class KanvasError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface CommentsFile {
  next: number;
  comments: KanvasComment[];
}

const writeJson = (path: string, value: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, path);
};

const isAnchor = (a: any): a is Anchor =>
  a &&
  typeof a.file === "string" &&
  a.file.startsWith("design/") &&
  !a.file.split("/").includes("..") &&
  Number.isInteger(a.line) &&
  Number.isInteger(a.column) &&
  typeof a.tag === "string" &&
  typeof a.selector === "string" &&
  typeof a.text === "string";

export interface Kanvas {
  // A response for /kanvas/... paths, or null for any other path.
  serve(pathname: string): Response | null;
  // A response for /api/kanvas routes, or null for any other route.
  // query holds ?project=<path> for a set of folders (createKanvasSet).
  api(method: string, pathname: string, body: any, signal: AbortSignal, query?: URLSearchParams): Promise<Response> | null;
  stop(): void;
}

// `dir` holds the design/ folder: the project root, or the folder given to
// `bun run start` with --kanvas.
export function createKanvas(dir: string): Kanvas {
  const root = resolve(dir);
  const design = join(root, "design");
  const kanvasDir = join(design, ".kanvas");
  const buildDir = join(design, ".cache", "build");
  const commentsPath = join(kanvasDir, "comments.json");
  const selectionPath = join(kanvasDir, "selection.json");
  const secret = randomBytes(18).toString("base64url");
  const frameBase = `/kanvas/frame/${secret}/`;
  const bridge = join(import.meta.dir, "bridge.js");

  let build: BuildState = { id: 0, ok: true };
  const listeners = new Set<(event: string, data: unknown) => void>();
  const emit = (event: string, data: unknown) => listeners.forEach((l) => l(event, data));

  // The watching build starts with the first request to Kanvas.
  let watcher: ReturnType<typeof watchDesigns> | null = null;
  let firstBuild: Promise<void> | null = null;
  const start = () => {
    if (firstBuild || !existsSync(design)) return firstBuild;
    watcher = watchDesigns(root, {
      built: (result, since, changed) => {
        build = {
          id: build.id + 1,
          ok: result.ok,
          ...(result.error ? { error: result.error } : {}),
          finished: new Date().toISOString(),
          ms: Math.round(performance.now() - since),
          changed,
        };
        emit("build", build);
      },
      kanvas: (name) => {
        if (name.includes("selection")) return;
        try {
          emit("comments", { comments: readComments().comments });
        } catch {
          // a half-written file by hand; the next change reports it
        }
      },
    });
    firstBuild = watcher.rebuild();
    return firstBuild;
  };

  const readComments = (): CommentsFile => {
    if (!existsSync(commentsPath)) return { next: 1, comments: [] };
    try {
      const parsed = JSON.parse(readFileSync(commentsPath, "utf8"));
      const comments: KanvasComment[] = Array.isArray(parsed.comments) ? parsed.comments : [];
      const next = Number.isInteger(parsed.next) ? parsed.next : Math.max(0, ...comments.map((c) => c.id)) + 1;
      return { next, comments };
    } catch (e) {
      throw new KanvasError(500, `${commentsPath} cannot be read: ${(e as Error).message}`);
    }
  };

  const optionFrame = (rel: string) => (existsSync(join(buildDir, rel, "index.html")) || existsSync(join(design, rel, "Option.tsx")) ? `${frameBase}${rel}/` : null);

  const state = (): KanvasState => ({
    hasDesign: existsSync(design),
    root,
    example: resolve(import.meta.dir, "..", "..", "example-design"),
    boards: existsSync(design) ? readBoards(root, optionFrame) : [],
    build,
    comments: readComments().comments,
  });

  const events = (signal: AbortSignal): Response => {
    const encoder = new TextEncoder();
    let listener: ((event: string, data: unknown) => void) | undefined;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(": kanvas\n\n"));
        listener = (event, data) => {
          try {
            controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
          } catch {
            listeners.delete(listener!);
          }
        };
        listeners.add(listener);
        signal.addEventListener("abort", () => {
          listeners.delete(listener!);
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

  const now = () => new Date().toISOString();

  const addComment = (body: any) => {
    if (typeof body.target !== "string" || !body.target) throw new KanvasError(400, "target is required");
    if (!isAnchor(body.anchor)) throw new KanvasError(400, "anchor needs file (under design/), line, column, tag, selector and text");
    if (typeof body.body !== "string" || !body.body.trim()) throw new KanvasError(400, "the comment is empty");
    const file = readComments();
    const comment: KanvasComment = {
      id: file.next,
      target: body.target,
      anchor: body.anchor,
      body: body.body.trim(),
      state: "open",
      created: now(),
      updated: now(),
    };
    writeJson(commentsPath, { next: file.next + 1, comments: [...file.comments, comment] });
    return comment;
  };

  const updateComment = (body: any) => {
    const file = readComments();
    const comment = file.comments.find((c) => c.id === body.id);
    if (!comment) throw new KanvasError(404, `no comment ${body.id}`);
    if (body.state !== undefined) {
      if (!STATES.includes(body.state)) throw new KanvasError(400, `state is one of ${STATES.join(", ")}`);
      comment.state = body.state;
    }
    if (body.body !== undefined) {
      if (typeof body.body !== "string" || !body.body.trim()) throw new KanvasError(400, "the comment is empty");
      comment.body = body.body.trim();
    }
    comment.updated = now();
    writeJson(commentsPath, file);
    return comment;
  };

  const deleteComment = (body: any) => {
    const file = readComments();
    if (!file.comments.some((c) => c.id === body.id)) throw new KanvasError(404, `no comment ${body.id}`);
    writeJson(commentsPath, { ...file, comments: file.comments.filter((c) => c.id !== body.id) });
    return { deleted: body.id };
  };

  const select = (body: any) => {
    if (body.target === undefined) {
      writeJson(selectionPath, null);
      return { selection: null };
    }
    if (typeof body.target !== "string" || !isAnchor(body.anchor)) throw new KanvasError(400, "a selection needs a target and an anchor");
    const selection = { target: body.target, anchor: body.anchor, at: now() };
    writeJson(selectionPath, selection);
    return { selection };
  };

  const serveFrame = (rest: string): Response => {
    const decoded = decodeURIComponent(rest);
    const file = resolve(buildDir, `.${sep}${decoded}`);
    if (!(file === buildDir || file.startsWith(buildDir + sep))) return new Response("not found", { status: 404 });
    const target = existsSync(file) && statSync(file).isDirectory() ? join(file, "index.html") : file;
    if (!existsSync(target) || !statSync(target).isFile()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(target), { headers: { "cache-control": "no-store" } });
  };

  const json = async (run: () => unknown): Promise<Response> => {
    try {
      return Response.json(await run());
    } catch (e) {
      const status = e instanceof KanvasError ? e.status : 500;
      return Response.json({ error: (e as Error).message }, { status });
    }
  };

  return {
    serve(pathname) {
      if (pathname === "/kanvas/bridge.js")
        return new Response(Bun.file(bridge), { headers: { "content-type": "text/javascript", "cache-control": "no-store" } });
      if (pathname.startsWith(frameBase)) return serveFrame(pathname.slice(frameBase.length));
      return null;
    },
    api(method, pathname, body, signal) {
      if (pathname !== "/api/kanvas" && !pathname.startsWith("/api/kanvas/")) return null;
      switch (`${method} ${pathname}`) {
        case "GET /api/kanvas":
          return json(async () => {
            await start();
            return state();
          });
        case "GET /api/kanvas/events":
          void start();
          return Promise.resolve(events(signal));
        case "POST /api/kanvas/comments":
          return json(() => addComment(body));
        case "PUT /api/kanvas/comments":
          return json(() => updateComment(body));
        case "DELETE /api/kanvas/comments":
          return json(() => deleteComment(body));
        case "PUT /api/kanvas/selection":
          return json(() => select(body));
        default:
          return Promise.resolve(Response.json({ error: `no route ${method} ${pathname}` }, { status: 404 }));
      }
    },
    stop() {
      watcher?.close();
    },
  };
}

// The folders Kanvas may show, with the one it shows first.
export interface KanvasFolders {
  // The --kanvas folder when given, then the projects of the Workstreams page.
  list(): string[];
  first: string;
}

// One Kanvas per folder, made on its first request. The /api/kanvas routes
// take the folder as ?project=<path>, which must be one of folders.list(); a
// request without it goes to folders.first. GET /api/kanvas/projects lists
// the folders and whether each has a design/ folder.
export function createKanvasSet(folders: KanvasFolders): Kanvas {
  const made = new Map<string, Kanvas>();
  const known = () => [...new Set(folders.list().map((p) => resolve(p)))];
  const of = (dir: string) => {
    let kanvas = made.get(dir);
    if (!kanvas) made.set(dir, (kanvas = createKanvas(dir)));
    return kanvas;
  };
  return {
    serve(pathname) {
      for (const kanvas of made.values()) {
        const answer = kanvas.serve(pathname);
        if (answer) return answer;
      }
      if (pathname === "/kanvas/bridge.js") return of(resolve(folders.first)).serve(pathname);
      // Any other frame path, such as one with an old secret. The app's own
      // routes, such as /kanvas/<location>/<workflow>, are the app's.
      if (pathname.startsWith("/kanvas/frame/")) return new Response("not found", { status: 404 });
      return null;
    },
    api(method, pathname, body, signal, query) {
      if (pathname !== "/api/kanvas" && !pathname.startsWith("/api/kanvas/")) return null;
      if (`${method} ${pathname}` === "GET /api/kanvas/projects")
        return Promise.resolve(
          Response.json({
            first: resolve(folders.first),
            projects: known().map((path) => ({ path, hasDesign: existsSync(join(path, "design")) })),
          }),
        );
      const asked = query?.get("project") || folders.first;
      const dir = resolve(asked);
      if (!known().includes(dir)) return Promise.resolve(Response.json({ error: `${asked} is not one of Komposer's projects` }, { status: 400 }));
      return of(dir).api(method, pathname, body, signal);
    },
    stop() {
      for (const kanvas of made.values()) kanvas.stop();
    },
  };
}
