// SPDX-License-Identifier: Apache-2.0
// End-to-end tests of Komposer's server: each test starts the real server on a
// throwaway project, produces state with the real fuse-flow command line where
// it needs some, and checks the API's answers. Nothing of our own is mocked.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { workflowDirs } from "../../../flow/src/project.ts";
import { resolveWorkflowRef } from "../../src/model/workflowLinks.ts";
import { type KomposerServer, startServer } from "../app.ts";

const CLI = resolve(import.meta.dir, "..", "..", "..", "flow", "src", "cli.ts");
const PACKAGE_WORKFLOWS = realpathSync(resolve(import.meta.dir, "..", "..", "..", "flow", "workflows"));
const TOKEN = "test-token";

const TWO_STEPS = `version: 1
name: two steps
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
    const shipped = workflows.find((w: any) => w.location === "fuse-flow" && w.file === "superpowers.yml");
    expect(shipped).toMatchObject({ dir: "examples/superpowers" });
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
    flow("continue", "g");
    flow("continue", "g", "--skip", "the owner wants no more");
    const run = (await json("/api/workstreams")).workstreams[0];
    const byStep = (step: string) =>
      run.events.filter((e: any) => e.step === step).map((e: any) => [e.kind, e.to, e.actor, e.detail]);
    expect(byStep("intro")).toEqual([["skipped", "SKIPPED", "owner", "started at review"]]);
    expect(byStep("review")).toEqual([
      ["handed-out", "IN_PROGRESS", "agent", ""],
      ["blocked", "BLOCKED", "agent", "round cap reached"],
      ["rounds-granted", "IN_PROGRESS", "owner", "granted 1 more review round"],
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
      expect(unavailable).toEqual([{ location: "run", project: other, kind: "file", path: file, reason: expect.stringContaining("EACCES") }]);
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
      expect(unavailable).toEqual([{ location: "run", project: other, kind: "folder", path: folder, reason: expect.stringContaining("EACCES") }]);
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
});

describe("example runs", () => {
  const EXAMPLES = realpathSync(resolve(import.meta.dir, "..", "..", "example-runs"));
  const example = (size: string) => join(PACKAGE_WORKFLOWS, "examples", `custom-example-${size}.yml`);

  beforeEach(() => {
    server.stop();
    server = startServer({ root, port: 0, token: TOKEN, examplesDir: EXAMPLES });
  });

  test("the runs that ship with Komposer are listed after this project's, on the custom-example workflows", async () => {
    write(join(root, ".konductor", "workflows", "one.yml"), "version: 1\nname: one\nsteps:\n  - id: only\n    instruction: Do it.\n");
    flow("start", "mine", "--workflow", "one");
    const { workstreams } = await json("/api/workstreams");
    expect(workstreams.map((w: any) => [w.project, w.slug, w.workflowPath, w.summary.status, w.summary.currentStep])).toEqual([
      [root, "mine", join(root, ".konductor", "workflows", "one.yml"), "IN_PROGRESS", "only"],
      [EXAMPLES, "export-to-pdf", example("medium"), "COMPLETED", undefined],
      [EXAMPLES, "fix-csv-quoting", example("small"), "COMPLETED", undefined],
      [EXAMPLES, "retry-on-timeout", example("small"), "AWAITING_OWNER", "final-summary"],
      [EXAMPLES, "saved-filters", example("medium"), "IN_PROGRESS", "implementation"],
      [EXAMPLES, "team-workspaces", example("large"), "BLOCKED", "security-testing"],
    ]);
  });

  // The example files are written by hand, not by fuse-flow, so this holds
  // them to what fuse-flow would have written.
  test("each example run is one fuse-flow could have written", async () => {
    const runs = (await json("/api/workstreams")).workstreams.filter((w: any) => w.project === EXAMPLES);
    expect(runs).toHaveLength(5);
    for (const run of runs) {
      const order = (Bun.YAML.parse(readFileSync(run.workflowPath, "utf8")) as any).steps.map((s: any) => s.id);
      const recorded = Object.keys(run.steps);
      // The steps recorded are the workflow's first steps, in its order.
      expect(recorded).toEqual(order.slice(0, recorded.length));
      const current = run.summary.currentStep ? order.indexOf(run.summary.currentStep) : order.length;
      for (const [i, id] of order.entries()) {
        const status = run.summary.steps[id].status;
        if (i < current) expect([run.slug, id, ["COMPLETED", "SKIPPED"].includes(status)]).toEqual([run.slug, id, true]);
        if (i > current) expect([run.slug, id, status]).toEqual([run.slug, id, "PENDING"]);
        // A step's state is the one its history replays to.
        const events = run.events.filter((e: any) => e.step === id);
        if (events.length) expect([run.slug, id, events[events.length - 1].to]).toEqual([run.slug, id, status]);
      }
      // Every history line is one fuse-flow writes, with a time.
      for (const e of run.events) expect([run.slug, e.step, e.kind === "other" || !e.time]).toEqual([run.slug, e.step, false]);
      // Times only move forward.
      const times = run.events.map((e: any) => e.time);
      expect(times).toEqual([...times].sort());
    }
  });

  test("the example runs are listed last, marked, cannot be removed and are never registered", async () => {
    const listed = (await json("/api/projects")).projects;
    expect(listed.at(-1)).toEqual({ path: EXAMPLES, name: "example-runs", current: false, workflowsDir: join(EXAMPLES, ".konductor", "workflows"), example: true, runs: 5 });

    // A scan of a folder that holds them does not add them.
    const scanned = await json("/api/projects", { method: "POST", body: JSON.stringify({ path: dirname(EXAMPLES) }) });
    expect(scanned).toEqual({ found: [], added: [] });
    expect(existsSync(join(home, ".konductor", "projects.yml"))).toBe(false);

    const remove = await api("/api/projects", { method: "DELETE", body: JSON.stringify({ path: EXAMPLES }) });
    expect(remove.status).toBe(400);
  });

  test("a broken projects file still leaves the example runs", async () => {
    write(join(home, ".konductor", "projects.yml"), "projects: {not: a list}\n");
    const body = await json("/api/projects");
    expect(body.projects.map((p: any) => p.path)).toEqual([root, EXAMPLES]);
    expect(body.error).toContain("must hold a list of project paths");
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
