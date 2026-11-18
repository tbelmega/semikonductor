// SPDX-License-Identifier: Apache-2.0
// A step's `guides:`: the guides it names, from the libraries or next to the
// workflow file, printed in its step block with which wins where they and the
// instruction disagree, and checked by `fuse-flow validate`.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

const SHIPPED_REVIEW = realpathSync(join(FLOW_DIR, "library", "artifacts", "design", "review.md"));

const withGuides = (...guides: string[]) => `version: 1
name: w
steps:
  - id: write
    instruction: Write it, and check it against the guides.
    guides:
${guides.map((g) => `      - ${JSON.stringify(g)}`).join("\n")}
`;

const AUTHOR_INSTRUCTION_WINS =
  "GUIDES: where the step instruction above and a guide disagree, follow the instruction, and name each " +
  "disagreement in your hand-over block.";

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

test("a step names a shipped library guide: its block prints the guide's absolute path, and the instruction wins", () => {
  const out = repo.start("feat", withGuides("design/review.md"));
  expect(out).toContain(`STEP GUIDES: the instruction above says when to use each of these.\n  ${SHIPPED_REVIEW}\n`);
  expect(out).toContain(AUTHOR_INSTRUCTION_WINS);
});

test("a project library guide replaces the shipped one, and is a house rule over the instruction", () => {
  repo.write(".konductor/library/artifacts/design/review.md", "# our review\n");
  const out = repo.start("feat", withGuides("design/review.md"));
  const own = join(repo.root, ".konductor/library/artifacts/design/review.md");
  expect(out).toContain(`STEP GUIDES: the instruction above says when to use each of these.\n  ${own}\n`);
  expect(out).not.toContain(SHIPPED_REVIEW);
  expect(out).toContain(
    "GUIDES: The guide .konductor/library/artifacts/design/review.md comes from this project's or the owner's own " +
      "library or policy, so it is a house rule: where the step instruction disagrees with it, follow the owner's " +
      "ruling, else the guide when it clearly applies, and ask the owner when it is unclear.",
  );
  expect(out).not.toContain(AUTHOR_INSTRUCTION_WINS);
});

test("a path guide is relative to the workflow file or absolute, and resolves to where a symlink points", () => {
  const local = repo.write("flows/local.md", "# local\n");
  const shared = repo.write("shared/local.md", "# shared\n");
  const elsewhere = repo.write("elsewhere/abs.md", "# absolute\n");
  const target = repo.write("targets/real.md", "# real\n");
  symlinkSync(target, join(repo.root, "flows/linked.md"));
  const wf = repo.write("flows/w.yml", withGuides("./local.md", "../shared/local.md", elsewhere, "./linked.md"));
  const out = repo.ok("start", "feat", "--workflow", wf);
  expect(out).toContain(
    `STEP GUIDES: the instruction above says when to use each of these.\n  ${local}\n  ${shared}\n  ${elsewhere}\n  ${target}\n`,
  );
  // A guide that ships with the workflow is read together with the instruction, which wins.
  expect(out).toContain(AUTHOR_INSTRUCTION_WINS);
});

test("validate fails on a step guide that resolves to no file, naming the step and the reference", () => {
  mkdirSync(join(repo.root, "flows/folder.md"), { recursive: true });
  repo.write("flows/w.yml", withGuides("./missing.md", "design/no-such-guide.md", "no-such-entry/guide.md", "./folder.md"));
  const out = repo.refused("validate", "flows/w.yml");
  expect(out).toContain("1 of 1 workflows are invalid");
  expect(out).toContain(`invalid: ${join(repo.root, "flows/w.yml")} names a step guide that cannot be found:`);
  const at = `${join(repo.root, "flows/w.yml")}: steps.0 (write): the guide`;
  expect(out).toContain(`${at} ./missing.md does not exist: ${join(repo.root, "flows/missing.md")}`);
  expect(out).toContain(`${at} design/no-such-guide.md does not exist: ${join(realpathSync(join(FLOW_DIR, "library", "artifacts", "design")), "no-such-guide.md")}`);
  expect(out).toContain(`${at} no-such-entry/guide.md names no-such-entry, which no library has`);
  expect(out).toContain(`${at} ./folder.md is a folder, not a file: ${join(repo.root, "flows/folder.md")}`);
});

test("validate accepts step guides that resolve", () => {
  repo.write("flows/local.md", "# local\n");
  const out = repo.ok("validate", repo.write("flows/w.yml", withGuides("design/review.md", "./local.md")));
  expect(out).toContain("1 workflow valid");
});

test("validate rejects a library reference that is not <id>/<file>.md", () => {
  for (const ref of ["design", "design/sub/review.md", "design/review.txt", "Design/review.md"]) {
    const file = repo.write("flows/w.yml", withGuides(ref));
    const out = repo.refused("validate", file);
    expect(out).toContain(`invalid: ${file} is not a valid workflow`);
    expect(out).toContain("steps.0.guides.0: must be a path that starts with . or /, or a library guide <id>/<file>.md");
  }
});
