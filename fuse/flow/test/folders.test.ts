// SPDX-License-Identifier: Apache-2.0
// Folder artifacts in the step block and the hand-over block: how a produced
// folder that existed before the step is handed out, what naming the folder
// itself with --updated means, what the PRODUCED line counts, and what an
// earlier pass wrote.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

describe("a produced folder that existed before the step", () => {
  const RESEARCH = `version: 1
name: research
steps:
  - id: explore
    instruction: Explore.
    produces:
      - artifact: notes
        path: research/
`;

  test("on the first pass, the step block says to write new files in it and name each, not to replace it", () => {
    repo.write("research/someone-elses.md");
    const out = repo.start("r", RESEARCH);
    expect(out).toContain(
      "PRODUCE research/ (notes). research/ already existed when the step was handed out, and may hold other work. " +
        "Write the step's files in it, and name each file you write in it with --updated <file>.",
    );
    expect(out).not.toContain("update it, replace it, or use a different path");
  });

  test("inside another declared path, the hint names the artifact, as --updated <artifact>=<file>", () => {
    repo.write("research/someone-elses.md");
    const out = repo.start("r", `${RESEARCH}    updates:\n      - artifact: code\n        path: .\n`);
    expect(out).toContain("name each file you write in it with --updated notes=<file>.");
    expect(out).toContain("FILES IN TWO ARTIFACTS: research/ (notes) lies inside . (code).");
  });

  test("an optional produced folder gets the same hint", () => {
    repo.write("research/someone-elses.md");
    const out = repo.start("r", `${RESEARCH.replace("    produces:", "    optional_produces:")}    updates:\n      - artifact: code\n        path: .\n`);
    expect(out).toContain("PRODUCE (optional) research/ (notes). research/ existed before the step; name each file you write in it with --updated notes=<file>.");
  });

  test("naming the shared folder itself with --updated is refused, since it does not say which files are the step's", () => {
    repo.write("research/someone-elses.md");
    repo.start("r", RESEARCH);
    repo.write("research/mine.md");
    expect(repo.refused("continue", "r", "--updated", "research/")).toContain(
      "--updated research/: research/ is the folder of notes itself, which existed before the step and may hold other work; " +
        "name each file the step wrote in it",
    );
    expect(repo.ok("continue", "r", "--updated", "research/mine.md")).toContain("workflow complete");
  });

  test("naming a declared folder the step created stands for the whole folder, as when it is found on disk", () => {
    repo.write("src/a.ts");
    repo.start("r", `${RESEARCH}    updates:\n      - artifact: code\n        path: src/\n    gates:\n      - owner-action: approve it\n`);
    repo.write("research/mine.md");
    const out = repo.ok("continue", "r", "--updated", "research/", "--updated", "src/");
    expect(out).toContain("PRODUCED: research/ (new); src/ (updated)\n");
    expect(repo.state("r").steps.explore.artifacts.map((a: { path: string }) => a.path)).toEqual(["research/", "src/"]);
  });
});

test("the PRODUCED line counts files, not a folder recorded whole", () => {
  repo.write("src/a.ts");
  repo.start(
    "f",
    `version: 1
name: f
steps:
  - id: build
    instruction: Build it and keep notes.
    produces:
      - artifact: notes
        path: notes/
    updates:
      - artifact: code
        path: src/
    gates:
      - owner-action: approve the change
`,
  );
  repo.write("notes/one.md");
  const files = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
  for (const f of files) repo.write(f);
  const out = repo.ok("continue", "f", ...files.flatMap((f) => ["--updated", f]));
  expect(out).toContain("PRODUCED: notes/ (new); src/a.ts (updated); src/b.ts (updated); src/c.ts (updated); src/d.ts (updated)\n");
});

test("EARLIER PASS does not list an updates folder itself, only the files named in it", () => {
  repo.write("src/a.ts");
  repo.start(
    "f",
    `version: 1
name: f
steps:
  - id: build
    instruction: Build it.
    updates:
      - artifact: code
        path: src/
    gates:
      - owner-action: approve the change
`,
  );
  repo.ok("continue", "f", "--unchanged", "code", "nothing to change");
  const back = repo.ok("continue", "f", "--back-to", "build", "--note", "change it after all");
  expect(back).toContain("STEP build (1 of 1)");
  expect(back).not.toContain("EARLIER PASS");

  repo.ok("continue", "f", "--updated", "src/a.ts");
  const again = repo.ok("continue", "f", "--back-to", "build");
  expect(again).toContain("EARLIER PASS: this step ran before the owner sent the work back, and wrote src/a.ts. Check each");
});

test("a shared folder another artifact recorded still needs the files of a later producer that writes in it", () => {
  repo.write("reports/unrelated.md");
  repo.start(
    "s",
    `version: 1
name: shared
steps:
  - id: index
    instruction: Update the index.
    updates: { artifact: index, path: reports/ }
  - id: write
    instruction: Write a new report.
    produces: { artifact: report, path: reports/ }
  - id: read
    instruction: Read the report.
    consumes: [report]
`,
  );
  repo.write("reports/index.md");
  const handed = repo.ok("continue", "s", "--updated", "reports/index.md");
  expect(handed).toContain("PRODUCE reports/ (report). reports/ already existed when the step was handed out, and may hold other work.");
  // Nothing written for the report: the folder alone does not count as it.
  expect(repo.refused("continue", "s")).toContain("reports/ (report) existed before the step: name each file the step wrote in it with");
  expect(repo.status("s", "write")).toBe("IN_PROGRESS");
  repo.write("reports/new.md");
  expect(repo.ok("continue", "s", "--updated", "reports/new.md")).toContain("READ reports/new.md (from step write).");
});

test("a folder an earlier fuse-flow recorded as existing, by its path as declared, keeps its protection", () => {
  // Before declared paths were normalized, the state file kept them as the
  // workflow wrote them: ./reports/ or docs/../reports/.
  for (const [slug, declared] of [["dot", "./reports/"], ["parent", "docs/../reports/"]]) {
    repo.write("reports/unrelated.md");
    repo.start(slug, `version: 1\nname: w\nsteps:\n  - id: write\n    instruction: Write the report.\n    produces:\n      - artifact: report\n        path: ${declared}\n`);
    const old = repo.state(slug);
    old.steps.write.existed = [declared];
    repo.write(`.konductor/workstreams/${slug}.yml`, JSON.stringify(old));

    expect(repo.refused("continue", slug)).toContain("reports/ (report) existed before the step: name each file the step wrote in it");
    repo.ok("start", slug);
    expect(repo.state(slug).steps.write.existed).toEqual(["reports/"]);
  }
});
