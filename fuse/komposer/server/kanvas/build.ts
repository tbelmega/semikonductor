// SPDX-License-Identifier: Apache-2.0
// A small stand-in for `fuse-design build --watch`: bundles each board
// option (design/apps/<app>/boards/<feature>/round-<n>/<label>/Option.tsx)
// into static files in design/.cache/build/, adds each element's source
// location as a data-kanvas-src attribute, and rebuilds when a design file
// changes.
//
// Prototype shortcuts: every build rebuilds every option; only intrinsic
// elements written in files under design/apps/ get a source location (a
// component's use is not anchored); React comes from Komposer's own
// node_modules; the parser is rolldown's, a dev dependency of Komposer.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { parseAst } from "rolldown/parseAst";
import { anchorSrc } from "../../src/kanvas/model.ts";

const KOMPOSER = join(import.meta.dir, "..", "..");

type Node = { type: string; start: number; end: number; [key: string]: unknown };
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as Node).type === "string";

// The source with data-kanvas-src="<file>:<line>:<column>" added to every
// intrinsic element's opening tag; file is relative to the project root.
export function instrument(source: string, file: string): string {
  const inserts: { at: number; text: string }[] = [];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);
  const position = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] + 1 };
  };
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!isNode(node)) return;
    if (node.type === "JSXOpeningElement") {
      const name = node.name as Node;
      if (name.type === "JSXIdentifier" && /^[a-z]/.test(name.name as string)) {
        const { line, column } = position(node.start);
        inserts.push({ at: name.end, text: ` data-kanvas-src="${anchorSrc({ file, line, column })}"` });
      }
    }
    for (const [key, value] of Object.entries(node)) if (key !== "type" && typeof value === "object") walk(value);
  };
  walk(parseAst(source, { lang: "tsx" }, file));
  let out = source;
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) out = out.slice(0, at) + text + out.slice(at);
  return out;
}

// The option folders of every board, relative to design/:
// apps/<app>/boards/<feature>/round-<n>/<label>.
export function optionDirs(design: string): string[] {
  const list = (path: string) => (existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : []);
  const found: string[] = [];
  for (const app of list(join(design, "apps")))
    for (const feature of list(join(design, "apps", app, "boards")))
      for (const round of list(join(design, "apps", app, "boards", feature)).filter((r) => /^round-\d+$/.test(r)))
        for (const label of list(join(design, "apps", app, "boards", feature, round)))
          if (existsSync(join(design, "apps", app, "boards", feature, round, label, "Option.tsx")))
            found.push(join("apps", app, "boards", feature, round, label));
  return found;
}

const html = (title: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="entry.css">
<script src="/kanvas/bridge.js"></script>
</head>
<body>
<div id="root"></div>
<script src="entry.js"></script>
</body>
</html>
`;

export interface BuildResult {
  ok: boolean;
  error?: string;
  buildMs: number;
  options: string[];
}

export async function buildDesigns(given: string): Promise<BuildResult> {
  const started = performance.now();
  // The bundler hands plugins real paths, so the root is compared in its
  // real form (a home directory reached through a symlink, for one).
  const root = realpathSync(given);
  const design = join(root, "design");
  const cache = join(design, ".cache");
  const entries = join(cache, "entries");
  const out = join(cache, "build");
  const options = optionDirs(design);
  rmSync(entries, { recursive: true, force: true });
  const tokens = join(design, "system", "tokens", "tokens.css");
  const entryFiles = options.map((rel) => {
    const path = join(entries, rel, "entry.tsx");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      [
        existsSync(tokens) ? `import ${JSON.stringify(tokens)};` : "",
        `import Option from ${JSON.stringify(join(design, rel, "Option.tsx"))};`,
        `import { createElement } from "react";`,
        `import { createRoot } from "react-dom/client";`,
        `createRoot(document.getElementById("root")!).render(createElement(Option));`,
      ].join("\n"),
    );
    return path;
  });
  if (entryFiles.length === 0) return { ok: true, buildMs: performance.now() - started, options };
  const appsPrefix = join(design, "apps") + sep;
  try {
    rmSync(join(cache, "next"), { recursive: true, force: true });
    const result = await Bun.build({
      entrypoints: entryFiles,
      root: entries,
      outdir: join(cache, "next"),
      naming: "[dir]/[name].[ext]",
      format: "iife",
      target: "browser",
      minify: true,
      define: { "process.env.NODE_ENV": JSON.stringify("production") },
      throw: false,
      plugins: [
        {
          name: "kanvas",
          setup(build) {
            // React from Komposer's node_modules: a design folder has none.
            build.onResolve({ filter: /^react(-dom)?(\/.*)?$/ }, (args) => ({ path: Bun.resolveSync(args.path, KOMPOSER) }));
            build.onLoad({ filter: /\.tsx$/ }, (args) => {
              const source = readFileSync(args.path, "utf8");
              if (!args.path.startsWith(appsPrefix)) return { contents: source, loader: "tsx" };
              return { contents: instrument(source, relative(root, args.path)), loader: "tsx" };
            });
          },
        },
      ],
    });
    if (!result.success) {
      const error = result.logs.map((l) => String(l)).join("\n") || "the build failed";
      return { ok: false, error, buildMs: performance.now() - started, options };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), buildMs: performance.now() - started, options };
  }
  for (const rel of options) writeFileSync(join(cache, "next", rel, "index.html"), html(rel));
  // Swap the finished build in, so a frame never loads half a build.
  rmSync(out, { recursive: true, force: true });
  renameSync(join(cache, "next"), out);
  return { ok: true, buildMs: performance.now() - started, options };
}

// Rebuilds after each change under design/, except design/.cache/ and
// design/.kanvas/; reports changes to design/.kanvas/ separately. Changes
// that arrive during a build start one more build after it.
export function watchDesigns(
  root: string,
  on: { built: (result: BuildResult, since: number, changed: string[]) => void; kanvas: (name: string) => void },
): { close: () => void; rebuild: () => Promise<void> } {
  const design = join(root, "design");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let kanvasTimer: ReturnType<typeof setTimeout> | undefined;
  let building: Promise<void> | null = null;
  let pending: { since: number; changed: Set<string> } | null = null;
  const run = async (): Promise<void> => {
    while (pending) {
      const { since, changed } = pending;
      pending = null;
      const result = await buildDesigns(root);
      on.built(result, since, [...changed]);
    }
  };
  const schedule = (name: string) => {
    if (!pending) pending = { since: performance.now(), changed: new Set() };
    pending.changed.add(name);
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (building) return;
      building = run().finally(() => {
        building = null;
        if (pending) schedule([...pending.changed][0] ?? "");
      });
    }, 40);
  };
  let watcher: FSWatcher | undefined;
  if (existsSync(design)) {
    watcher = watch(design, { recursive: true }, (_event, name) => {
      if (!name) return;
      const path = String(name);
      if (path.startsWith(".cache")) return;
      if (path.startsWith(".kanvas")) {
        clearTimeout(kanvasTimer);
        kanvasTimer = setTimeout(() => on.kanvas(path), 30);
        return;
      }
      schedule(join("design", path));
    });
    watcher.on("error", () => watcher?.close());
  }
  return {
    close: () => {
      clearTimeout(timer);
      clearTimeout(kanvasTimer);
      watcher?.close();
    },
    rebuild: async () => {
      if (!pending) pending = { since: performance.now(), changed: new Set() };
      if (!building) building = run().finally(() => (building = null));
      await building;
    },
  };
}
