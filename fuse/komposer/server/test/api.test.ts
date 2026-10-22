// SPDX-License-Identifier: Apache-2.0
// End-to-end tests of Komposer's server: each test starts the real server on a
// throwaway project, produces state with the real fuse-flow command line where
// it needs some, and checks the API's answers. Nothing of our own is mocked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { findWorkflow, workflowDirs } from "../../../flow/src/project.ts";
import { loadWorkflow } from "../../../flow/src/workflow.ts";
import { movedRefEdits } from "../../src/model/editWorkflow.ts";
import { resolveWorkflowRef } from "../../src/model/workflowLinks.ts";
import { workstreamProblem } from "../../src/model/workstreams.ts";
import { applyEdit } from "../../src/model/yamlEdit.ts";
import { type KomposerServer, startServer } from "../app.ts";

const CLI = resolve(import.meta.dir, "..", "..", "..", "flow", "src", "cli.ts");
const PACKAGE_WORKFLOWS = realpathSync(resolve(import.meta.dir, "..", "..", "..", "flow", "workflows"));
const TOKEN = "test-token";

const TWO_STEPS = `version: 1
name: two steps
inputs:
  - artifact: notes
steps:
  - id: draft
    title: Draft
    # a comment that must survive
    instruction: >
      Write the draft.
    gates:
      - owner-action: approve the draft
  - id: polish
    instruction: Polish it.
    consumes: [notes]
    gates:
      - owner-action: approve the polish
        route_back_to: draft
`;

const ONE_STEP = "version: 1\nname: one-step\nsteps:\n  - id: only\n    instruction: Do it.\n";

let root: string;
let home: string;
let server: KomposerServer;
let savedHome: string | undefined;

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function write(path: string, content: string): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

function flow(...args: string[]): string {
  return flowIn(root, ...args);
}

function flowIn(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync([process.execPath, "run", CLI, ...args], {
    cwd,
    env: { ...(process.env as Record<string, string>), HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = proc.stdout.toString() + proc.stderr.toString();
  if (proc.exitCode !== 0) throw new Error(`fuse-flow ${args.join(" ")} exited ${proc.exitCode}\n${out}`);
  return out;
}

async function api(path: string, init: RequestInit = {}, token: string | null = TOKEN): Promise<Response> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.url}${path}`, { ...init, headers });
}

async function json(path: string, init: RequestInit = {}): Promise<any> {
  const res = await api(path, init);
  expect(res.status).toBe(200);
  return res.json();
}

// A raw request with a chosen Host header, which fetch does not let us set.
function withHost(host: string, path: string): Promise<number> {
  const url = new URL(server.url);
  return new Promise((done, fail) => {
    const req = request(
      { host: "127.0.0.1", port: url.port, path, headers: { host, authorization: `Bearer ${TOKEN}` } },
      (res) => {
        res.resume();
        done(res.statusCode ?? 0);
      },
    );
    req.on("error", fail);
    req.end();
  });
}

beforeEach(() => {
  const base = process.env.KIROCREW_SCRATCH ?? tmpdir();
  root = realpathSync(mkdtempSync(join(base, "komposer-test-")));
  mkdirSync(join(root, ".git"));
  home = join(root, "home");
  mkdirSync(home);
  savedHome = process.env.HOME;
  process.env.HOME = home;
  server = startServer({ root, port: 0, token: TOKEN });
});

afterEach(() => {
  server.stop();
  process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

describe("access", () => {
  test("refuses a request without the token", async () => {
    expect((await api("/api/session", {}, null)).status).toBe(401);
    expect((await api("/api/session", {}, "wrong")).status).toBe(401);
  });

  test("refuses a foreign Host header, which DNS rebinding would send", async () => {
    const port = new URL(server.url).port;
    expect(await withHost(`127.0.0.1:${port}`, "/api/session")).toBe(200);
    expect(await withHost(`localhost:${port}`, "/api/session")).toBe(200);
    expect(await withHost(`evil.example:${port}`, "/api/session")).toBe(403);
  });

  test("listens on 127.0.0.1 only", () => {
    expect(new URL(server.url).hostname).toBe("127.0.0.1");
  });

  test("names the project and the three workflow locations", async () => {
    const session = await json("/api/session");
    expect(session.root).toBe(root);
    expect(session.locations.map((l: any) => l.id)).toEqual(["project", "personal", "fuse-flow"]);
    expect(session.locations[0].path).toBe(join(root, ".konductor", "workflows"));
    expect(session.locations[1].path).toBe(join(home, ".konductor", "workflows"));
    expect(session.locations[2].path).toBe(PACKAGE_WORKFLOWS);
  });
});

describe("workflows", () => {
  test("lists the workflows of all three locations with their text and hash", async () => {
    write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    write(join(home, ".konductor", "workflows", "docs", "mine.yml"), TWO_STEPS);
    const { workflows } = await json("/api/workflows");
    const project = workflows.find((w: any) => w.location === "project");
    expect(project).toMatchObject({ dir: "", file: "two-steps.yml", text: TWO_STEPS, hash: hash(TWO_STEPS) });
    expect(project.path).toBe(join(root, ".konductor", "workflows", "two-steps.yml"));
    expect(workflows.find((w: any) => w.location === "personal")).toMatchObject({ dir: "docs", file: "mine.yml" });
    const shipped = workflows.find((w: any) => w.location === "fuse-flow" && w.file === "fuse-feature-development.yml");
    expect(shipped).toMatchObject({ dir: "fuse" });
  });

  test("updates the original when its hash is still the base hash", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const text = TWO_STEPS.replace("title: Draft", "title: First draft");
    const res = await json("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text }) });
    expect(res.hash).toBe(hash(text));
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("refuses to update a file that changed on disk since the base hash", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    writeFileSync(path, `${TWO_STEPS}# edited elsewhere\n`);
    const res = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: "x" }) });
    expect(res.status).toBe(409);
    expect(readFileSync(path, "utf8")).toBe(`${TWO_STEPS}# edited elsewhere\n`);
  });

  test("refuses to write outside the workflow locations or a file that is not .yml", async () => {
    write(join(root, "elsewhere.yml"), TWO_STEPS);
    for (const path of [join(root, "elsewhere.yml"), join(root, ".konductor", "workflows", "..", "..", "elsewhere.yml"), join(root, ".konductor", "workflows", "notes.txt")]) {
      const res = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: "x" }) });
      expect(res.status).toBe(403);
    }
    expect(readFileSync(join(root, "elsewhere.yml"), "utf8")).toBe(TWO_STEPS);
    expect(existsSync(join(root, ".konductor", "workflows", "notes.txt"))).toBe(false);
  });

  test("refuses a write that a symlink leads outside the workflow locations", async () => {
    const outside = join(root, "outside");
    const target = write(join(outside, "target.yml"), TWO_STEPS);
    const notes = write(join(outside, "notes.md"), TWO_STEPS);
    const folder = join(root, ".konductor", "workflows");
    mkdirSync(folder, { recursive: true });
    symlinkSync(target, join(folder, "link.yml"));
    symlinkSync(notes, join(folder, "notes.yml"));
    symlinkSync(outside, join(folder, "team"));
    symlinkSync(join(outside, "ghost.yml"), join(folder, "ghost.yml"));
    for (const path of [join(folder, "link.yml"), join(folder, "notes.yml"), join(folder, "team", "target.yml")]) {
      const res = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: "x" }) });
      expect(res.status).toBe(403);
    }
    for (const body of [
      { location: "project", folder: "team", file: "planted", text: "x" },
      { location: "project", file: "ghost", text: "x" },
    ]) {
      expect((await api("/api/workflows", { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
    }
    expect(readFileSync(target, "utf8")).toBe(TWO_STEPS);
    expect(readFileSync(notes, "utf8")).toBe(TWO_STEPS);
    expect(existsSync(join(outside, "planted.yml"))).toBe(false);
    // The files are still listed, with where they lead.
    const listed = (await json("/api/workflows")).workflows.filter((w: any) => w.location === "project");
    expect(listed.map((w: any) => [w.path, w.leadsTo])).toEqual([
      [join(folder, "link.yml"), target],
      [join(folder, "notes.yml"), notes],
      [join(folder, "team", "target.yml"), target],
    ]);
    expect(existsSync(join(outside, "ghost.yml"))).toBe(false);
  });

  test("a workflow location that is itself a symlink is written to", async () => {
    const real = join(root, "dotfiles", "workflows");
    const path = write(join(real, "mine.yml"), TWO_STEPS);
    mkdirSync(join(home, ".konductor"), { recursive: true });
    symlinkSync(real, join(home, ".konductor", "workflows"));
    const listed = join(home, ".konductor", "workflows", "mine.yml");
    expect((await json("/api/workflows")).workflows.find((w: any) => w.path === listed).leadsTo).toBeUndefined();
    await json("/api/workflows", { method: "PUT", body: JSON.stringify({ path: listed, baseHash: hash(TWO_STEPS), text: ONE_STEP }) });
    expect(readFileSync(path, "utf8")).toBe(ONE_STEP);
    await json("/api/workflows", { method: "POST", body: JSON.stringify({ location: "personal", file: "new-one", text: ONE_STEP.replace("one-step", "new-one") }) });
    expect(readFileSync(join(real, "new-one.yml"), "utf8")).toBe(ONE_STEP.replace("one-step", "new-one"));
  });

  test("refuses a working copy that a symlink leads outside the working-copy folder, and does not read one", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const editor = join(root, ".konductor", "editor");
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, editor);
    expect((await api("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "x" }) })).status).toBe(403);
    expect((await api("/api/working-copies", { method: "DELETE", body: JSON.stringify({ path }) })).status).toBe(403);
    expect(existsSync(join(outside, ".gitignore"))).toBe(false);
    expect(existsSync(join(outside, "project", "two-steps.yml"))).toBe(false);

    rmSync(editor);
    const secret = write(join(outside, "secret.md"), "SECRET\n");
    mkdirSync(join(editor, "project"), { recursive: true });
    symlinkSync(secret, join(editor, "project", "two-steps.yml"));
    expect((await api("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "x" }) })).status).toBe(403);
    expect(readFileSync(secret, "utf8")).toBe("SECRET\n");
    expect((await json("/api/workflows")).workflows.find((w: any) => w.path === path).workingCopy).toBeUndefined();
  });

  test("refuses a working copy whose base record a symlink leads outside the working-copy folder, and does not read it", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const editor = join(root, ".konductor", "editor", "project");
    const secret = write(join(root, "outside", "secret.md"), "SECRET\n");
    mkdirSync(editor, { recursive: true });
    symlinkSync(secret, join(editor, "two-steps.yml.base"));
    const put = await api("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "x", base: hash(TWO_STEPS) }) });
    expect(put.status).toBe(403);
    expect((await api("/api/working-copies", { method: "DELETE", body: JSON.stringify({ path }) })).status).toBe(403);
    expect(readFileSync(secret, "utf8")).toBe("SECRET\n");
    writeFileSync(join(editor, "two-steps.yml"), "copy\n");
    const listed = (await json("/api/workflows")).workflows.find((w: any) => w.path === path);
    expect(listed.workingCopyBase).toBeUndefined();
  });

  test("saves a new file, and refuses an existing name or one that breaks the naming rule", async () => {
    const body = { location: "project", folder: "team/flows", file: "new-flow", text: TWO_STEPS };
    const created = await json("/api/workflows", { method: "POST", body: JSON.stringify(body) });
    const path = join(root, ".konductor", "workflows", "team", "flows", "new-flow.yml");
    expect(created).toMatchObject({ path, hash: hash(TWO_STEPS) });
    expect(readFileSync(path, "utf8")).toBe(TWO_STEPS);
    expect((await api("/api/workflows", { method: "POST", body: JSON.stringify(body) })).status).toBe(409);
    for (const bad of [{ file: "New Flow" }, { folder: "../out" }, { location: "nowhere" }]) {
      const res = await api("/api/workflows", { method: "POST", body: JSON.stringify({ ...body, file: "other", ...bad }) });
      expect(res.status).toBe(400);
    }
  });

  // Save and Save as new write only text that fuse-flow takes, whatever the
  // app checked first: text it would refuse is refused with fuse-flow's own
  // lines and where each is, and nothing is written. A warning does not stop
  // a save, as it does not stop fuse-flow.
  test("refuses to write a workflow that fuse-flow would refuse, with its lines and their places", async () => {
    const folder = join(root, ".konductor", "workflows");
    const path = write(join(folder, "two-steps.yml"), TWO_STEPS);
    const missingGuide = TWO_STEPS.replace("      - owner-action: approve the draft\n", "      - agent: review the draft\n        guide: nope.md\n");
    const put = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: missingGuide }) });
    expect(put.status).toBe(422);
    const refused: any = await put.json();
    const line = `${path}: steps.0 (draft): the review guide of agent(review the draft) does not exist: ${join(folder, "nope.md")}`;
    expect(refused.errors).toEqual([line]);
    expect(refused.error).toContain(line);
    expect(refused.problems).toEqual([{ severity: "error", line, detail: expect.any(String), at: [{ step: 0, gate: 0, field: "guide" }] }]);
    expect(readFileSync(path, "utf8")).toBe(TWO_STEPS);

    // Text that is not a workflow at all: the schema's lines, placed where they can be.
    const badRoute = TWO_STEPS.replace("route_back_to: draft", "route_back_to: nowhere");
    const schema = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: badRoute }) });
    expect(schema.status).toBe(422);
    const schemaBody: any = await schema.json();
    expect(schemaBody.errors).toEqual([expect.stringMatching(/^steps\.1\.gates\.0\.route_back_to: .*nowhere/)]);
    expect(schemaBody.problems).toEqual([{ severity: "error", line: schemaBody.errors[0], detail: expect.any(String), at: [{ step: 1, gate: 0 }] }]);
    for (const text of ["x", "a: [b\n"]) {
      const res = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text }) });
      expect([text, res.status]).toEqual([text, 422]);
    }
    expect(readFileSync(path, "utf8")).toBe(TWO_STEPS);

    // Save as new checks the text at its destination, which does not exist yet.
    const parent = "version: 1\nname: parent\nsteps:\n  - id: ask\n    instruction: Ask.\n    gates:\n      - workflow: ../child.yml\n";
    const post = await api("/api/workflows", { method: "POST", body: JSON.stringify({ location: "project", folder: "team", file: "parent", text: parent }) });
    expect(post.status).toBe(422);
    expect(((await post.json()) as any).problems).toEqual([expect.objectContaining({ severity: "error", at: [{ step: 0, gate: 0, field: "workflow" }] })]);
    expect(existsSync(join(folder, "team", "parent.yml"))).toBe(false);
    write(join(folder, "child.yml"), ONE_STEP.replace("one-step", "child"));
    await json("/api/workflows", { method: "POST", body: JSON.stringify({ location: "project", folder: "team", file: "parent", text: parent }) });
    expect(readFileSync(join(folder, "team", "parent.yml"), "utf8")).toBe(parent);

    // A name that differs from the file name is only a warning.
    const renamed = TWO_STEPS.replace("name: two steps", "name: renamed");
    await json("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(TWO_STEPS), text: renamed }) });
    expect(readFileSync(path, "utf8")).toBe(renamed);
  });

  test("keeps a working copy next to the project, ignored by git, until it is removed", async () => {
    const path = write(join(home, ".konductor", "workflows", "mine.yml"), TWO_STEPS);
    const text = `${TWO_STEPS}# unsaved\n`;
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text }) });
    const copy = join(root, ".konductor", "editor", "personal", "mine.yml");
    expect(readFileSync(copy, "utf8")).toBe(text);
    expect(readFileSync(join(root, ".konductor", "editor", ".gitignore"), "utf8")).toBe("*\n");
    const listed = (await json("/api/workflows")).workflows.find((w: any) => w.path === path);
    expect(listed.workingCopy).toBe(text);
    expect(readFileSync(path, "utf8")).toBe(TWO_STEPS);
    await json("/api/working-copies", { method: "DELETE", body: JSON.stringify({ path }) });
    expect(existsSync(copy)).toBe(false);
    expect((await json("/api/workflows")).workflows.find((w: any) => w.path === path).workingCopy).toBeUndefined();
  });

  test("a folder or file of a workflow location that cannot be read is listed as unavailable; the rest still loads", async () => {
    const mine = join(home, ".konductor", "workflows");
    write(join(mine, "fine.yml"), TWO_STEPS);
    const unread = write(join(mine, "unread.yml"), TWO_STEPS);
    const locked = join(mine, "locked");
    write(join(locked, "inner.yml"), TWO_STEPS);
    chmodSync(unread, 0o000);
    chmodSync(locked, 0o000);
    try {
      const { workflows, unavailable } = await json("/api/workflows");
      expect(workflows.filter((w: any) => w.location === "personal").map((w: any) => w.file)).toEqual(["fine.yml"]);
      expect(unavailable.filter((u: any) => u.location === "personal")).toEqual([
        { location: "personal", kind: "folder", path: locked, reason: expect.stringContaining("EACCES") },
        { location: "personal", kind: "file", path: unread, reason: expect.stringContaining("EACCES") },
      ]);
    } finally {
      chmodSync(locked, 0o755);
      chmodSync(unread, 0o644);
    }
  });

  test("a workflow link whose target is missing is listed as unavailable, with its target", async () => {
    const folder = join(root, ".konductor", "workflows");
    mkdirSync(folder, { recursive: true });
    symlinkSync("/nonexistent/broken.yml", join(folder, "broken.yml"));
    const { unavailable } = await json("/api/workflows");
    expect(unavailable.filter((u: any) => u.location === "project")).toEqual([
      { location: "project", kind: "link", path: join(folder, "broken.yml"), reason: "it is a link to /nonexistent/broken.yml, which does not exist" },
    ]);
  });

  test("with a symlinked home, a personal workflow a run names by its real path is listed once and saved", async () => {
    const realHome = join(root, "real-home");
    mkdirSync(realHome);
    home = join(root, "linked-home");
    symlinkSync(realHome, home);
    server.stop();
    process.env.HOME = home;
    server = startServer({ root, port: 0, token: TOKEN });
    const mine = "version: 1\nname: mine\nsteps:\n  - id: only\n    instruction: Do it.\n";
    const listedPath = write(join(home, ".konductor", "workflows", "mine.yml"), mine);
    const realPath = join(realHome, ".konductor", "workflows", "mine.yml");
    flow("start", "ws4", "--workflow", realPath);
    const { workflows } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.file === "mine.yml").map((w: any) => [w.location, w.path])).toEqual([["personal", listedPath]]);
    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.find((w: any) => w.slug === "ws4").workflowPath).toBe(listedPath);
    await json("/api/workflows", { method: "PUT", body: JSON.stringify({ path: realPath, baseHash: hash(mine), text: ONE_STEP }) });
    expect(readFileSync(realPath, "utf8")).toBe(ONE_STEP);
  });

  test("a .yaml workflow, which fuse-flow follows by its path, is listed, linked to and saved", async () => {
    const one = "version: 1\nname: extension\nsteps:\n  - id: only\n    instruction: Do it.\n";
    const folder = join(root, ".konductor", "workflows");
    const path = write(join(folder, "extension.yaml"), one);
    flow("start", "yaml-run", "--workflow", ".konductor/workflows/extension.yaml");
    const { workflows, unavailable } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.path === path).map((w: any) => [w.location, w.file])).toEqual([["project", "extension.yaml"]]);
    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.find((w: any) => w.slug === "yaml-run").workflowPath).toBe(path);
    const link = resolveWorkflowRef("extension.yaml", join(folder, "parent.yml"), workflows, folder, unavailable);
    expect(link).toMatchObject({ ok: true, target: { path } });
    const text = one.replace("Do it.", "Do it well.");
    await json("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(one), text }) });
    expect(readFileSync(path, "utf8")).toBe(text);
  });

  test("a run started by a path through a link to this project leads to the project's own editable file", async () => {
    const gamma = write(join(root, ".konductor", "workflows", "gamma.yml"), ONE_STEP.replace("one-step", "gamma"));
    const alias = join(root, "home", "proj-link");
    symlinkSync(root, alias);
    flow("start", "ws-symlink", "--workflow", join(alias, ".konductor", "workflows", "gamma.yml"));
    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.find((w: any) => w.slug === "ws-symlink").workflowPath).toBe(gamma);
    const { workflows } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.file === "gamma.yml").map((w: any) => [w.location, w.path])).toEqual([["project", gamma]]);
  });

  // A run started by a path through a symlinked workflow folder reads its
  // relative references from that path, so it is listed and linked by that
  // path, not by the location's form, where the same references lead
  // elsewhere.
  test("a run whose workflow's references read differently in the location's form keeps the path fuse-flow used", async () => {
    const shared = join(root, "shared", "workflows");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(home, ".konductor"), { recursive: true });
    symlinkSync(shared, join(home, ".konductor", "workflows"));
    const parentText = `version: 1
name: parent
steps:
  - id: ask
    instruction: Ask.
    gates:
      - agent: review it
        guide: ../review.md
      - workflow: ../child.yml
`;
    const parent = write(join(shared, "parent.yml"), parentText);
    const child = write(join(root, "shared", "child.yml"), "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do it.\n");
    const guide = write(join(root, "shared", "review.md"), "rules\n");
    flow("start", "shared-run", "--workflow", parent);
    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.find((w: any) => w.slug === "shared-run").workflowPath).toBe(parent);
    const { workflows, unavailable } = await json("/api/workflows");
    expect(workflows.find((w: any) => w.path === parent)).toMatchObject({ location: "run", text: parentText });
    const link = resolveWorkflowRef("../child.yml", parent, workflows, join(root, ".konductor", "workflows"), unavailable);
    expect(link).toMatchObject({ ok: true, target: { path: child } });
    const guides = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path: parent, text: parentText }) });
    expect(guides.gates[0].gateGuide).toMatchObject({ path: guide, exists: true });
    expect(await json("/api/validate", { method: "POST", body: JSON.stringify({ path: parent, text: parentText }) })).toEqual({ errors: [], warnings: [], problems: [] });
  });

  // An absolute reference may name a listed workflow by its real path; the
  // listing gives that path, so a link can be matched to the one entry.
  test("a listed workflow whose real path differs from its listed path names its real path", async () => {
    const realHome = join(root, "real-home");
    mkdirSync(realHome);
    home = join(root, "linked-home");
    symlinkSync(realHome, home);
    server.stop();
    process.env.HOME = home;
    server = startServer({ root, port: 0, token: TOKEN });
    const listedPath = write(join(home, ".konductor", "workflows", "child.yml"), "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do it.\n");
    const plain = write(join(root, ".konductor", "workflows", "plain.yml"), ONE_STEP);
    const locked = write(join(home, ".konductor", "workflows", "locked.yml"), ONE_STEP);
    chmodSync(locked, 0o000);
    try {
      const { unavailable } = await json("/api/workflows");
      if (process.getuid?.() !== 0) expect(unavailable.find((u: any) => u.path === locked)).toMatchObject({ kind: "file", realPath: join(realHome, ".konductor", "workflows", "locked.yml") });
    } finally {
      chmodSync(locked, 0o644);
    }
    const { workflows } = await json("/api/workflows");
    expect(workflows.find((w: any) => w.path === listedPath).realPath).toBe(join(realHome, ".konductor", "workflows", "child.yml"));
    expect(workflows.find((w: any) => w.path === plain).realPath).toBeUndefined();
  });

  // fuse-flow reads the file an absolute reference leads to, so a workflow
  // gate naming a personal workflow by the real path of a symlinked home
  // leads to the one entry Komposer lists for it.
  test("an absolute reference to the real path of a listed workflow links to that workflow", async () => {
    const realHome = join(root, "real-home");
    mkdirSync(realHome);
    home = join(root, "linked-home");
    symlinkSync(realHome, home);
    server.stop();
    process.env.HOME = home;
    server = startServer({ root, port: 0, token: TOKEN });
    const listedPath = write(join(home, ".konductor", "workflows", "child.yml"), "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do it.\n");
    const realChild = join(realHome, ".konductor", "workflows", "child.yml");
    const folder = join(root, ".konductor", "workflows");
    const parentText = `version: 1\nname: parent\nsteps:\n  - id: ask\n    instruction: Ask.\n    gates:\n      - workflow: ${realChild}\n`;
    const parent = write(join(folder, "parent.yml"), parentText);
    flow("validate", parent);
    const { workflows, unavailable } = await json("/api/workflows");
    expect(resolveWorkflowRef(realChild, parent, workflows, folder, unavailable)).toMatchObject({ ok: true, target: { path: listedPath } });
    expect(await json("/api/validate", { method: "POST", body: JSON.stringify({ path: parent, text: parentText }) })).toMatchObject({ errors: [] });
  });

  // A run that keeps the path fuse-flow used and the editable entry of the
  // same file are two listed paths for one file. The run gives the file's
  // real path. A listed entry gives it only when the file names the same
  // files read from its real path, since only then does a reference to the
  // real path name this workflow.
  test("a run that keeps a linked path gives its workflow's real path; an entry gives its real path only when the file reads alike from it", async () => {
    const shared = join(root, "shared", "workflows");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(home, ".konductor"), { recursive: true });
    symlinkSync(shared, join(home, ".konductor", "workflows"));
    const alias = join(root, "alias-workflows");
    symlinkSync(shared, alias);
    const physical = write(join(shared, "parent.yml"), "version: 1\nname: parent\nsteps:\n  - id: ask\n    instruction: Ask.\n    gates:\n      - workflow: ../child.yml\n");
    write(join(root, "child.yml"), "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do it.\n");
    const ran = join(alias, "parent.yml");
    flow("start", "alias-run", "--workflow", ran);
    const { workstreams } = await json("/api/workstreams");
    const run = workstreams.find((w: any) => w.slug === "alias-run");
    expect(run.workflowPath).toBe(ran);
    expect(run.workflowRealPath).toBe(physical);
    const { workflows } = await json("/api/workflows");
    const editable = workflows.find((w: any) => w.location === "personal" && w.file === "parent.yml");
    // The file names ../child.yml, which leads to another file from each
    // of the three paths, so it is another workflow by each: no entry gives
    // a real path that a reference to the physical file would be matched by.
    expect(editable.path).toBe(join(home, ".konductor", "workflows", "parent.yml"));
    expect(editable.realPath).toBeUndefined();
    const runEntry = workflows.find((w: any) => w.path === ran);
    expect(runEntry.location).toBe("run");
    expect(runEntry.realPath).toBeUndefined();
  });

  // A project file that names a workflow by its physical path, where the
  // project's workflow folder is a link to that file's folder and the file
  // names other files read from the link: the physical file is another
  // workflow than the listed alias, so it is listed by its own path, before
  // it has a run, and its references are followed from there.
  test("a physical-path reference to a file that reads differently through the linked folder opens that file before any run", async () => {
    const physicalDir = join(root, "shared", "workflows");
    mkdirSync(physicalDir, { recursive: true });
    mkdirSync(join(root, ".konductor"), { recursive: true });
    const folder = join(root, ".konductor", "workflows");
    symlinkSync(physicalDir, folder);
    const one = (name: string) => `version: 1\nname: ${name}\nsteps:\n  - id: only\n    instruction: Do it.\n`;
    const physicalChild = write(join(root, "shared", "child.yml"), one("physical-child"));
    write(join(root, ".konductor", "child.yml"), one("alias-child"));
    const physical = write(
      join(physicalDir, "parent.yml"),
      "version: 1\nname: parent\nsteps:\n  - id: ask\n    instruction: Ask.\n    gates:\n      - workflow: ../child.yml\n",
    );
    const caller = write(
      join(folder, "caller.yml"),
      `version: 1\nname: caller\nsteps:\n  - id: call\n    instruction: Call.\n    gates:\n      - workflow: ${physical}\n`,
    );
    flow("validate", caller);
    const { workflows, unavailable } = await json("/api/workflows");
    const link = resolveWorkflowRef(physical, caller, workflows, folder, unavailable);
    expect(link).toMatchObject({ ok: true, target: { path: physical, location: "run" } });
    if (!link.ok) return;
    expect(resolveWorkflowRef("../child.yml", link.target.path, workflows, folder, unavailable)).toMatchObject({
      ok: true,
      target: { path: physicalChild },
    });
  });

  // A linked folder's file whose relative references lead elsewhere from its
  // real path is another workflow when a reference names that real path, as
  // fuse-flow reads it from there; Komposer must not open the listed alias.
  test("an absolute reference to a linked file that reads differently from its real path does not open the alias", async () => {
    // Outside the project, so the server does not list the real path itself.
    const external = mkdtempSync(join(tmpdir(), "komposer-external-"));
    try {
      const shared = join(external, "shared");
      mkdirSync(shared, { recursive: true });
      const folder = join(root, ".konductor", "workflows");
      mkdirSync(folder, { recursive: true });
      symlinkSync(shared, join(folder, "linked"));
      const one = (name: string, step: string) => `version: 1\nname: ${name}\nsteps:\n  - id: ${step}\n    instruction: Do it.\n`;
      write(join(external, "child.yml"), one("intended", "intended"));
      write(join(folder, "child.yml"), one("decoy", "decoy"));
      write(join(shared, "alias-target.yml"), "version: 1\nname: alias-target\nhands_off_to: ../child.yml\nsteps:\n  - id: only\n    instruction: Do it.\n");
      const realTarget = join(realpathSync(shared), "alias-target.yml");
      const caller = write(join(folder, "real-caller.yml"), `version: 1\nname: real-caller\nhands_off_to: ${realTarget}\nsteps:\n  - id: only\n    instruction: Do it.\n`);
      flow("validate", caller);
      // fuse-flow reads the target from the path the caller gives.
      const engineChild = loadWorkflow(findWorkflow(root, loadWorkflow(caller).hands_off_to[0].workflow)).hands_off_to[0].workflow;
      expect(engineChild).toBe(join(realpathSync(external), "child.yml"));
      const { workflows, unavailable } = await json("/api/workflows");
      const link = resolveWorkflowRef(realTarget, caller, workflows, folder, unavailable);
      if (link.ok) expect(resolveWorkflowRef("../child.yml", link.target.path, workflows, folder, unavailable)).toMatchObject({ ok: true, target: { path: engineChild } });
      else expect(link.reason).toContain(realTarget);
      expect(link).not.toMatchObject({ ok: true, target: { path: join(folder, "linked", "alias-target.yml") } });
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  // fuse-flow starts a workflow named by a path whatever the file is called
  // and records that path, so the run's workflow is listed and read.
  test("a run of a workflow file without a YAML extension lists that file and reads it", async () => {
    const folder = join(root, ".konductor", "workflows");
    const child = write(join(folder, "child"), "version: 1\nname: intended\nsteps:\n  - id: intended\n    instruction: Do it.\n");
    flow("start", "extensionless-run", "--workflow", child);
    const { workstreams } = await json("/api/workstreams");
    const run = workstreams.find((w: any) => w.slug === "extensionless-run");
    expect(run.workflowPath).toBe(child);
    const { workflows } = await json("/api/workflows");
    const file = workflows.find((w: any) => w.path === child);
    expect(file).toMatchObject({ location: "run", onDisk: true });
    expect(workstreamProblem(run, file.text)).toBeUndefined();
  });

  // The project's own workflow files name files outside the three folders by
  // their path, and fuse-flow follows those paths, so they are listed
  // read-only before any run follows them.
  test("a file the project's own workflow names by a path outside the workflow folders is listed read-only", async () => {
    write(join(root, ".konductor", "workflows", "main.yml"), "version: 1\nname: main\nhands_off_to: ../../outside/child.yml\nsteps:\n  - id: only\n    instruction: Finish.\n");
    const child = write(join(root, "outside", "child.yml"), ONE_STEP);
    const { workflows } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.path === child).map((w: any) => [w.location, w.project])).toEqual([["run", root]]);
  });

  // The same holds for a personal or shipped workflow that names a file of
  // this project by its path, and for the project's own workflow once a run
  // follows it: the target is listed, and the link resolves.
  test("a file that a personal workflow or a run of the project's own workflow names in this project is listed read-only", async () => {
    const parent = write(join(root, ".konductor", "workflows", "local-parent.yml"), "version: 1\nname: local-parent\nhands_off_to: ../../custom/child.yml\nsteps:\n  - id: only\n    instruction: Finish.\n");
    const child = write(join(root, "custom", "child.yml"), ONE_STEP.replace("one-step", "child"));
    const mine = write(join(home, ".konductor", "workflows", "mine.yml"), `version: 1\nname: mine\nhands_off_to: ${join(root, "custom", "other.yml")}\nsteps:\n  - id: only\n    instruction: Finish.\n`);
    const other = write(join(root, "custom", "other.yml"), ONE_STEP.replace("one-step", "other"));
    flow("start", "local-run", "--workflow", "local-parent");
    const { workflows, unavailable } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.path === child || w.path === other).map((w: any) => [w.path, w.location, w.project])).toEqual([
      [child, "run", root],
      [other, "run", root],
    ]);
    const folder = join(root, ".konductor", "workflows");
    expect(resolveWorkflowRef("../../custom/child.yml", parent, workflows, folder, unavailable)).toMatchObject({ ok: true, target: { path: child } });
    expect(resolveWorkflowRef(other, mine, workflows, folder, unavailable)).toMatchObject({ ok: true, target: { path: other } });
  });

  test("a .yaml working copy whose original is gone is still listed for recovery", async () => {
    for (const file of ["kept.yml", "kept.yaml"]) {
      const path = write(join(root, ".konductor", "workflows", file), ONE_STEP);
      await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "draft", base: hash(ONE_STEP), expected: null }) });
      rmSync(path);
      const listed = (await json("/api/workflows")).workflows.find((w: any) => w.path === path);
      expect([file, listed]).toMatchObject([file, { onDisk: false, workingCopy: "draft" }]);
    }
  });

  test("a working copy or working-copy folder that cannot be read leaves the listing intact and is reported", async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const one = write(join(root, ".konductor", "workflows", "one.yml"), ONE_STEP);
    const two = write(join(root, ".konductor", "workflows", "two.yml"), ONE_STEP);
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path: one, text: "draft", base: hash(ONE_STEP), expected: null }) });
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path: two, text: "draft", base: hash(ONE_STEP), expected: null }) });
    const editor = join(root, ".konductor", "editor", "project");
    const copy = join(editor, "one.yml");
    const base = join(editor, "two.yml.base");
    const locked = join(editor, "locked");
    write(join(locked, "new.yml"), "draft");
    chmodSync(copy, 0o000);
    chmodSync(base, 0o000);
    chmodSync(locked, 0o000);
    try {
      const { workflows, unavailable } = await json("/api/workflows");
      expect(workflows.find((w: any) => w.path === one)).toMatchObject({ onDisk: true, text: ONE_STEP });
      expect(workflows.find((w: any) => w.path === one).workingCopy).toBeUndefined();
      expect(workflows.find((w: any) => w.path === two)).toMatchObject({ workingCopy: "draft" });
      expect(workflows.find((w: any) => w.path === two).workingCopyBase).toBeUndefined();
      expect(unavailable.filter((u: any) => u.kind === "working-copy")).toEqual([
        { location: "project", kind: "working-copy", path: copy, reason: expect.stringContaining("EACCES") },
        { location: "project", kind: "working-copy", path: base, reason: expect.stringContaining("EACCES") },
        { location: "project", kind: "working-copy", path: locked, reason: expect.stringContaining("EACCES") },
      ]);
    } finally {
      chmodSync(copy, 0o644);
      chmodSync(base, 0o644);
      chmodSync(locked, 0o755);
    }
    expect(readFileSync(copy, "utf8")).toBe("draft");
  });

  test("a working-copy folder that cannot be searched is reported once, and its copies are kept", async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const one = write(join(root, ".konductor", "workflows", "one.yml"), ONE_STEP);
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path: one, text: "draft", base: hash(ONE_STEP), expected: null }) });
    const editor = join(root, ".konductor", "editor");
    chmodSync(editor, 0o000);
    try {
      const { workflows, unavailable } = await json("/api/workflows");
      expect(workflows.find((w: any) => w.path === one)).toMatchObject({ onDisk: true, text: ONE_STEP });
      expect(unavailable.filter((u: any) => u.kind === "working-copy")).toEqual([
        { location: "project", kind: "working-copy", path: editor, reason: expect.stringContaining("EACCES") },
      ]);
    } finally {
      chmodSync(editor, 0o755);
    }
    expect(readFileSync(join(editor, "project", "one.yml"), "utf8")).toBe("draft");
  });

  // A working copy keeps the hash of the original it was made from, so a
  // copy restored after the file changed on disk can be told apart from one
  // made from the file as it is.
  test("lists a working copy with its own hash and the hash of the original it was made from", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const text = `${TWO_STEPS}# unsaved\n`;
    const put = await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text, base: hash(TWO_STEPS), expected: null }) });
    expect(put.hash).toBe(hash(text));
    writeFileSync(path, `${TWO_STEPS}# changed on disk\n`);
    const listed = (await json("/api/workflows")).workflows.find((w: any) => w.path === path);
    expect(listed).toMatchObject({
      hash: hash(`${TWO_STEPS}# changed on disk\n`),
      workingCopy: text,
      workingCopyHash: hash(text),
      workingCopyBase: hash(TWO_STEPS),
    });
    await json("/api/working-copies", { method: "DELETE", body: JSON.stringify({ path, expected: hash(text) }) });
    expect(readdirSync(join(root, ".konductor", "editor", "project"))).toEqual([]);
  });

  // Two tabs on one workflow share its working copy: a tab writes or removes
  // it only when it still holds what that tab last saw.
  test("refuses to write or remove a working copy that changed since the tab last saw it", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const copy = join(root, ".konductor", "editor", "project", "two-steps.yml");
    const mine = `${TWO_STEPS}# tab A\n`;
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: mine, base: hash(TWO_STEPS), expected: null }) });
    // Tab B loaded before tab A's edit, so it saw no working copy.
    const stalePut = await api("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "x", base: hash(TWO_STEPS), expected: null }) });
    expect(stalePut.status).toBe(409);
    const staleDelete = await api("/api/working-copies", { method: "DELETE", body: JSON.stringify({ path, expected: null }) });
    expect(staleDelete.status).toBe(409);
    expect(readFileSync(copy, "utf8")).toBe(mine);
    // Tab A, which saw its own copy, may replace it.
    const next = `${mine}# again\n`;
    await json("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: next, base: hash(TWO_STEPS), expected: hash(mine) }) });
    expect(readFileSync(copy, "utf8")).toBe(next);
  });

  test("tells a watcher when the open file changes on disk", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const res = await fetch(`${server.url}/api/watch?path=${encodeURIComponent(path)}&token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const changed = `${TWO_STEPS}# changed\n`;
    setTimeout(() => writeFileSync(path, changed), 100);
    let seen = "";
    const deadline = Date.now() + 5000;
    while (!seen.includes(hash(changed)) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    await reader.cancel();
    expect(seen).toContain(`"hash":"${hash(changed)}"`);
  });

  test("a watched file that becomes unreadable is reported to its watcher as unreadable; the server keeps serving", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS);
    const res = await fetch(`${server.url}/api/watch?path=${encodeURIComponent(path)}&token=${TOKEN}`);
    const reader = res.body!.getReader();
    setTimeout(() => chmodSync(path, 0o000), 100);
    try {
      let seen = "";
      const deadline = Date.now() + 5000;
      while (!seen.includes("EACCES") && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      await reader.cancel();
      expect(seen).toContain(`"hash":null`);
      expect(seen).toContain("EACCES");
      const { unavailable } = await json("/api/workflows");
      expect(unavailable).toContainEqual({ location: "project", kind: "file", path, reason: expect.stringContaining("EACCES") });
    } finally {
      chmodSync(path, 0o644);
    }
  });
});

describe("library", () => {
  test("lists every entry at each level, with its files and which entry wins", async () => {
    write(join(root, ".konductor", "library", "artifacts", "design", "guide.md"), "project guide\n");
    write(join(home, ".konductor", "library", "artifacts", "design", "guide.md"), "user guide\n");
    write(join(home, ".konductor", "library", "artifacts", "design", "review.md"), "user review\n");
    write(join(home, ".konductor", "library", "artifacts", "notes", "template.md"), "# Notes\n");
    const { entries } = await json("/api/library");
    const mine = entries.filter((e: any) => e.level !== "package");
    expect(mine).toEqual([
      {
        id: "design",
        level: "project",
        folder: join(root, ".konductor", "library", "artifacts", "design"),
        group: "",
        files: { "guide.md": "project guide\n" },
        hides: "user",
      },
      {
        id: "design",
        level: "user",
        folder: join(home, ".konductor", "library", "artifacts", "design"),
        group: "",
        files: { "guide.md": "user guide\n", "review.md": "user review\n" },
        hiddenBy: "project",
      },
      {
        id: "notes",
        level: "user",
        folder: join(home, ".konductor", "library", "artifacts", "notes"),
        group: "",
        files: { "template.md": "# Notes\n" },
      },
    ]);
    // The package's design entry is hidden by the project's.
    expect(entries.find((e: any) => e.id === "design" && e.level === "package")).toMatchObject({ hiddenBy: "project" });
  });

  test("an entry's description comes from its entry.yml, which is not listed as a file", async () => {
    const folder = join(root, ".konductor", "library", "artifacts", "notes");
    write(join(folder, "entry.yml"), "# what the notes are\ndescription: >\n  The notes kept\n  while working.\n");
    write(join(folder, "guide.md"), "guide\n");
    const { entries } = await json("/api/library");
    expect(entries.find((e: any) => e.id === "notes")).toEqual({
      id: "notes",
      level: "project",
      folder,
      group: "",
      description: "The notes kept while working.",
      files: { "guide.md": "guide\n" },
    });
  });

  test("an entry.yml that does not match its schema is reported on the entry, not as a failed listing", async () => {
    const base = join(root, ".konductor", "library", "artifacts");
    write(join(base, "empty", "entry.yml"), "description: ''\n");
    write(join(base, "extra", "entry.yml"), "description: Fine.\ncolour: red\n");
    write(join(base, "broken", "entry.yml"), "description: [unclosed\n");
    const { entries } = await json("/api/library");
    const mine = (id: string) => entries.find((e: any) => e.id === id && e.level === "project");
    expect(mine("empty").description).toBeUndefined();
    expect(mine("empty").entryProblem).toContain("description");
    expect(mine("extra").entryProblem).toContain("colour");
    expect(mine("broken").entryProblem).toContain("not valid YAML");
  });

  test("an entry filed in folders names them as its group; a folder of folders is not an entry", async () => {
    const base = join(root, ".konductor", "library", "artifacts");
    write(join(base, "writing", "long-form", "essay", "guide.md"), "guide\n");
    write(join(base, "writing", "notes", ".keep"), "");
    const { entries } = await json("/api/library");
    const mine = entries.filter((e: any) => e.level === "project").map((e: any) => [e.id, e.group]);
    expect(mine).toEqual([
      ["essay", "writing/long-form"],
      ["notes", "writing"],
    ]);
  });

  test("a folder holding a hidden file and a folder is one entry, not a group", async () => {
    const base = join(root, ".konductor", "library", "artifacts");
    write(join(base, "essay", ".keep"), "");
    write(join(base, "essay", "examples", "example.md"), "example\n");
    const { entries } = await json("/api/library");
    expect(entries.filter((e: any) => e.level === "project").map((e: any) => [e.id, e.group])).toEqual([["essay", ""]]);
  });

  test("an id filed twice in one library is reported on both entries", async () => {
    const base = join(root, ".konductor", "library", "artifacts");
    write(join(base, "essay", "guide.md"), "guide\n");
    write(join(base, "writing", "essay", "guide.md"), "guide\n");
    const { entries } = await json("/api/library");
    const twins = entries.filter((e: any) => e.id === "essay" && e.level === "project");
    expect(twins).toHaveLength(2);
    for (const e of twins) expect(e.entryProblem).toContain("ambiguous");
  });

  test("a file that is a symlink names where it leads, relative to the repository holding it", async () => {
    write(join(root, "skills", "essay-writing", "SKILL.md"), "the skill\n");
    const folder = join(root, ".konductor", "library", "artifacts", "essay");
    mkdirSync(folder, { recursive: true });
    symlinkSync("../../../../skills/essay-writing/SKILL.md", join(folder, "guide.md"));
    write(join(folder, "review.md"), "review\n");
    const { entries } = await json("/api/library");
    const essay = entries.find((e: any) => e.id === "essay");
    expect(essay.files["guide.md"]).toBe("the skill\n");
    expect(essay.links).toEqual({ "guide.md": { path: join(root, "skills", "essay-writing", "SKILL.md"), display: "skills/essay-writing/SKILL.md" } });
    // A shipped guide that links to a fuse-konductor skill.
    const doc = entries.find((e: any) => e.id === "doc-accuracy" && e.level === "package");
    expect(doc.links["guide.md"].display).toBe("skills/doc-accuracy-analyzer/SKILL.md");
  });

  test("a library file that cannot be read is left out of its entry with the reason; the listing still loads", async () => {
    const folder = join(root, ".konductor", "library", "artifacts", "locked");
    const guide = write(join(folder, "guide.md"), "guide\n");
    write(join(folder, "review.md"), "review\n");
    chmodSync(guide, 0o000);
    try {
      const { entries } = await json("/api/library");
      expect(entries.find((e: any) => e.id === "locked").files).toEqual({ "review.md": "review\n" });
      // It is named with the reason, so it is not taken for a missing file.
      expect(entries.find((e: any) => e.id === "locked").unreadable).toEqual({ "guide.md": expect.stringContaining("EACCES") });
    } finally {
      chmodSync(guide, 0o644);
    }
  });

  test("every entry that ships with fuse-flow has a description", async () => {
    const { entries } = await json("/api/library");
    const shipped = entries.filter((e: any) => e.level === "package");
    expect(shipped.length).toBeGreaterThan(0);
    for (const entry of shipped) {
      expect({ id: entry.id, problem: entry.entryProblem }).toEqual({ id: entry.id, problem: undefined });
      expect(typeof entry.description).toBe("string");
    }
  });
});

describe("workstreams", () => {
  test("a run's links: the workstream it came after, its parent, and the children its steps wait for", async () => {
    const workflows = join(root, ".konductor", "workflows");
    write(
      join(workflows, "child.yml"),
      `version: 1
name: child
inputs:
  - artifact: given-diff
steps:
  - id: review
    instruction: Review the diff.
    consumes: [given-diff]
    produces: { artifact: report, path: "reports/{slug}.md" }
`,
    );
    write(
      join(workflows, "parent.yml"),
      `version: 1
name: parent
hands_off_to: next
steps:
  - id: intake
    instruction: Write the diff.
    produces: { artifact: diff, path: "diffs/{slug}.diff" }
  - id: adversarial
    instruction: Merge the findings.
    gates:
      - workflow: child
        slug: "{slug}-adv"
        inputs: { given-diff: diff }
        returns: { findings: report }
`,
    );
    write(
      join(workflows, "next.yml"),
      `version: 1
name: next
inputs:
  - artifact: diff
steps:
  - id: build
    instruction: Build on the diff.
    consumes: [diff]
`,
    );
    flow("start", "pr", "--workflow", "parent");
    write(join(root, "diffs", "pr.diff"), "");
    // Handing out the delegating step creates the child.
    flow("continue", "pr");
    flow("start", "feat", "--workflow", "next", "--after", "pr");

    const { workstreams } = await json("/api/workstreams");
    const bySlug = Object.fromEntries(workstreams.map((w: any) => [w.slug, w]));
    expect(Object.keys(bySlug).sort()).toEqual(["feat", "pr", "pr-adv"]);

    const pr = bySlug.pr;
    expect(pr.children).toEqual([{ step: "adversarial", pass: 1, slug: "pr-adv" }]);
    expect(pr.startedAfter).toEqual(["feat"]);
    expect(pr.after).toBeUndefined();
    expect(pr.parent).toBeUndefined();
    expect(pr.steps.adversarial.children).toEqual([{ pass: 1, slug: "pr-adv" }]);
    expect(pr.events.filter((e: any) => e.kind === "child-created").map((e: any) => [e.step, e.detail])).toEqual([["adversarial", "pr-adv"]]);

    const child = bySlug["pr-adv"];
    expect(child).toMatchObject({
      workflow: "child",
      workflowPath: join(workflows, "child.yml"),
      parent: { slug: "pr", step: "adversarial" },
      inputs: { "given-diff": "diffs/pr.diff" },
      startedAfter: [],
      children: [],
    });
    expect(child.after).toBeUndefined();

    const feat = bySlug.feat;
    expect(feat).toMatchObject({ after: "pr", inputs: { diff: "diffs/pr.diff" }, startedAfter: [], children: [] });
    expect(feat.parent).toBeUndefined();
  });
  test("a run's events, states, times, visits and routes back, from real fuse-flow commands", async () => {
    write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS.replace("    consumes: [notes]\n", ""));
    flow("start", "demo", "--workflow", "two-steps");
    flow("continue", "demo");
    flow("continue", "demo", "--owner-approved", "--note", "good draft");
    flow("continue", "demo");
    flow("continue", "demo", "--back-to", "draft", "--note", "start over");

    const { workstreams } = await json("/api/workstreams");
    expect(workstreams).toHaveLength(1);
    const run = workstreams[0];
    expect(run.slug).toBe("demo");
    expect(run.workflowPath).toBe(join(root, ".konductor", "workflows", "two-steps.yml"));
    // Events of one command share a millisecond often enough that only each
    // step's own order is fixed; the run as a whole is ordered by time.
    const of = (step: string) => run.events.filter((e: any) => e.step === step);
    expect(of("draft").map((e: any) => [e.kind, e.from, e.to, e.actor])).toEqual([
      ["handed-out", "PENDING", "IN_PROGRESS", "agent"],
      ["awaiting-owner", "IN_PROGRESS", "AWAITING_OWNER", "agent"],
      ["approved", "AWAITING_OWNER", "COMPLETED", "owner"],
      ["sent-back", "COMPLETED", "PENDING", "owner"],
      ["handed-out", "PENDING", "IN_PROGRESS", "agent"],
    ]);
    expect(of("polish").map((e: any) => [e.kind, e.from, e.to, e.actor])).toEqual([
      ["handed-out", "PENDING", "IN_PROGRESS", "agent"],
      ["awaiting-owner", "IN_PROGRESS", "AWAITING_OWNER", "agent"],
      ["sent-back", "AWAITING_OWNER", "PENDING", "owner"],
    ]);
    const times = run.events.map((e: any) => e.time);
    expect(times).toEqual([...times].sort());
    for (const t of times) expect(Date.parse(t)).not.toBeNaN();
    expect(of("draft")[2].detail).toBe("good draft");
    const sentBack = of("draft")[3];
    expect(sentBack).toMatchObject({ backFrom: "polish", backTo: "draft", detail: "start over" });
    // One send-back writes one line, with one time, to every step it reopens.
    expect(of("polish")[2].time).toBe(sentBack.time);

    const s = run.summary;
    expect(s).toMatchObject({ status: "IN_PROGRESS", currentStep: "draft", started: run.events[0].time });
    expect(s.steps.draft).toMatchObject({ status: "IN_PROGRESS", visits: 2 });
    expect(s.steps.polish).toMatchObject({ status: "PENDING", visits: 1 });
    expect(s.steps.draft.ownerWaitMs).toBeGreaterThan(0);
    expect(s.ownerWaitMs).toBe(s.steps.draft.ownerWaitMs + s.steps.polish.ownerWaitMs);
    // Written on both reopened steps, counted once.
    expect(s.routesBack).toEqual([{ time: sentBack.time, from: "polish", to: "draft" }]);
  });

  test("skips, blocks and granted rounds, with who caused them", async () => {
    write(
      join(root, ".konductor", "workflows", "gated.yml"),
      `version: 1
name: gated
steps:
  - id: intro
    instruction: Say hello.
  - id: review
    instruction: Review it.
    gates:
      - agent: review the hello
  - id: extra
    instruction: Maybe more.
    condition:
      agent: the owner wants more
  - id: end
    instruction: Finish.
`,
    );
    flow("start", "g", "--workflow", "gated", "--from", "review");
    flow("continue", "g", "--blocked", "round cap reached");
    flow("continue", "g", "--more-rounds", "1");
    flow("continue", "g", "--waived", "the owner read the hello");
    flow("continue", "g", "--skip", "the owner wants no more");
    const run = (await json("/api/workstreams")).workstreams[0];
    const byStep = (step: string) =>
      run.events.filter((e: any) => e.step === step).map((e: any) => [e.kind, e.to, e.actor, e.detail]);
    expect(byStep("intro")).toEqual([["skipped", "SKIPPED", "owner", "started at review"]]);
    expect(byStep("review")).toEqual([
      ["handed-out", "IN_PROGRESS", "agent", ""],
      ["blocked", "BLOCKED", "agent", "round cap reached"],
      ["rounds-granted", "IN_PROGRESS", "owner", "granted 1 more review round"],
      ["review-waived", "IN_PROGRESS", "owner", "the owner read the hello"],
      ["completed", "COMPLETED", "agent", ""],
    ]);
    expect(byStep("extra")).toEqual([
      ["handed-out", "IN_PROGRESS", "agent", ""],
      ["skipped", "SKIPPED", "agent", "the owner wants no more"],
    ]);
    expect(byStep("end")).toEqual([["handed-out", "IN_PROGRESS", "agent", ""]]);
    expect(run.summary.steps.intro).toMatchObject({ status: "SKIPPED", skipReason: "started at review", visits: 0 });
    expect(run.summary.steps.review.ownerWaitMs).toBeGreaterThan(0);
  });

  test("a step skipped on its owner-action condition is the owner's skip", async () => {
    write(
      join(root, ".konductor", "workflows", "asked.yml"),
      `version: 1
name: asked
steps:
  - id: extra
    instruction: Maybe more.
    condition:
      owner-action: ask whether the owner wants more
  - id: end
    instruction: Finish.
`,
    );
    flow("start", "a", "--workflow", "asked");
    flow("continue", "a", "--skip", "the owner wants no more");
    const run = (await json("/api/workstreams")).workstreams[0];
    const skip = run.events.find((e: any) => e.step === "extra" && e.kind === "skipped");
    expect(skip).toMatchObject({ actor: "owner", to: "SKIPPED", detail: "the owner wants no more" });
  });

  test("a workstream whose workflow no longer resolves has no workflow path", async () => {
    const path = write(join(root, ".konductor", "workflows", "two-steps.yml"), TWO_STEPS.replace("    consumes: [notes]\n", ""));
    flow("start", "demo", "--workflow", "two-steps");
    rmSync(path);
    const run = (await json("/api/workstreams")).workstreams[0];
    expect(run.slug).toBe("demo");
    expect(run.workflowPath).toBeUndefined();
    expect(run.events).toHaveLength(1);
  });
});

describe("projects", () => {
  const ONE = "version: 1\nname: one\nsteps:\n  - id: only\n    instruction: Do it.\n";
  const projectsFile = () => join(home, ".konductor", "projects.yml");

  // A second repository with its own copy of a workflow and one run of it.
  function otherProject(name = "other"): string {
    const other = join(root, name);
    mkdirSync(join(other, ".git"), { recursive: true });
    write(join(other, ".konductor", "workflows", "one.yml"), ONE);
    flowIn(other, "start", "theirs", "--workflow", "one");
    return other;
  }

  // A project for the folder scan: a run file is all the scan looks for.
  function runFile(dir: string): string {
    write(join(dir, ".konductor", "workstreams", "run.yml"), "not read by the scan\n");
    return dir;
  }

  test("runs of every registered project are listed with their project", async () => {
    write(join(root, ".konductor", "workflows", "one.yml"), ONE);
    flow("start", "mine", "--workflow", "one");
    const other = otherProject();

    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.map((w: any) => [w.project, w.slug])).toEqual([
      [root, "mine"],
      [other, "theirs"],
    ]);
    expect(workstreams[1].workflowPath).toBe(join(other, ".konductor", "workflows", "one.yml"));
    expect(workstreams[1].summary).toMatchObject({ status: "IN_PROGRESS", currentStep: "only" });
  });

  test("a run's links stay within its own project, though slugs repeat between projects", async () => {
    const next = "version: 1\nname: next\nsteps:\n  - id: only\n    instruction: Do it.\n";
    write(join(root, ".konductor", "workflows", "one.yml"), ONE);
    write(join(root, ".konductor", "workflows", "next.yml"), next);
    flow("start", "theirs", "--workflow", "one");
    flow("start", "after-mine", "--workflow", "next", "--after", "theirs");
    const other = otherProject();
    write(join(other, ".konductor", "workflows", "next.yml"), next);
    flowIn(other, "start", "after-theirs", "--workflow", "next", "--after", "theirs");

    const { workstreams } = await json("/api/workstreams");
    const run = (project: string, slug: string) => workstreams.find((w: any) => w.project === project && w.slug === slug);
    expect(run(root, "theirs").startedAfter).toEqual(["after-mine"]);
    expect(run(other, "theirs").startedAfter).toEqual(["after-theirs"]);
    expect(run(other, "after-theirs")).toMatchObject({ project: other, after: "theirs" });
  });

  test("the workflow file another project's run follows is listed read-only", async () => {
    const other = otherProject();
    const path = join(other, ".konductor", "workflows", "one.yml");
    const listed = (await json("/api/workflows")).workflows.filter((w: any) => w.location === "run");
    expect(listed).toEqual([{ location: "run", project: other, dir: "", file: "one.yml", path, onDisk: true, text: ONE, hash: hash(ONE) }]);

    const update = await api("/api/workflows", { method: "PUT", body: JSON.stringify({ path, baseHash: hash(ONE), text: "x" }) });
    expect(update.status).toBe(403);
    const copy = await api("/api/working-copies", { method: "PUT", body: JSON.stringify({ path, text: "x" }) });
    expect(copy.status).toBe(403);
    expect(readFileSync(path, "utf8")).toBe(ONE);
  });

  // fuse-flow reads a hand-off or a workflow gate that names its workflow by
  // a path relative to the file; a target in the same project is listed, so
  // the link opens before the target has a run of its own.
  test("the workflows a listed run file names by a path inside its project are listed read-only", async () => {
    const other = otherProject();
    const parent = write(
      join(other, "custom", "parent.yml"),
      "version: 1\nname: parent\nhands_off_to: child.yml\nsteps:\n  - id: only\n    instruction: Do it.\n    gates:\n      - workflow: ../procedures/sub.yml\n",
    );
    const child = write(join(other, "custom", "child.yml"), ONE);
    const sub = write(join(other, "procedures", "sub.yml"), ONE);
    write(join(root, "outside.yml"), ONE);
    write(join(other, "custom", "far.yml"), "version: 1\nname: far\nhands_off_to: ../../outside.yml\nsteps:\n  - id: only\n    instruction: x\n");
    flowIn(other, "start", "external-run", "--workflow", "custom/parent.yml");
    flowIn(other, "start", "far-run", "--workflow", "custom/far.yml");
    // A path that names no file any more stays not found, rather than unreadable.
    write(join(other, "custom", "missing.yml"), "version: 1\nname: m\nhands_off_to: gone.yml\nsteps:\n  - id: only\n    instruction: x\n");
    const gone = write(join(other, "custom", "gone.yml"), ONE);
    flowIn(other, "start", "missing-run", "--workflow", "custom/missing.yml");
    rmSync(gone);
    const { workflows, unavailable } = await json("/api/workflows");
    const listed = workflows.filter((w: any) => w.location === "run").map((w: any) => w.path);
    expect(listed).toEqual(expect.arrayContaining([parent, child, sub]));
    // Outside the project, a reference is not followed.
    expect(listed).not.toContain(join(root, "outside.yml"));
    // Only this test's run workflows matter here; a checkout may carry its
    // own broken personal links in the shipped folder.
    expect(unavailable.filter((u: any) => u.location === "run")).toEqual([]);
  });

  // A name in another project's workflow resolves in that project's own
  // folder first, so Komposer needs every file there, not only the ones a
  // run follows, and each project's folder to look in.
  test("every workflow file in another project's workflow folder is listed read-only", async () => {
    const other = otherProject();
    const folder = join(other, ".konductor", "workflows");
    const child = write(join(folder, "review", "child.yml"), ONE);
    const listed = (await json("/api/workflows")).workflows.filter((w: any) => w.location === "run");
    expect(listed.map((w: any) => [w.project, w.path])).toEqual([
      [other, join(folder, "one.yml")],
      [other, child],
    ]);
    const projects = (await json("/api/projects")).projects;
    expect(projects.map((p: any) => [p.path, p.workflowsDir])).toEqual([
      [root, join(root, ".konductor", "workflows")],
      [other, folder],
    ]);
  });

  test("a project whose runs cannot be read is reported on that project; the others still load", async () => {
    write(join(root, ".konductor", "workflows", "one.yml"), ONE);
    flow("start", "mine", "--workflow", "one");
    const other = otherProject();
    const runsDir = join(other, ".konductor", "workstreams");
    chmodSync(runsDir, 0o000);
    try {
      expect((await json("/api/workstreams")).workstreams.map((w: any) => [w.project, w.slug])).toEqual([[root, "mine"]]);
      expect((await api("/api/workflows")).status).toBe(200);
      const projects = (await json("/api/projects")).projects;
      expect(projects[0]).toMatchObject({ path: root, runs: 1 });
      expect(projects[1].path).toBe(other);
      expect(projects[1].runs).toBeUndefined();
      expect(projects[1].error).toContain("EACCES");
    } finally {
      chmodSync(runsDir, 0o755);
    }
  });

  test("a workflow file of another project that cannot be read leaves the other answers intact", async () => {
    write(join(root, ".konductor", "workflows", "one.yml"), ONE);
    flow("start", "mine", "--workflow", "one");
    const other = otherProject();
    const file = join(other, ".konductor", "workflows", "one.yml");
    chmodSync(file, 0o000);
    try {
      const { workflows } = await json("/api/workflows");
      expect(workflows.filter((w: any) => w.location === "run")).toEqual([]);
      const { workstreams } = await json("/api/workstreams");
      expect(workstreams.map((w: any) => [w.project, w.slug])).toEqual([
        [root, "mine"],
        [other, "theirs"],
      ]);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  // fuse-flow picks a workflow name by the files that exist and only then
  // reads the one it picked, so an unreadable file still wins over a shared
  // workflow of the same name, and a folder it cannot search fails every
  // name looked up there. A link must lead to that failure, not to the
  // shared workflow.
  const resolveIn = async (project: string, ref: string) => {
    const { workflows, unavailable } = await json("/api/workflows");
    const from = join(project, ".konductor", "workflows", "parent.yml");
    return resolveWorkflowRef(ref, from, workflows, workflowDirs(project)[0], unavailable);
  };

  test("an unreadable workflow file of another project keeps its name from a shared one", async () => {
    write(join(home, ".konductor", "workflows", "one.yml"), ONE);
    const other = otherProject();
    const file = join(other, ".konductor", "workflows", "one.yml");
    chmodSync(file, 0o000);
    try {
      const { unavailable } = await json("/api/workflows");
      // Only another project's: a broken link in a local location is listed too.
      expect(unavailable.filter((u: any) => u.location === "run")).toEqual([{ location: "run", project: other, kind: "file", path: file, reason: expect.stringContaining("EACCES") }]);
      expect(() => flowIn(other, "start", "again", "--workflow", "one")).toThrow(/EACCES/);
      const link = await resolveIn(other, "one");
      expect(link).toMatchObject({ ok: false, unavailable: { path: file } });
      expect(!link.ok && link.reason).toContain("EACCES");
      // With a readable file of that name, the name is ambiguous, as fuse-flow says.
      const copy = write(join(other, ".konductor", "workflows", "copy", "one.yml"), ONE);
      const twice = await resolveIn(other, "one");
      expect(!twice.ok && twice.reason).toBe(`workflow name "one" is ambiguous; rename one of: ${copy}, ${file}`);
    } finally {
      chmodSync(file, 0o644);
    }
  });

  test("a workflow folder of another project that cannot be searched fails every name there", async () => {
    write(join(home, ".konductor", "workflows", "child.yml"), ONE);
    const other = otherProject();
    const folder = join(other, ".konductor", "workflows");
    const locked = join(folder, "review");
    write(join(locked, "child.yml"), ONE);
    chmodSync(locked, 0o000);
    try {
      const { unavailable } = await json("/api/workflows");
      // Only another project's: a broken link in a local location is listed too.
      expect(unavailable.filter((u: any) => u.location === "run")).toEqual([{ location: "run", project: other, kind: "folder", path: folder, reason: expect.stringContaining("EACCES") }]);
      expect(() => flowIn(other, "start", "again", "--workflow", "child")).toThrow(/EACCES/);
      for (const ref of ["child", "one"]) {
        const link = await resolveIn(other, ref);
        expect(link).toMatchObject({ ok: false, unavailable: { path: folder } });
        expect(!link.ok && link.reason).toContain(locked);
      }
      // fuse-flow cannot find the run's own workflow either; the run is still listed.
      const { workstreams } = await json("/api/workstreams");
      expect(workstreams.map((w: any) => [w.slug, w.workflowPath])).toEqual([["theirs", undefined]]);
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("a run of another project that follows a listed workflow is not listed twice", async () => {
    write(join(home, ".konductor", "workflows", "shared.yml"), ONE);
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    flowIn(other, "start", "theirs", "--workflow", "shared");
    const { workflows } = await json("/api/workflows");
    expect(workflows.filter((w: any) => w.location === "run")).toEqual([]);
    const run = (await json("/api/workstreams")).workstreams[0];
    expect(run).toMatchObject({ project: other, workflowPath: join(home, ".konductor", "workflows", "shared.yml") });
  });

  test("the list shows this project first, run counts, and a registered folder that is gone", async () => {
    write(join(root, ".konductor", "workflows", "one.yml"), ONE);
    flow("start", "mine", "--workflow", "one");
    const other = otherProject();
    const gone = otherProject("gone");
    rmSync(gone, { recursive: true, force: true });

    expect(await json("/api/projects")).toEqual({
      projects: [
        { path: root, name: basename(root), current: true, workflowsDir: join(root, ".konductor", "workflows"), runs: 1 },
        { path: other, name: "other", current: false, workflowsDir: join(other, ".konductor", "workflows"), runs: 1 },
        { path: gone, name: "gone", current: false, workflowsDir: join(gone, ".konductor", "workflows"), missing: true },
      ],
    });
    // A gone project has no runs to list, and is no error.
    expect((await json("/api/workstreams")).workstreams.map((w: any) => w.slug)).toEqual(["mine", "theirs"]);
  });

  test("a broken projects file leaves this project's runs and reports why", async () => {
    write(projectsFile(), "projects: {not: a list}\n");
    const body = await json("/api/projects");
    expect(body.projects).toEqual([{ path: root, name: basename(root), current: true, workflowsDir: join(root, ".konductor", "workflows"), runs: 0 }]);
    expect(body.error).toContain("must hold a list of project paths");
  });

  test("adding a folder registers every project with runs at most four levels below it", async () => {
    const area = join(root, "area");
    const a = runFile(join(area, "a"));
    const worktree = runFile(join(area, "a", ".worktrees", "w1"));
    const deep = runFile(join(area, "b", "c", "d", "e"));
    runFile(join(area, "b", "c", "d", "e", "f")); // five levels down
    runFile(join(area, "node_modules", "pkg"));
    mkdirSync(join(area, "empty", ".konductor", "workstreams"), { recursive: true });

    const res = await json("/api/projects", { method: "POST", body: JSON.stringify({ path: area }) });
    expect(res).toEqual({ found: [a, worktree, deep], added: [a, worktree, deep] });
    expect(Bun.YAML.parse(readFileSync(projectsFile(), "utf8"))).toEqual({ projects: [a, worktree, deep] });

    // Adding again finds them and adds nothing.
    expect(await json("/api/projects", { method: "POST", body: JSON.stringify({ path: area }) })).toEqual({
      found: [a, worktree, deep],
      added: [],
    });
  });

  test("a scan that stops at its folder limit says so instead of reporting no workstreams", async () => {
    const area = join(root, "scan");
    for (let i = 0; i <= 20_010; i++) mkdirSync(join(area, "aaa", String(i)), { recursive: true });
    const res = await api("/api/projects", { method: "POST", body: JSON.stringify({ path: area }) });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toContain("stopped after reading 20,000 folders");
    const found = runFile(join(area, "0-first"));
    expect(await json("/api/projects", { method: "POST", body: JSON.stringify({ path: area }) })).toEqual({
      found: [found],
      added: [found],
      truncated: true,
    });
  }, 30_000); // it makes 20,011 folders

  // Sorted, a/b/c/link comes before z; the scan meets z there at its depth
  // limit first, and must still search z below it when it reaches z directly.
  test("a folder first reached through a deep symlink is still searched where it lies shallower", async () => {
    const area = join(root, "area");
    const project = runFile(join(area, "z", "project"));
    mkdirSync(join(area, "a", "b", "c"), { recursive: true });
    symlinkSync(join(area, "z"), join(area, "a", "b", "c", "link"));
    const res = await json("/api/projects", { method: "POST", body: JSON.stringify({ path: area }) });
    expect(res).toEqual({ found: [project], added: [project] });
  });

  test("adding takes ~/ paths, and refuses relative paths and files", async () => {
    const mine = runFile(join(home, "work", "mine"));
    expect(await json("/api/projects", { method: "POST", body: JSON.stringify({ path: "~/work" }) })).toEqual({
      found: [mine],
      added: [mine],
    });
    const relativePath = await api("/api/projects", { method: "POST", body: JSON.stringify({ path: "work" }) });
    expect(relativePath.status).toBe(400);
    const file = write(join(root, "file.txt"), "x");
    const notFolder = await api("/api/projects", { method: "POST", body: JSON.stringify({ path: file }) });
    expect(notFolder.status).toBe(400);
    expect(((await notFolder.json()) as { error: string }).error).toBe(`${file} is not a folder`);
  });

  test("this project is found by a scan but never written to the list", async () => {
    runFile(root);
    const res = await json("/api/projects", { method: "POST", body: JSON.stringify({ path: root }) });
    expect(res).toEqual({ found: [root], added: [] });
    expect(existsSync(projectsFile())).toBe(false);
  });

  test("removing a project takes it off the list; this project cannot be removed", async () => {
    const other = otherProject();
    expect(await json("/api/projects", { method: "DELETE", body: JSON.stringify({ path: other }) })).toEqual({ removed: true });
    expect((await json("/api/projects")).projects.map((p: any) => p.path)).toEqual([root]);
    expect((await json("/api/workstreams")).workstreams).toEqual([]);

    const self = await api("/api/projects", { method: "DELETE", body: JSON.stringify({ path: root }) });
    expect(self.status).toBe(400);
  });

  test("removing a project listed once for two spellings removes both registrations", async () => {
    const other = join(root, "other");
    mkdirSync(join(other, ".git"), { recursive: true });
    symlinkSync(other, join(root, "other-alias"));
    write(projectsFile(), `projects:\n  - ${join(root, "other-alias")}\n  - ${other}\n`);
    expect((await json("/api/projects")).projects.map((p: any) => p.path)).toEqual([root, join(root, "other-alias")]);
    expect(await json("/api/projects", { method: "DELETE", body: JSON.stringify({ path: join(root, "other-alias") }) })).toEqual({ removed: true });
    expect((await json("/api/projects")).projects.map((p: any) => p.path)).toEqual([root]);
  });
});

describe("review guides", () => {
  const FLOW = `version: 1
name: reviewed
steps:
  - id: write
    instruction: Write it.
    produces:
      - artifact: essay
        path: essay.md
      - artifact: notes
        path: notes.md
    gates:
      - check: default
      - agent: review the essay
        guide: rules/review.md
  - id: plain
    instruction: Check it.
    gates:
      - agent: look it over
`;

  test("names the review guide each agent gate uses, where it comes from, and the gate's own guide", async () => {
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), FLOW);
    write(join(root, ".konductor", "workflows", "rules", "review.md"), "gate rules\n");
    write(join(root, ".konductor", "library", "artifacts", "essay", "review.md"), "project essay rules\n");
    write(join(root, ".konductor", "library", "artifacts", "notes", "guide.md"), "notes guide\n");
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text: FLOW }) });
    const gateGuide = join(root, ".konductor", "workflows", "rules", "review.md");
    const essayRules = join(root, ".konductor", "library", "artifacts", "essay", "review.md");
    expect(out.gates).toEqual([
      {
        step: 0,
        gate: 1,
        gateGuide: { path: gateGuide, display: ".konductor/workflows/rules/review.md", exists: true },
        reviews: [
          // The project's library replaces the gate's guide for essay ...
          { artifact: "essay", guide: { path: essayRules, display: ".konductor/library/artifacts/essay/review.md", source: "project library" } },
          // ... and the gate's guide applies to notes.
          { artifact: "notes", guide: { path: gateGuide, display: ".konductor/workflows/rules/review.md", source: "gate" } },
        ],
      },
      { step: 1, gate: 0, reviews: [{}] },
    ]);
    expect(out.files[gateGuide]).toBe("gate rules\n");
    expect(out.files[essayRules]).toBe("project essay rules\n");
  });

  test("an artifact with no review guide falls back to its own guide", async () => {
    const text = FLOW.replace("        guide: rules/review.md\n", "");
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
    write(join(root, ".konductor", "library", "artifacts", "notes", "guide.md"), "notes guide\n");
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
    const notesGuide = join(root, ".konductor", "library", "artifacts", "notes", "guide.md");
    expect(out.gates[0]).toEqual({
      step: 0,
      gate: 1,
      reviews: [{ artifact: "essay" }, { artifact: "notes", ownGuide: { path: notesGuide, display: ".konductor/library/artifacts/notes/guide.md" } }],
    });
    expect(out.files[notesGuide]).toBe("notes guide\n");
  });

  test("a gate guide that does not exist still applies, as the engine prints it, and is marked missing", async () => {
    const text = FLOW.replace("guide: rules/review.md", "guide: rules/missing.md");
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
    const missing = join(root, ".konductor", "workflows", "rules", "missing.md");
    expect(out.gates[0].gateGuide).toEqual({ path: missing, display: ".konductor/workflows/rules/missing.md", exists: false });
    expect(out.gates[0].reviews[1]).toEqual({
      artifact: "notes",
      guide: { path: missing, display: ".konductor/workflows/rules/missing.md", source: "gate" },
    });
    expect(out.files[missing]).toBeUndefined();
  });

  test("a guide that exists but cannot be read says why, instead of looking missing", async () => {
    if (process.getuid?.() === 0) return; // root reads every file
    const text = FLOW.replace("rules/review.md", "rules/locked.md");
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
    const locked = write(join(root, ".konductor", "workflows", "rules", "locked.md"), "rules\n");
    chmodSync(locked, 0o000);
    try {
      const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
      expect(out.gates[0].gateGuide).toMatchObject({ path: locked, exists: true, unreadable: expect.stringContaining("EACCES") });
      expect(out.files[locked]).toBeUndefined();
    } finally {
      chmodSync(locked, 0o644);
    }
  });

  test("names every source of a review guide, in the engine's order", async () => {
    // design ships with a review guide, so the package library applies first.
    const text = (guide: string) => `version: 1
name: one
steps:
  - id: write
    instruction: Write it.
    produces:
      - artifact: design
        path: design.md
    gates:
      - agent: review it${guide}
`;
    const path = write(join(root, ".konductor", "workflows", "one.yml"), text(""));
    const ask = async (t: string) => {
      const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text: t }) });
      const guide = out.gates[0].reviews[0].guide;
      return { source: guide.source, path: guide.path, text: out.files[guide.path] };
    };
    const shipped = realpathSync(resolve(import.meta.dir, "..", "..", "..", "flow", "library", "artifacts", "design", "review.md"));
    expect(await ask(text(""))).toEqual({ source: "package library", path: shipped, text: readFileSync(shipped, "utf8") });

    const steps: [string, string, string][] = [
      ["user library", join(home, ".konductor", "library", "artifacts", "design", "review.md"), ""],
      ["user policy", join(home, ".konductor", "user-review.md"), ""],
      ["gate", join(root, ".konductor", "workflows", "gate-review.md"), "\n        guide: gate-review.md"],
      ["project library", join(root, ".konductor", "library", "artifacts", "design", "review.md"), "\n        guide: gate-review.md"],
      ["team policy", join(root, ".konductor", "team-review.md"), "\n        guide: gate-review.md"],
      ["local policy", join(root, ".konductor", "local-review.md"), "\n        guide: gate-review.md"],
    ];
    for (const [source, file, gateLine] of steps) {
      write(file, `${source} rules\n`);
      if (source === "user policy") write(join(home, ".konductor", "policy-overrides.yml"), "review:\n  guide: user-review.md\n");
      if (source === "team policy") write(join(root, ".konductor", "policy-overrides.yml"), "review:\n  guide: team-review.md\n");
      if (source === "local policy") {
        write(join(root, ".konductor", "policy-overrides.local.yml"), "review:\n  guide: local-review.md\n");
      }
      expect(await ask(text(gateLine))).toEqual({ source, path: file, text: `${source} rules\n` });
    }
  });

  test("a replaced library is not looked at: the winning entry's own guide applies", async () => {
    write(join(home, ".konductor", "library", "artifacts", "notes", "review.md"), "user rules\n");
    write(join(home, ".konductor", "library", "artifacts", "more", "notes", "review.md"), "user rules\n");
    const notesGuide = write(join(root, ".konductor", "library", "artifacts", "notes", "guide.md"), "notes guide\n");
    const text = FLOW.replace("        guide: rules/review.md\n", "");
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
    expect(out.gates[0].reviews[1]).toEqual({
      artifact: "notes",
      ownGuide: { path: notesGuide, display: ".konductor/library/artifacts/notes/guide.md" },
    });
  });

  test("lists the artifacts a step produces, may produce and updates", async () => {
    const text = `version: 1
name: modes
steps:
  - id: first
    instruction: Start.
    produces:
      - artifact: code
        path: src/
  - id: second
    instruction: Write.
    produces:
      - artifact: essay
        path: essay.md
    optional_produces:
      - artifact: notes
        path: notes.md
    updates:
      - artifact: code
        path: src/
    gates:
      - agent: review them
`;
    const path = write(join(root, ".konductor", "workflows", "modes.yml"), text);
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
    expect(out.gates.map((g: any) => [g.step, g.gate, g.reviews.map((r: any) => r.artifact)])).toEqual([
      [1, 0, ["essay", "notes", "code"]],
    ]);
    // The shipped code entry has a review guide.
    expect(out.gates[0].reviews[2].guide.source).toBe("package library");
  });

  test("uses the text sent, not the file on disk, and refuses a path outside the workflow locations", async () => {
    const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), "version: 1\nname: x\nsteps: []\n");
    const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text: FLOW }) });
    expect(out.gates.map((g: any) => [g.step, g.gate])).toEqual([[0, 1], [1, 0]]);
    const res = await api("/api/review-guides", { method: "POST", body: JSON.stringify({ path: join(root, "x.yml"), text: FLOW }) });
    expect(res.status).toBe(403);
  });

  describe("reads guides only inside the project, the libraries and the workflow locations", () => {
    let outsideDir: string;
    let secret: string;

    beforeEach(() => {
      outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "komposer-outside-")));
      secret = write(join(outsideDir, "secret.md"), "not for Komposer\n");
    });

    afterEach(() => {
      rmSync(outsideDir, { recursive: true, force: true });
    });

    const askFor = async (guide: string) => {
      const text = FLOW.replace("guide: rules/review.md", `guide: ${guide}`);
      const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
      return json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
    };

    const expectRefused = (out: any) => {
      expect(out.gates[0].gateGuide).toEqual({ path: secret, display: secret, outside: true, exists: false });
      expect(out.gates[0].reviews[1].guide).toEqual({ path: secret, display: secret, outside: true, source: "gate" });
      expect(out.files[secret]).toBeUndefined();
      expect(Object.values(out.files)).not.toContain("not for Komposer\n");
    };

    test("refuses an absolute guide path outside them", async () => {
      expectRefused(await askFor(secret));
    });

    test("refuses a ../ guide path that leaves the project", async () => {
      const relativeSecret = relative(join(root, ".konductor", "workflows"), secret);
      expect(relativeSecret.startsWith("..")).toBe(true);
      expectRefused(await askFor(relativeSecret));
    });

    test("refuses a guide inside the project that is a symlink to a file outside", async () => {
      const link = join(root, ".konductor", "workflows", "rules", "linked.md");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(secret, link);
      const out = await askFor("rules/linked.md");
      expect(out.gates[0].gateGuide).toMatchObject({ path: link, outside: true, exists: false });
      expect(out.files[link]).toBeUndefined();
    });

    test("refuses a project library guide that is a symlink to a file outside", async () => {
      const link = join(root, ".konductor", "library", "artifacts", "essay", "review.md");
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(secret, link);
      const text = FLOW.replace("        guide: rules/review.md\n", "");
      const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
      const out = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
      const refs = out.gates[0].reviews.flatMap((r: any) => [r.guide, r.ownGuide].filter(Boolean));
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs.filter((r: any) => r.path === link || r.path === secret)) {
        expect(ref.outside).toBe(true);
      }
      expect(refs.some((r: any) => r.path === link || r.path === secret)).toBe(true);
      expect(out.files[link]).toBeUndefined();
      expect(out.files[secret]).toBeUndefined();
      expect(Object.values(out.files)).not.toContain("not for Komposer\n");
    });

    test("the library sends no text of a project library file that links outside, and names where it leads", async () => {
      const folder = join(root, ".konductor", "library", "artifacts", "leak");
      write(join(folder, "guide.md"), "own guide\n");
      symlinkSync(secret, join(folder, "review.md"));
      const { entries } = await json("/api/library");
      const leak = entries.find((e: any) => e.id === "leak");
      expect(leak.files).toEqual({ "guide.md": "own guide\n" });
      expect(leak.links).toEqual({ "review.md": { path: secret, display: secret, outside: true } });
      expect(JSON.stringify(entries)).not.toContain("not for Komposer");
    });

    test("refuses another skill file in the clone that no shipped library entry names", async () => {
      const skill = join(import.meta.dir, "..", "..", "..", "..", "skills", "humanize-writing", "SKILL.md");
      expect(existsSync(skill)).toBe(true);
      const out = await askFor(skill);
      expect(out.gates[0].gateGuide).toMatchObject({ path: skill, outside: true, exists: false });
      expect(out.files[skill]).toBeUndefined();
    });

    test("answers the same for a missing file outside them as for an existing one", async () => {
      const missing = join(outsideDir, "missing.md");
      const out = await askFor(missing);
      expect(out.gates[0].gateGuide).toEqual({ path: missing, display: missing, outside: true, exists: false });
    });

    test("a guide inside them that cannot be read is named without its text; the answer still loads", async () => {
      const guide = write(join(root, ".konductor", "workflows", "rules", "review.md"), "gate rules\n");
      chmodSync(guide, 0o000);
      try {
        const out = await askFor("rules/review.md");
        expect(out.gates[0].gateGuide).toMatchObject({ path: guide, exists: true });
        expect(out.files[guide]).toBeUndefined();
      } finally {
        chmodSync(guide, 0o644);
      }
    });

    test("still reads a guide inside them, and a shipped guide that links to a skill", async () => {
      write(join(root, ".konductor", "workflows", "rules", "review.md"), "gate rules\n");
      const out = await askFor("rules/review.md");
      const gateGuide = join(root, ".konductor", "workflows", "rules", "review.md");
      expect(out.gates[0].gateGuide).toEqual({ path: gateGuide, display: ".konductor/workflows/rules/review.md", exists: true });
      expect(out.files[gateGuide]).toBe("gate rules\n");

      const text = FLOW.replace("artifact: essay", "artifact: code").replace("        guide: rules/review.md\n", "");
      const path = write(join(root, ".konductor", "workflows", "reviewed.yml"), text);
      const shipped = await json("/api/review-guides", { method: "POST", body: JSON.stringify({ path, text }) });
      const guide = shipped.gates[0].reviews[0].guide;
      expect(guide.source).toBe("package library");
      expect(guide.outside).toBeUndefined();
      expect(shipped.files[guide.path]).toBe(readFileSync(guide.path, "utf8"));
    });
  });
});

// POST /api/validate runs the checks of `fuse-flow validate` that need other
// files on the open text, as saved at the path sent. Each case is compared
// with what the real command says about the same file on disk.
describe("validate", () => {
  const validateCli = (file: string): { ok: boolean; out: string } => {
    const proc = Bun.spawnSync([process.execPath, "run", CLI, "validate", file], {
      cwd: root,
      env: { ...(process.env as Record<string, string>), HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { ok: proc.exitCode === 0, out: proc.stdout.toString() + proc.stderr.toString() };
  };
  const validate = (path: string, text: string) => json("/api/validate", { method: "POST", body: JSON.stringify({ path, text }) });
  const WORKFLOWS = () => join(root, ".konductor", "workflows");

  test("a missing gate guide is an error, as fuse-flow validate refuses it", async () => {
    const text = `version: 1
name: guided
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: review the draft
        guide: nope.md
`;
    const path = write(join(WORKFLOWS(), "guided.yml"), text);
    expect(validateCli(path)).toMatchObject({ ok: false });
    const out = await validate(path, text);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain("steps.0 (draft): the review guide of agent(review the draft) does not exist");
    write(join(WORKFLOWS(), "nope.md"), "rules\n");
    expect(validateCli(path).ok).toBe(true);
    expect(await validate(path, text)).toEqual({ errors: [], warnings: [], problems: [] });
  });

  test("a workflow gate whose child needs an input it is not given, or that returns what the child never writes", async () => {
    write(
      join(WORKFLOWS(), "child.yml"),
      `version: 1
name: child
inputs:
  - artifact: request
    required: true
steps:
  - id: work
    instruction: Do it.
`,
    );
    const text = `version: 1
name: parent
steps:
  - id: ask
    instruction: Ask.
    gates:
      - workflow: child
        returns: [ghost]
`;
    const path = write(join(WORKFLOWS(), "parent.yml"), text);
    expect(validateCli(path).ok).toBe(false);
    const out = await validate(path, text);
    expect(out.errors).toEqual([
      'step ask, workflow child: child requires the input "request", and the gate\'s inputs do not give it',
      'step ask, workflow child: returns "ghost" from "ghost", which child neither writes, returns nor takes as an input',
    ]);
  });

  test("a workflow gate that leads back to its own workflow", async () => {
    const text = `version: 1
name: cycle
steps:
  - id: loop
    instruction: Loop.
    gates:
      - workflow: cycle
`;
    const path = write(join(WORKFLOWS(), "cycle.yml"), text);
    expect(validateCli(path).ok).toBe(false);
    const out = await validate(path, text);
    expect(out.errors).toEqual(["step loop, workflow cycle: the workflow gates lead back to this workflow (cycle -> cycle), so it would wait for itself"]);
  });

  test("checks the text at the path it would be saved to, which need not exist yet", async () => {
    const text = `version: 1
name: alpha
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: review it
        guide: ../../README.md
`;
    write(join(root, "README.md"), "rules\n");
    const here = write(join(WORKFLOWS(), "alpha.yml"), text);
    expect(await validate(here, text)).toEqual({ errors: [], warnings: [], problems: [] });
    const there = join(WORKFLOWS(), "team", "alpha3.yml");
    const out = await validate(there, text);
    expect(existsSync(there)).toBe(false);
    expect(out.errors).toHaveLength(1);
    expect(out.errors[0]).toContain(`the review guide of agent(review it) does not exist: ${join(root, ".konductor", "README.md")}`);
    expect(out.warnings).toEqual(['name "alpha" differs from the file name; fuse-flow finds a workflow by its file name, alpha3']);
    write(there, text);
    expect(validateCli(there).ok).toBe(false);
    // The references written again for the new folder name the same guide.
    const moved = movedRefEdits(text, here, there).reduce(applyEdit, text);
    expect(await validate(there, moved)).toMatchObject({ errors: [] });
    write(there, moved);
    expect(validateCli(there).ok).toBe(true);
  });

  // ../tail is a path to the extensionless file tail; moved one folder up,
  // the same path written as tail would be a name, and fuse-flow would find
  // tail.yml, a different workflow, instead.
  test("Save as new keeps a path that would lose its last slash naming the same file", async () => {
    const one = (name: string) => `version: 1\nname: ${name}\nsteps:\n  - id: ${name}\n    instruction: Do it.\n`;
    write(join(WORKFLOWS(), "origin", "tail"), one("intended-target"));
    write(join(WORKFLOWS(), "origin", "tail.yml"), one("wrong-target"));
    const text = "version: 1\nname: path-handoff\nhands_off_to: ../tail\nsteps:\n  - id: ask\n    instruction: Ask.\n    gates:\n      - workflow: ../tail\n";
    const here = write(join(WORKFLOWS(), "origin", "deep", "path-handoff.yml"), text);
    const there = join(WORKFLOWS(), "origin", "copied.yml");
    const moved = movedRefEdits(text, here, there).reduce(applyEdit, text);
    write(there, moved);
    const targets = (path: string) => {
      const wf = loadWorkflow(path);
      return [wf.hands_off_to[0].workflow, wf.steps[0].gates[0].text].map((ref) => findWorkflow(root, ref));
    };
    expect(targets(there)).toEqual(targets(here));
    expect(loadWorkflow(targets(there)[0]).name).toBe("intended-target");
  });

  // The warning says what fuse-flow validate says: the file name finds this
  // workflow only for a .yml file that a lookup by that name reaches.
  test("a name that differs from the file name gives the reference fuse-flow takes", async () => {
    const text = (name: string) => `version: 1\nname: ${name}\nsteps:\n  - id: only\n    instruction: Do it.\n`;
    const yaml = write(join(WORKFLOWS(), "yaml-file.yaml"), text("old-name"));
    const one = write(join(WORKFLOWS(), "one", "same.yml"), text("old-name"));
    write(join(WORKFLOWS(), "two", "same.yml"), text("same"));
    const shadowed = write(join(home, ".konductor", "workflows", "shadow.yml"), text("mine"));
    write(join(WORKFLOWS(), "shadow.yml"), text("shadow"));
    const fresh = join(WORKFLOWS(), "fresh.yml");
    for (const [path, why] of [
      [yaml, "only .yml files are found by name"],
      [one, `workflow name "same" is ambiguous`],
      [shadowed, `the name shadow finds ${join(WORKFLOWS(), "shadow.yml")}`],
    ]) {
      const t = readFileSync(path, "utf8");
      const name = (Bun.YAML.parse(t) as any).name;
      expect(validateCli(path).out).toContain(`start this workflow by its path, ${path}; ${why}`);
      const out = await validate(path, t);
      expect(out.warnings).toEqual([expect.stringContaining(`name "${name}" differs from the file name; start this workflow by its path, ${path}; ${why}`)]);
    }
    expect((await validate(fresh, text("other"))).warnings).toEqual(['name "other" differs from the file name; fuse-flow finds a workflow by its file name, fresh']);
  });

  // Each line of the answer comes with the places in the file it is about, so
  // the app need not read them from the engine's wording: a gate's own guide,
  // each agent gate a policy guide applies to, a workflow gate, a hand-off by
  // its index, and the name.
  test("each line comes with the places it is about", async () => {
    write(
      join(WORKFLOWS(), "child.yml"),
      "version: 1\nname: child\ninputs:\n  - artifact: request\n    required: true\nsteps:\n  - id: work\n    instruction: Do it.\n",
    );
    write(join(home, ".konductor", "policy-overrides.yml"), "review:\n  guide: gone.md\n");
    const text = `version: 1
name: elsewhere
hands_off_to: [child, missing-one, child]
steps:
  - id: draft
    instruction: Write it.
    gates:
      - agent: check it
      - agent: review it
        guide: nope.md
  - id: ask
    instruction: Ask.
    gates:
      - owner-action: approve
      - workflow: child
  - id: last
    instruction: Done.
    gates:
      - agent: look again
`;
    const path = write(join(WORKFLOWS(), "placed.yml"), text);
    const out = await validate(path, text);
    const policy = join(home, ".konductor", "policy-overrides.yml");
    const gone = `${policy} sets review.guide to gone.md, and ${join(home, ".konductor", "gone.md")} does not exist`;
    const own = `the review guide of agent(review it) does not exist: ${join(WORKFLOWS(), "nope.md")}`;
    const handOff = (ref: string) => `hands_off_to ${ref}: `;
    const gate = `step ask, workflow child: `;
    const needs = `child requires the input "request", and the gate's inputs do not give it`;
    const noInput = "it declares no input this workflow produces, so --after gives it nothing";
    // The lines are the ones they were; the places come next to them.
    expect(out.errors).toEqual([gone, `${path}: steps.0 (draft): ${own}`, expect.stringContaining(handOff("missing-one")), `${gate}${needs}`]);
    expect(out.problems).toEqual([
      { severity: "error", line: gone, detail: gone, at: [{ step: 0, gate: 0 }, { step: 2, gate: 0 }] },
      { severity: "error", line: out.errors[1], detail: own, at: [{ step: 0, gate: 1, field: "guide" }] },
      { severity: "error", line: out.errors[2], detail: out.errors[2].slice(handOff("missing-one").length), at: [{ handOff: 1 }] },
      { severity: "error", line: out.errors[3], detail: needs, at: [{ step: 1, gate: 1, field: "workflow" }] },
      // Two hand-offs to one workflow give the same line once each, in order.
      { severity: "warning", line: `${handOff("child")}${noInput}`, detail: noInput, at: [{ handOff: 0 }] },
      { severity: "warning", line: `${handOff("child")}${noInput}`, detail: noInput, at: [{ handOff: 2 }] },
      { severity: "warning", line: out.warnings[2], detail: out.warnings[2], at: [{ field: "name" }] },
    ]);
    expect(out.warnings).toEqual([`${handOff("child")}${noInput}`, `${handOff("child")}${noInput}`, expect.stringContaining('name "elsewhere" differs')]);
  });

  test("text that does not parse gets no answer, and a path outside the workflow locations is refused", async () => {
    const path = join(WORKFLOWS(), "broken.yml");
    expect(await validate(path, "version: 1\nsteps: []\n")).toEqual({ errors: [], warnings: [], problems: [] });
    const outside = await api("/api/validate", { method: "POST", body: JSON.stringify({ path: join(root, "x.yml"), text: "" }) });
    expect(outside.status).toBe(403);
  });
});
