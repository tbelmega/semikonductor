// SPDX-License-Identifier: Apache-2.0
// End-to-end tests of Kanvas's server routes (prototype): the real server on
// a copy of the example design, nothing of our own mocked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { registerProject } from "../../../flow/src/registry.ts";
import type { KanvasProjects, KanvasState } from "../../src/kanvas/model.ts";
import { type KomposerServer, startServer } from "../app.ts";

const EXAMPLE = resolve(import.meta.dir, "..", "..", "example-design");
const TOKEN = "test-token";
let dir: string;
let server: KomposerServer;
let savedHome: string | undefined;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

beforeEach(() => {
  // The real path, as the projects list stores one.
  dir = realpathSync(mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "kanvas-")));
  // The projects list lives in ~/.konductor/; each test gets its own.
  savedHome = process.env.HOME;
  process.env.HOME = join(dir, "home");
  cpSync(join(EXAMPLE, "design"), join(dir, "design"), { recursive: true, filter: (src) => !/\.(cache|kanvas)/.test(src) });
  server = startServer({ root: dir, port: 0, token: TOKEN, kanvasDir: dir });
});

afterEach(() => {
  server.stop();
  process.env.HOME = savedHome;
  rmSync(dir, { recursive: true, force: true });
});

test("Kanvas reads the board, builds its options with source locations and serves them under the secret only", async () => {
  const state = (await (await api("/api/kanvas")).json()) as KanvasState;
  expect(state.build.ok).toBe(true);
  const [round] = state.boards[0].rounds;
  expect(round.question).toBe("How should a new user pick their first habits?");
  expect(round.options.map((o) => o.label)).toEqual(["1a", "1b", "1c"]);
  expect(round.options[1].target).toBe("streaks/onboarding/1b");

  const frame = round.options[1].frame!;
  const page = await fetch(`${server.url}${frame}`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("/kanvas/bridge.js");
  const script = await (await fetch(`${server.url}${frame}entry.js`)).text();
  expect(script).toContain("design/apps/streaks/boards/onboarding/round-1/1b/Option.tsx:13:5");

  expect((await fetch(`${server.url}${frame.replace(/frame\/[^/]+\//, "frame/wrong/")}`)).status).toBe(404);
  expect((await fetch(`${server.url}${frame}..%2F..%2F..%2F..%2F..%2F..%2F..%2Fapps/streaks/README.md`)).status).toBe(404);
  expect((await fetch(`${server.url}/api/kanvas`)).status).toBe(401);
});

test("a comment is stored in design/.kanvas/comments.json, and an agent's edit there reaches the page", async () => {
  await api("/api/kanvas");
  const anchor = { file: "design/apps/streaks/boards/onboarding/round-1/1b/Option.tsx", line: 23, column: 9, tag: "h1", selector: "body > div > main > section > h1", text: "What would you like to change?" };
  const created = await (await api("/api/kanvas/comments", { method: "POST", body: JSON.stringify({ target: "streaks/onboarding/1b", anchor, body: "Shorter, please" }) })).json();
  expect(created).toMatchObject({ id: 1, state: "open", body: "Shorter, please", anchor });
  expect((await api("/api/kanvas/comments", { method: "POST", body: JSON.stringify({ target: "x", anchor: { ...anchor, file: "../etc/passwd" }, body: "x" }) })).status).toBe(400);

  const path = join(dir, "design", ".kanvas", "comments.json");
  const stored = JSON.parse(readFileSync(path, "utf8"));
  expect(stored.comments[0].body).toBe("Shorter, please");

  const events = await api("/api/kanvas/events");
  const reader = events.body!.getReader();
  await reader.read();
  stored.comments[0].state = "addressed";
  stored.comments[0].note = "Shortened the headline.";
  writeFileSync(path, JSON.stringify(stored));
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("Shortened the headline.")) text += decoder.decode((await reader.read()).value);
  expect(text).toContain("event: comments");
  await reader.cancel();
});

test("a change to an option's file rebuilds and names the file", async () => {
  await api("/api/kanvas");
  const events = await api("/api/kanvas/events");
  const reader = events.body!.getReader();
  await reader.read();
  const option = join(dir, "design", "apps", "streaks", "boards", "onboarding", "round-1", "1a", "Option.tsx");
  writeFileSync(option, readFileSync(option, "utf8").replace("Pick your first habits", "Choose your first habits"));
  let text = "";
  const decoder = new TextDecoder();
  while (!text.includes("event: build")) text += decoder.decode((await reader.read()).value);
  expect(text).toContain("round-1/1a/Option.tsx");
  await reader.cancel();
  const state = (await (await api("/api/kanvas")).json()) as KanvasState;
  const script = await (await fetch(`${server.url}${state.boards[0].rounds[0].options[0].frame}entry.js`)).text();
  expect(script).toContain("Choose your first habits");
});

test("the app's own /kanvas/... routes are the app's, and only frame paths are Kanvas's", async () => {
  const dist = mkdtempSync(join(dir, "dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>app</title>");
  server.stop();
  server = startServer({ root: dir, port: 0, token: TOKEN, kanvasDir: dir, appDir: dist });
  expect(await (await fetch(`${server.url}/kanvas/personal/flows/x.yml`)).text()).toContain("<title>app</title>");
  expect((await fetch(`${server.url}/kanvas/frame/wrong/apps/`)).status).toBe(404);
  expect((await fetch(`${server.url}/kanvas/bridge.js`)).headers.get("content-type")).toContain("javascript");
});

test("Kanvas lists the --kanvas folder and the Workstreams page's projects, and shows the one a request names", async () => {
  server.stop();
  const project = join(dir, "project");
  const other = join(dir, "other");
  mkdirSync(project);
  mkdirSync(join(other, "design", "apps"), { recursive: true });
  registerProject(other);
  server = startServer({ root: project, port: 0, token: TOKEN, kanvasDir: dir });

  const listed = (await (await api("/api/kanvas/projects")).json()) as KanvasProjects;
  expect(listed.first).toBe(dir);
  expect(listed.projects).toEqual([
    { path: dir, hasDesign: true },
    { path: project, hasDesign: false },
    { path: other, hasDesign: true },
  ]);

  const first = (await (await api("/api/kanvas")).json()) as KanvasState;
  expect(first.boards[0].app).toBe("streaks");
  const plain = (await (await api(`/api/kanvas?project=${encodeURIComponent(project)}`)).json()) as KanvasState;
  expect(plain).toMatchObject({ hasDesign: false, root: project, boards: [] });
  // The empty page's prompt points the agent to the example design.
  expect(readFileSync(join(plain.example, "design", "apps", "streaks", "boards", "onboarding", "board.md"), "utf8")).toContain("## Round 1");
  const empty = (await (await api(`/api/kanvas?project=${encodeURIComponent(other)}`)).json()) as KanvasState;
  expect(empty).toMatchObject({ hasDesign: true, root: other, boards: [] });

  // A comment goes to the named project's design/.kanvas/ only.
  const anchor = { file: "design/apps/x/Page.tsx", line: 1, column: 1, tag: "h1", selector: "h1", text: "x" };
  const made = await api(`/api/kanvas/comments?project=${encodeURIComponent(other)}`, { method: "POST", body: JSON.stringify({ target: "x/y/1a", anchor, body: "here" }) });
  expect(made.status).toBe(200);
  expect(JSON.parse(readFileSync(join(other, "design", ".kanvas", "comments.json"), "utf8")).comments[0].body).toBe("here");
  expect(first.comments).toEqual([]);

  // The first board's frames are still served once another project is open.
  expect((await fetch(`${server.url}${first.boards[0].rounds[0].options[0].frame}`)).status).toBe(200);

  const elsewhere = await api(`/api/kanvas?project=${encodeURIComponent(join(dir, "nowhere"))}`);
  expect(elsewhere.status).toBe(400);
});
