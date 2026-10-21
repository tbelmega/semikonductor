// SPDX-License-Identifier: Apache-2.0
// End-to-end tests of Kanvas's server routes (prototype): the real server on
// a copy of the example design, nothing of our own mocked.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { KanvasState } from "../../src/kanvas/model.ts";
import { type KomposerServer, startServer } from "../app.ts";

const EXAMPLE = resolve(import.meta.dir, "..", "..", "example-design");
const TOKEN = "test-token";
let dir: string;
let server: KomposerServer;

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${server.url}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });

beforeEach(() => {
  dir = mkdtempSync(join(process.env.KIROCREW_SCRATCH ?? tmpdir(), "kanvas-"));
  cpSync(join(EXAMPLE, "design"), join(dir, "design"), { recursive: true, filter: (src) => !/\.(cache|kanvas)/.test(src) });
  server = startServer({ root: dir, port: 0, token: TOKEN, kanvasDir: dir });
});

afterEach(() => {
  server.stop();
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
