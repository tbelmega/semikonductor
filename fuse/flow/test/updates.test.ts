// SPDX-License-Identifier: Apache-2.0
// Updates: a step that changes existing artifacts, such as code, accounts for
// each of them on continue, and the hand-over block lists what
// it changed.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

const CHANGE = `version: 1
name: change
steps:
  - id: change
    instruction: Make the change.
    updates:
      - artifact: patch
        path: src/
      - artifact: changelog
        path: CHANGELOG.md
    gates:
      - owner-action: approve the change
`;

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write("src/a.ts");
  repo.write("CHANGELOG.md");
});
afterEach(() => repo.cleanup());

test("continue is refused until every updates artifact is reported as updated or unchanged", () => {
  const block = repo.start("feat", CHANGE);
  expect(block).toContain("UPDATE src/ (patch).\nUPDATE CHANGELOG.md (changelog).\n");
  expect(block).toContain(
    '--unchanged <artifact> "<reason>" for each of patch, changelog that you left as it was. The step then waits for the owner to approve the change.',
  );

  expect(repo.refused("continue", "feat")).toContain(
    "REFUSED: not accounted for: patch (src/), changelog (CHANGELOG.md). Report each file you revised with --updated <file>",
  );
  expect(repo.refused("continue", "feat", "--updated", "src/a.ts")).toContain("REFUSED: not accounted for: changelog (CHANGELOG.md).");
  expect(repo.refused("continue", "feat", "--unchanged", "readme", "x")).toContain(
    '--unchanged names an artifact the step updates, by its id or its path; "readme" is neither (patch (src/), changelog (CHANGELOG.md))',
  );

  const out = repo.ok("continue", "feat", "--updated", "src/a.ts", "--updated", "docs/extra.md", "--unchanged", "changelog", "nothing user-facing");
  expect(out).toContain(
    "PRODUCED: src/a.ts (updated); docs/extra.md (updated, outside the declared paths); changelog unchanged (nothing user-facing)\n",
  );
  const state = repo.state("feat").steps.change;
  expect(state.files.filter((f: { kind: string }) => f.kind === "file")).toEqual([
    { artifact: "patch", path: "src/a.ts", kind: "file", pass: "this", status: "draft" },
    { path: "docs/extra.md", kind: "file", pass: "this", status: "draft" },
  ]);
  expect(state.unchanged).toEqual({ changelog: "nothing user-facing" });
});

test("a declared path with parent segments stands for the path it leads to", () => {
  const W = "version: 1\nname: w\nsteps:\n  - id: build\n    instruction: x\n    updates:\n      - artifact: code\n        path: docs/../src/\n";
  expect(repo.start("feat", W)).toContain("UPDATE src/ (code).");
  repo.ok("continue", "feat", "--updated", "src/a.ts");
  expect(repo.state("feat").steps.build.files).toContainEqual({ artifact: "code", path: "src/a.ts", kind: "file", pass: "this", status: "approved" });
  repo.start("other", W);
  repo.ok("continue", "other", "--updated", "code=docs/../src/a.ts");
  expect(repo.state("other").steps.build.files[0].path).toBe("src/a.ts");
});

test("an empty folder is not a produced folder artifact", () => {
  repo.start("feat", "version: 1\nname: w\nsteps:\n  - id: research\n    instruction: x\n    produces: { artifact: notes, path: research/ }\n");
  mkdirSync(join(repo.root, "research"));
  expect(repo.refused("continue", "feat")).toContain("REFUSED: missing artifact(s): research/ (notes), an empty folder.");
  repo.write("research/a.md");
  repo.ok("continue", "feat");
});

test("a missing updates path is reported when the step is handed out, not refused", () => {
  repo.cleanupPath("CHANGELOG.md");
  expect(repo.start("feat", CHANGE)).toContain("UPDATE CHANGELOG.md (changelog). CHANGELOG.md does not exist yet; create it and report it with --updated.");
  repo.write("CHANGELOG.md");
  expect(repo.ok("continue", "feat", "--updated", "CHANGELOG.md", "--unchanged", "patch", "docs only")).toContain("STATUS: awaiting owner action.");
});

test("--updated paths are relative to the current directory, and five or more files are summarized", () => {
  repo.start("feat", CHANGE);
  const files = ["a", "b", "c", "d", "e"].map((n) => `src/checkout/${n}.ts`);
  for (const f of files) repo.write(f);
  const r = repo.run(["continue", "feat", ...files.flatMap((f) => ["--updated", f.replace("src/", "")]), "--unchanged", "changelog", "x"], `${repo.root}/src`);
  expect(r.code).toBe(0);
  expect(r.out).toContain('PRODUCED: 5 files under src/checkout/; summarize them, for example "12 files under src/checkout/, with their tests"; changelog unchanged (x)');
  const named = repo.state("feat").steps.change.files.filter((f: { kind: string }) => f.kind === "file");
  expect(named.map((f: { artifact: string; path: string }) => [f.artifact, f.path])).toEqual(files.map((f) => ["patch", f]));
});

test("five files summarized with one outside the repository have no common folder, and the summary does not hang", () => {
  const outside = new Repo();
  try {
    const build = outside.write("build/output.txt");
    repo.start("feat", CHANGE);
    const files = ["a", "b", "c", "d"].map((n) => `src/${n}.ts`);
    for (const f of files) repo.write(f);
    // A hang would block the test itself, so the command runs with its own timeout.
    const args = ["continue", "feat", "--updated", build, ...files.flatMap((f) => ["--updated", f]), "--unchanged", "changelog", "x"];
    const proc = Bun.spawnSync([process.execPath, "run", join(FLOW_DIR, "src", "cli.ts"), ...args], {
      cwd: repo.root,
      env: repo.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 4_000,
    });
    const out = proc.stdout.toString() + proc.stderr.toString();
    expect(proc.signalCode ?? null).toBeNull();
    expect(proc.exitCode).toBe(0);
    expect(out).toContain('PRODUCED: 5 files; summarize them, for example "12 files under src/checkout/, with their tests"; changelog unchanged (x)');
  } finally {
    outside.cleanup();
  }
});

test("--updated, --unchanged and --not-produced report the agent's work, so no owner decision goes with them", () => {
  repo.start("feat", CHANGE);
  expect(repo.usage("continue", "feat", "--unchanged", "patch", "x", "--owner-approved")).toContain(
    "--unchanged reports the agent's work; it does not go with --owner-approved",
  );
  expect(repo.usage("continue", "feat", "--not-produced", "patch", "x", "--skip", "y")).toContain("--not-produced reports the agent's work");
});
test("with a single updates artifact, the step block names its id in the --unchanged hint", () => {
  const one = CHANGE.replace("      - artifact: changelog\n        path: CHANGELOG.md\n", "").replace("artifact: patch\n        path: src/", "artifact: code\n        path: .");
  expect(repo.start("feat", one)).toContain('and --unchanged code "<reason>" if you left code as it was.');
});


test("an updates artifact whose path is the repository root contains every file in it", () => {
  repo.start("feat", CHANGE.replace("path: src/", "path: ."));
  expect(repo.ok("continue", "feat", "--updated", "src/a.ts", "--unchanged", "changelog", "x")).toContain("PRODUCED: src/a.ts (updated);");
});

test("a file outside the repository is accepted but accounts for no artifact", () => {
  repo.start("feat", CHANGE.replace("path: src/", "path: ."));
  const outside = `${repo.root}-outside.txt`;
  expect(repo.refused("continue", "feat", "--updated", outside, "--unchanged", "changelog", "x")).toContain("REFUSED: not accounted for: patch (.)");
  const out = repo.ok("continue", "feat", "--updated", outside, "--updated", "src/a.ts", "--unchanged", "changelog", "x");
  expect(out).toContain(`PRODUCED: ${outside} (updated, outside the declared paths); src/a.ts (updated);`);
});

test("the workflow-complete hand-over gathers what every step produced and verified", () => {
  const flow = CHANGE.replace("      - owner-action: approve the change\n", "      - script: \"true\"\n") + "  - id: notes\n    instruction: Write notes.\n    produces:\n      - artifact: notes\n        path: notes.md\n";
  repo.start("feat", flow);
  repo.ok("continue", "feat", "--updated", "src/a.ts", "--unchanged", "changelog", "nothing user-facing");
  const out = repo.ok("continue", "feat", "--not-produced", "notes", "no notes needed");
  expect(out).toContain("PRODUCED: change: src/a.ts (updated); changelog unchanged (nothing user-facing); notes: notes not produced (no notes needed)\n");
  expect(out).toContain("VERIFICATION: change: script `true`: passed\n");
});

test("--unchanged and --not-produced also name an artifact by its path, as the step block shows it", () => {
  const flow =
    CHANGE.replace("path: src/", "path: .").replace("      - owner-action: approve the change\n", "      - script: \"true\"\n") +
    "  - id: notes\n    instruction: Write notes.\n    produces:\n      - artifact: notes\n        path: docs/notes.md\n";
  repo.start("feat", flow);
  // "." is the repository root, given from a subdirectory as "..".
  const r = repo.run(["continue", "feat", "--unchanged", "..", "no code change", "--unchanged", "../CHANGELOG.md", "nothing user-facing"], `${repo.root}/src`);
  expect(r.out).toContain("change: COMPLETED\n");
  expect(repo.state("feat").steps.change.unchanged).toEqual({ patch: "no code change", changelog: "nothing user-facing" });

  expect(repo.refused("continue", "feat", "--not-produced", "notes.md", "x")).toContain(
    '--not-produced names an artifact the step produces, by its id or its path; "notes.md" is neither (notes (docs/notes.md))',
  );
  expect(repo.ok("continue", "feat", "--not-produced", "./docs/notes.md", "no notes needed")).toContain("notes not produced (no notes needed)");
});

test("a path that two artifacts share is refused, and the artifact must be named by its id", () => {
  repo.start("feat", CHANGE.replace("path: CHANGELOG.md", "path: src/"));
  expect(repo.refused("continue", "feat", "--unchanged", "src", "x")).toContain('--unchanged "src" is the path of patch and changelog; name the artifact by its id');
  expect(repo.ok("continue", "feat", "--unchanged", "patch", "x", "--unchanged", "changelog", "y")).toContain("STATUS: awaiting owner action.");
});

// A folder the step creates, which it both writes notes in and updates as the
// index, behind a review the owner can accept or grant more rounds for.
const REVIEWED_NOTES = `version: 1
name: notes
steps:
  - id: notes
    instruction: Write the notes and update the index in them.
    produces:
      - artifact: notes
        path: notes/
    updates:
      - artifact: index
        path: notes/
    gates:
      - agent: review the notes
      - owner-action: approve the notes
`;

test("a produced folder that an updates artifact shares is recorded file by file after a block, as without one", () => {
  repo.start("feat", REVIEWED_NOTES);
  repo.write("notes/a.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "notes=notes/a.md", "--updated", "index=notes/a.md");
  repo.ok("continue", "feat", "--owner-approved", "--gate", "1");
  repo.write("notes/b.md");
  repo.ok("continue", "feat", "--updated", "notes=notes/b.md", "--updated", "index=notes/b.md");
  expect(repo.state("feat").steps.notes.artifacts).toEqual([
    { artifact: "notes", path: "notes/b.md", status: "draft" },
    { artifact: "notes", path: "notes/a.md", status: "draft" },
    { artifact: "index", path: "notes/", status: "draft" },
  ]);
});

// The produced folder is recorded whole by the first block, so a file named
// on a later block does not get a record of its own; it must still account
// for the updates artifact that shares the folder.
const blockWholeThenName = () => {
  repo.start("feat", REVIEWED_NOTES);
  repo.write("notes/a.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
  repo.ok("continue", "feat", "--more-rounds", "1");
  repo.write("notes/b.md");
  repo.ok("continue", "feat", "--blocked", "the review still does not converge", "--gate", "1", "--updated", "notes=notes/b.md", "--updated", "index=notes/b.md");
};
const wholeNotesRecords = [
  { artifact: "notes", path: "notes/", status: "draft" },
  { artifact: "index", path: "notes/", status: "draft" },
];

test("a file named on a block inside a folder recorded whole accounts for the updates artifact when the agent finishes after the owner accepts the review", () => {
  blockWholeThenName();
  expect(repo.state("feat").steps.notes.artifacts).toEqual(wholeNotesRecords);
  repo.ok("continue", "feat", "--owner-approved", "--gate", "1");
  const done = repo.ok("continue", "feat");
  expect(done).toContain("STATUS: awaiting owner action.");
  expect(done).toContain("PRODUCED: notes/ (new)\n");
  expect(repo.state("feat").steps.notes.artifacts).toEqual(wholeNotesRecords);
});

test("a file named on a block inside a folder recorded whole keeps the updates record when the step is blocked again", () => {
  blockWholeThenName();
  repo.ok("continue", "feat", "--more-rounds", "1");
  repo.ok("continue", "feat", "--blocked", "the review does not converge yet", "--gate", "1");
  expect(repo.state("feat").steps.notes.artifacts).toEqual(wholeNotesRecords);
});

// A document the step produces inside the code it updates, as in
// custom-example-small: the document lies in both paths, so naming it for both
// accounts for the code too.
const REPORT = `version: 1
name: build
steps:
  - id: build
    instruction: Make the change and write the report.
    produces:
      - artifact: report
        path: docs/report.md
    updates:
      - artifact: code
        path: .
    gates:
      - agent: review the change
      - owner-action: approve the change
`;

const reportRecords = (status: string) => [
  { artifact: "report", path: "docs/report.md", status },
  { artifact: "code", path: ".", status },
];

test("a document named on a block for the report and the code accounts for the code when the agent finishes after the owner accepts the review", () => {
  repo.start("feat", REPORT);
  repo.write("docs/report.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "report=docs/report.md", "--updated", "code=docs/report.md");
  expect(repo.state("feat").steps.build.artifacts).toEqual(reportRecords("draft"));
  repo.ok("continue", "feat", "--owner-approved", "--gate", "1");
  const done = repo.ok("continue", "feat");
  expect(done).toContain("STATUS: awaiting owner action.");
  expect(done).toContain("PRODUCED: docs/report.md (new)\n");
  expect(repo.state("feat").steps.build.artifacts).toEqual(reportRecords("draft"));
});

test("a document named on a block for the report and the code keeps the code record when the step is blocked again after more rounds", () => {
  repo.start("feat", REPORT);
  repo.write("docs/report.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "report=docs/report.md", "--updated", "code=docs/report.md");
  repo.ok("continue", "feat", "--more-rounds", "1");
  repo.ok("continue", "feat", "--blocked", "the review still does not converge", "--gate", "1");
  expect(repo.state("feat").steps.build.artifacts).toEqual(reportRecords("draft"));
});

// A folder that existed before the step, which the step both writes notes in
// and updates as the index, and a step that reads the notes.
const SHARED_NOTES = `version: 1
name: notes
steps:
  - id: notes
    instruction: Write the notes and update the index in them.
    produces:
      - artifact: notes
        path: notes/
    updates:
      - artifact: index
        path: notes/
    gates:
      - owner-action: approve the notes
  - id: read
    instruction: Read the notes.
    consumes: [notes]
`;

test("a folder that existed before the step and is both produced and updated keeps its file records across a send-back", () => {
  repo.write("notes/old.md");
  repo.start("feat", SHARED_NOTES);
  repo.write("notes/a.md");
  repo.ok("continue", "feat", "--updated", "notes=notes/a.md", "--updated", "index=notes/a.md");
  const records = (status: string) => [
    { artifact: "notes", path: "notes/a.md", status },
    { artifact: "index", path: "notes/", status },
  ];
  expect(repo.state("feat").steps.notes.artifacts).toEqual(records("draft"));
  repo.ok("continue", "feat", "--back-to", "notes", "--note", "tighten the notes");
  repo.ok("start", "feat");
  repo.ok("continue", "feat", "--updated", "notes=notes/a.md", "--updated", "index=notes/a.md");
  expect(repo.state("feat").steps.notes.artifacts).toEqual(records("draft"));
  const next = repo.ok("continue", "feat", "--owner-approved");
  expect(next).toContain("READ notes/a.md (from step notes).");
});

test("a produced document named with --updated is listed once in the hand-over", () => {
  repo.start("feat", REPORT.replace("      - agent: review the change\n", ""));
  repo.write("docs/report.md");
  expect(repo.ok("continue", "feat", "--updated", "report=docs/report.md", "--updated", "code=docs/report.md")).toContain("PRODUCED: docs/report.md (new)\n");
});

test("after a send-back, the earlier record of the updated folder does not stand for files written in the produced folder", () => {
  repo.write("notes/old.md");
  repo.start("feat", SHARED_NOTES);
  repo.ok("continue", "feat", "--not-produced", "notes", "nothing new to note", "--unchanged", "index", "nothing to index");
  repo.ok("continue", "feat", "--back-to", "notes", "--note", "write the notes after all");
  repo.ok("start", "feat");
  expect(repo.refused("continue", "feat", "--unchanged", "index", "nothing to index")).toContain(
    "REFUSED: notes/ (notes) existed before the step: name each file the step wrote in it with --updated notes=<file>",
  );
});

// A folder the step creates, with an index file in it that the step updates.
const NOTES_WITH_INDEX = `version: 1
name: notes
steps:
  - id: notes
    instruction: Write the notes and update their index.
    produces:
      - artifact: notes
        path: notes/
    updates:
      - artifact: index
        path: notes/index.md
    gates:
      - agent: review the notes
      - owner-action: approve the notes
`;

test("reporting the produced folder not produced after a block keeps the evidence for the updates artifact inside it", () => {
  repo.start("feat", NOTES_WITH_INDEX);
  repo.write("notes/index.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "index=notes/index.md");
  repo.ok("continue", "feat", "--owner-approved", "--gate", "1");
  const done = repo.ok("continue", "feat", "--not-produced", "notes", "only the index changed");
  expect(done).toContain("STATUS: awaiting owner action.");
  expect(done).toContain("PRODUCED: notes/index.md (updated); notes not produced (only the index changed)\n");
  expect(repo.state("feat").steps.notes.artifacts).toEqual([{ artifact: "index", path: "notes/index.md", status: "draft" }]);
});

test("a file in the paths of two artifacts is refused until the agent names the artifact it counts for", () => {
  const block = repo.start("feat", NOTES_WITH_INDEX);
  expect(block).toContain(
    "FILES IN TWO ARTIFACTS: notes/index.md (index) lies inside notes/ (notes). Name a file there with --updated " +
      "<artifact>=<file>, once for each artifact it counts for.\n",
  );
  repo.write("notes/index.md");
  expect(repo.refused("continue", "feat", "--blocked", "x", "--gate", "1", "--updated", "notes/index.md")).toContain(
    "REFUSED: --updated notes/index.md: the file lies in the paths of notes and index, so name the artifact it counts for, " +
      "as in --updated notes=notes/index.md or --updated index=notes/index.md; repeat the flag for each artifact it counts for",
  );
  expect(repo.refused("continue", "feat", "--updated", "index=notes/a.md")).toContain(
    "REFUSED: --updated index=notes/a.md: notes/a.md is not inside notes/index.md, the path of index",
  );
  expect(repo.refused("continue", "feat", "--updated", "readme=notes/a.md")).toContain(
    "REFUSED: --updated readme=notes/a.md: the step has no artifact readme (notes (notes/), index (notes/index.md))",
  );
  expect(repo.status("feat", "notes")).toBe("IN_PROGRESS");
  // A file only one path holds needs no id.
  repo.write("notes/a.md");
  repo.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "notes/a.md");
  expect(repo.state("feat").steps.notes.artifacts).toEqual([{ artifact: "notes", path: "notes/a.md", status: "draft" }]);
});

test("a state file with the bare file lists of earlier fuse-flow versions is converted to entries once, and its files still count", () => {
  repo.start("feat", NOTES_WITH_INDEX);
  repo.write("notes/a.md");
  repo.write("notes/index.md");
  // As an earlier fuse-flow left it: a second pass, after a block whose
  // review the owner accepted, with the named index file in `updated`.
  const old = repo.state("feat");
  old.steps.notes = {
    status: "IN_PROGRESS",
    pass: 2,
    accepted_gates: [1],
    artifacts: [{ artifact: "notes", path: "notes/a.md", status: "draft" }],
    updated: ["notes/index.md"],
    earlier_pass: ["notes/a.md"],
    history: ["2026-10-16T10:00:00.000Z handed out"],
  };
  repo.write(".konductor/workstreams/feat.yml", JSON.stringify(old));

  expect(repo.ok("start", "feat")).toContain("EARLIER PASS: this step ran before the owner sent the work back, and wrote notes/a.md.");
  const converted = repo.state("feat").steps.notes;
  expect(converted.updated).toBeUndefined();
  expect(converted.earlier_pass).toBeUndefined();
  // The named file lies in the paths of both artifacts, so it counts for both, as before.
  expect(converted.files).toEqual([
    { artifact: "notes", path: "notes/a.md", kind: "file", pass: "earlier", status: "draft" },
    { artifact: "notes", path: "notes/index.md", kind: "file", pass: "this", status: "draft" },
    { artifact: "index", path: "notes/index.md", kind: "file", pass: "this", status: "draft" },
  ]);

  const done = repo.ok("continue", "feat", "--not-produced", "notes", "only the index changed");
  expect(done).toContain("PRODUCED: notes/index.md (updated); notes not produced (only the index changed)\n");
  expect(repo.state("feat").steps.notes.artifacts).toEqual([{ artifact: "index", path: "notes/index.md", status: "draft" }]);
});

test("an old state file's named document inside the code it updates still counts for the code after conversion", () => {
  repo.start("feat", REPORT);
  repo.write("docs/report.md");
  // As an earlier fuse-flow left a blocked step whose agent named the report:
  // records for both artifacts, and the named file in `updated`.
  const old = repo.state("feat");
  old.steps.build = {
    status: "IN_PROGRESS",
    accepted_gates: [1],
    artifacts: reportRecords("draft"),
    updated: ["docs/report.md"],
    history: ["2026-10-16T10:00:00.000Z handed out"],
  };
  repo.write(".konductor/workstreams/feat.yml", JSON.stringify(old));

  repo.ok("status", "feat");
  expect(repo.state("feat").steps.build.files).toContainEqual({
    artifact: "code",
    path: "docs/report.md",
    kind: "file",
    pass: "this",
    status: "draft",
  });
});

test("one continue cannot report an artifact as updated and as unchanged", () => {
  repo.start("feat", CHANGE);
  repo.write("src/a.ts", "changed\n");
  const out = repo.refused("continue", "feat", "--updated", "src/a.ts", "--unchanged", "patch", "no code changes", "--unchanged", "changelog", "no entry");
  expect(out).toContain("REFUSED: --unchanged patch contradicts --updated src/a.ts, which this command names for patch; report one or the other.");
  expect(repo.status("feat", "change")).toBe("IN_PROGRESS");
  repo.ok("continue", "feat", "--updated", "src/a.ts", "--unchanged", "changelog", "no entry");
});

test("an artifact reported updated earlier in the pass cannot be reported unchanged when the step finishes", () => {
  repo.start(
    "feat",
    "version: 1\nname: f\nsteps:\n  - id: build\n    instruction: Update code.\n    updates: { artifact: code, path: src/ }\n" +
      "    gates:\n      - agent: review code\n      - owner-action: approve code\n",
  );
  repo.write("src/a.ts", "changed\n");
  repo.ok("continue", "feat", "--blocked", "needs more rounds", "--gate", "1", "--updated", "src/a.ts");
  repo.ok("continue", "feat", "--more-rounds", "1");
  const out = repo.refused("continue", "feat", "--unchanged", "code", "no code changes");
  expect(out).toContain(
    "REFUSED: --unchanged code contradicts src/a.ts, which an earlier command in this pass of the step recorded as updated for code; " +
      "the step finishes with that update when you run continue without --unchanged code.",
  );
  expect(repo.status("feat", "build")).toBe("IN_PROGRESS");
  expect(repo.ok("continue", "feat")).toContain("PRODUCED: src/a.ts (updated)\n");
});
