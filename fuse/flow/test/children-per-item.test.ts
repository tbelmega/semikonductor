// SPDX-License-Identifier: Apache-2.0
// A workflow gate with `for_each`: a step that waits for one child workstream
// per file of a recorded folder. The folder's direct file names are the items;
// each child gets its own file, and the step completes once every child does.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write(
    ".konductor/workflows/unit.yml",
    `version: 1
name: unit
inputs:
  - artifact: unit-spec
    required: true
steps:
  - id: patch
    instruction: Patch the unit.
    consumes: [unit-spec]
    produces: { artifact: patch-report, path: "reports/{slug}.md" }
`,
  );
});
afterEach(() => repo.cleanup());

// A parent whose `approve` step records a folder of units, one file each, and
// whose `patch` step waits for one child per unit.
const parent = (gate: string, consolidate = "    consumes: [reports]\n") => `version: 1
name: parent
steps:
  - id: approve
    instruction: Write one file per approved unit.
    produces: { artifact: units, path: "units/" }
  - id: patch
    instruction: Merge the patches.
    gates:
${gate}
  - id: consolidate
    instruction: Consolidate.
${consolidate}`;

const FOR_EACH = `      - workflow: unit
        for_each: units
        inputs: { unit-spec: units }
        returns: { reports: patch-report }
`;

describe("validate", () => {
  test("for_each goes on a workflow gate, names an earlier artifact, and needs the slug template to contain {item}", () => {
    repo.write("ok.yml", parent(FOR_EACH));
    expect(repo.ok("validate", "ok.yml")).toContain("valid:");
    repo.write("ok-slug.yml", parent(FOR_EACH + '        slug: "{slug}-unit-{item}"\n'));
    expect(repo.ok("validate", "ok-slug.yml")).toContain("valid:");

    repo.write("no-item.yml", parent(FOR_EACH + '        slug: "{slug}-unit"\n'));
    expect(repo.refused("validate", "no-item.yml")).toContain("slug must contain {item} when the gate has for_each, so each child gets a slug of its own");
    repo.write("item-no-slug.yml", parent(FOR_EACH + '        slug: "unit-{item}"\n'));
    expect(repo.refused("validate", "item-no-slug.yml")).toContain("slug is a template that contains {slug}");
    repo.write("item-without.yml", parent('      - workflow: unit\n        inputs: { unit-spec: units }\n        slug: "{slug}-{item}"\n'));
    expect(repo.refused("validate", "item-without.yml")).toContain("{item} in slug needs for_each on the gate");
    repo.write("not-workflow.yml", parent("      - agent: review it\n        for_each: units\n"));
    expect(repo.refused("validate", "not-workflow.yml")).toContain("for_each goes on a workflow gate only");
    repo.write("bad-id.yml", parent(FOR_EACH.replace("for_each: units", "for_each: Units")));
    expect(repo.refused("validate", "bad-id.yml")).toContain("for_each names an artifact id, lowercase letters, digits and hyphens");
    repo.write("not-string.yml", parent(FOR_EACH.replace("for_each: units", "for_each: 3")));
    expect(repo.refused("validate", "not-string.yml")).toContain("for_each names an artifact id, lowercase letters, digits and hyphens; got 3");
    repo.write("as-condition.yml", parent(FOR_EACH).replace("    gates:\n", "    condition: { agent: anything, for_each: units }\n    gates:\n"));
    expect(repo.refused("validate", "as-condition.yml")).toContain("a condition has no for_each");
    repo.write("later.yml", parent(FOR_EACH.replace("for_each: units", "for_each: reports")));
    expect(repo.refused("validate", "later.yml")).toContain('"patch" waits for one child per item of "reports", which no step before it produces or updates');
    repo.write("unmapped.yml", parent("      - workflow: unit\n        for_each: units\n        returns: { reports: patch-report }\n"));
    expect(repo.refused("validate", "unmapped.yml")).toContain('"patch" gives "units" to no input of its children; map it in inputs, so each child gets its item\'s file');
  });

  test("an id a for_each gate returns is one document per item, which one input cannot take, until a later plain step writes it", () => {
    const after = (rest: string) => parent(FOR_EACH, rest);
    repo.write("as-input.yml", after("    gates:\n      - workflow: unit\n        inputs: { unit-spec: reports }\n"));
    expect(repo.refused("validate", "as-input.yml")).toContain('"consolidate" gives its child "reports", which step patch returns once per item; one input cannot take one document per item');
    repo.write("as-folder.yml", after("    gates:\n      - workflow: unit\n        for_each: reports\n        inputs: { unit-spec: reports }\n"));
    expect(repo.refused("validate", "as-folder.yml")).toContain('"consolidate" waits for one child per item of "reports", which step patch returns once per item; one input cannot take one document per item');
    // consumes is fine: the step block lists one READ per child.
    repo.write("consumes.yml", after("    consumes: [reports]\n"));
    expect(repo.ok("validate", "consumes.yml")).toContain("valid:");
    // A plain step between them makes the id ordinary again.
    const plain = `    produces: { artifact: reports, path: "reports.md" }\n  - id: last\n    instruction: Last.\n    gates:\n      - workflow: unit\n        inputs: { unit-spec: reports }\n`;
    repo.write("rewritten.yml", after(plain));
    expect(repo.ok("validate", "rewritten.yml")).toContain("valid:");
    // A plain workflow gate that returns the id makes it ordinary again too.
    const returned = `    gates:\n      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report }\n  - id: last\n    instruction: Last.\n    gates:\n      - workflow: unit\n        inputs: { unit-spec: reports }\n`;
    repo.write("returned.yml", after(returned));
    expect(repo.ok("validate", "returned.yml")).toContain("valid:");
  });
});

// Hands the step `patch` out with the folder recorded whole: a.json, b.json, c.json.
function handOut(files = ["a", "b", "c"]): string {
  repo.start("p", parent(FOR_EACH));
  for (const f of files) repo.write(`units/${f}.json`, `{"unit":"${f}"}\n`);
  return repo.ok("continue", "p");
}

const DELEGATE =
  "DELEGATE: this step waits for 3 child workstreams, one per item of units (units/), each following workflow unit: " +
  "p-patch-a (item a, given unit-spec), p-patch-b (item b, given unit-spec), p-patch-c (item c, given unit-spec). " +
  "First run each to its end: `fuse-flow start <slug>` prints its current step. They may run side by side, each in its own " +
  "subagent; the owner's decisions in each are made there. Then do this step's work.";

// Completes child `slug` of the fixture: its one step writes its report.
function finish(slug: string): string {
  repo.ok("start", slug);
  repo.write(`reports/${slug}.md`);
  return repo.ok("continue", slug);
}

describe("hand-out", () => {
  test("a folder recorded whole gives one child per direct file, each given its own file, recorded with its item", () => {
    const out = handOut();
    expect(out).toContain(DELEGATE);
    expect(repo.state("p").steps.patch.children).toEqual([
      { pass: 1, slug: "p-patch-a", item: "a", file: "units/a.json" },
      { pass: 1, slug: "p-patch-b", item: "b", file: "units/b.json" },
      { pass: 1, slug: "p-patch-c", item: "c", file: "units/c.json" },
    ]);
    const history = repo.state("p").steps.patch.history as string[];
    expect(history.some((h) => h.endsWith("recorded 3 child workstreams to create: p-patch-a (item a), p-patch-b (item b), p-patch-c (item c)"))).toBe(true);
    expect(history.filter((h) => h.includes("created child workstream"))).toHaveLength(3);
    const child = repo.state("p-patch-b");
    expect(child.parent).toEqual({ slug: "p", step: "patch", item: "b" });
    expect(child.inputs).toEqual({ "unit-spec": "units/b.json" });
    const started = repo.ok("start", "p-patch-b");
    expect(started).toContain("parent:   step patch of workstream p, which waits for this one\n");
    expect(started).toContain("READ units/b.json (input unit-spec).");
  });

  test("the slug template fills in {item}", () => {
    repo.start("p", parent(FOR_EACH + '        slug: "{slug}-unit-{item}"\n'));
    repo.write("units/a.json");
    expect(repo.ok("continue", "p")).toContain("p-unit-a (item a, given unit-spec)");
  });

  test("files the step named are the items; a nested file and a dotfile are not", () => {
    repo.start("p", parent(FOR_EACH));
    for (const f of ["units/a.json", "units/b.json", "units/sub/n.json", "units/.keep"]) repo.write(f);
    const out = repo.ok("continue", "p", "--updated", "units/a.json", "--updated", "units/b.json", "--updated", "units/sub/n.json", "--updated", "units/.keep");
    expect(out).toContain("this step waits for 2 child workstreams, one per item of units (units/), each following workflow unit: p-patch-a (item a, given unit-spec), p-patch-b (item b, given unit-spec).");
  });

  test("a single named file is one item, with its folder named", () => {
    repo.start("p", parent(FOR_EACH));
    repo.write("units/only.json");
    expect(repo.ok("continue", "p", "--updated", "units/only.json")).toContain(
      "this step waits for 1 child workstream, one per item of units (units/), each following workflow unit: p-patch-only (item only, given unit-spec).",
    );
  });

  test("in a folder recorded whole, a subfolder and a dotfile are not items", () => {
    repo.start("p", parent(FOR_EACH));
    for (const f of ["units/a.json", "units/sub/n.json", "units/.gitkeep"]) repo.write(f);
    expect(repo.ok("continue", "p")).toContain("this step waits for 1 child workstream, one per item of units (units/), each following workflow unit: p-patch-a (item a, given unit-spec).");
  });

  test("a file whose stem is not an id, and two files with one stem, are refused with the file names", () => {
    repo.start("p", parent(FOR_EACH));
    repo.write("units/Bad_Name.json");
    expect(repo.ok("continue", "p")).toContain(
      "STEP patch (2 of 3) waits for child workstreams that cannot be created: step patch cannot create its child workstreams: " +
        'units/Bad_Name.json: its name without the extension, "Bad_Name", is not an item id (lowercase letters, digits and hyphens); rename the file.',
    );
    expect(repo.state("p").steps.patch.children).toBeUndefined();
    repo.cleanupPath("units/Bad_Name.json");
    repo.write("units/a.json");
    repo.write("units/a.md");
    expect(repo.ok("start", "p")).toContain("cannot create its child workstreams: units/a.json and units/a.md give the same item a; one file per item.");
  });

  test("a folder given as an input: empty, a file, or unreadable, is refused as such", () => {
    const INPUT = `version: 1
name: q
inputs:
  - artifact: units
steps:
  - id: patch
    instruction: Merge the patches.
    gates:
${FOR_EACH}`;
    repo.write("empty/.gitkeep");
    const empty = repo.ok("start", "e", "--workflow", repo.write("q.yml", INPUT), "--input", "units=empty/");
    expect(empty).toContain("cannot create its child workstreams: empty holds no item: no file to make a child for.");
    repo.write("one.json");
    expect(repo.ok("start", "f", "--workflow", "q.yml", "--input", "units=one.json")).toContain("cannot create its child workstreams: one.json is a file, not a folder.");
    expect(repo.ok("start", "g", "--workflow", "q.yml", "--input", "units=nowhere/")).toContain("cannot create its child workstreams: nowhere cannot be read: ENOENT.");
    expect(repo.ok("start", "u", "--workflow", "q.yml")).toContain("cannot create its child workstreams: units was not recorded by an earlier step or given as an input.");
  });

  test("a folder the step did not produce is refused at hand-out, so the owner can skip the step", () => {
    repo.start("p", parent(FOR_EACH));
    const out = repo.ok("continue", "p", "--not-produced", "units", "every unit was deferred");
    expect(out).toContain("waits for child workstreams that cannot be created: step patch cannot create its child workstreams: units was not recorded by an earlier step or given as an input.");
    expect(out).toContain('If you cannot resolve this, report the step blocked: run `fuse-flow continue p --blocked "<the reason above>"`, so the owner decides.');
    expect(repo.refused("continue", "p")).toContain("the child workstreams this step waits for cannot be created: step patch cannot create its child workstreams: units was not recorded by an earlier step or given as an input.");
  });

  test("once recorded, the set stands: a file added later is not an item, and a deleted child is recreated the same", () => {
    handOut();
    repo.write("units/d.json");
    repo.cleanupPath(".konductor/workstreams/p-patch-b.yml");
    const again = repo.ok("start", "p");
    expect(again).toContain(DELEGATE);
    expect(again).not.toContain("p-patch-d");
    expect(repo.state("p").steps.patch.children).toHaveLength(3);
    expect(repo.state("p-patch-b").inputs).toEqual({ "unit-spec": "units/b.json" });
  });

  test("a set another command recorded first is adopted, not re-read", () => {
    repo.start("p", parent(FOR_EACH));
    repo.write("units/a.json");
    // Another command recorded the set between the two commands.
    const state = repo.read(".konductor/workstreams/p.yml");
    const entry = "  patch:\n    status: PENDING\n    artifacts: []\n    history: []\n";
    expect(state).toContain(entry);
    repo.write(".konductor/workstreams/p.yml", state.replace(entry, `${entry.slice(0, -1)}\n    children:\n      - { pass: 1, slug: p-patch-x, item: x, file: units/x.json }\n`));
    const out = repo.ok("continue", "p");
    expect(out).toContain("this step waits for 1 child workstream, one per item of units (units/), each following workflow unit: p-patch-x (item x, given unit-spec).");
    expect(repo.state("p").steps.patch.children).toEqual([{ pass: 1, slug: "p-patch-x", item: "x", file: "units/x.json" }]);
    expect(repo.state("p-patch-x").parent).toEqual({ slug: "p", step: "patch", item: "x" });
  });

  test("a gate edited between plain and for_each while the pass runs is refused with the send-back command", () => {
    handOut();
    repo.write("workflow-source.yml", parent("      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report }\n"));
    const plain = repo.ok("start", "p");
    expect(plain).toContain(
      "STEP patch (2 of 3) waits for a child workstream that cannot be used: step patch waits for one child workstream, but the children recorded " +
        "for this pass of the step (p-patch-a, p-patch-b, p-patch-c) were created for a gate with for_each. To give the step a new pass, the owner " +
        "sends the work back to it: `fuse-flow continue p --back-to patch`; or change the gate back.",
    );
    expect(repo.refused("continue", "p")).toContain("were created for a gate with for_each.");

    repo.start("r", parent("      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report }\n"));
    repo.ok("continue", "r", "--updated", "units/a.json");
    repo.write("workflow-source.yml", parent(FOR_EACH));
    expect(repo.ok("start", "r")).toContain(
      "STEP patch (2 of 3) waits for child workstreams that cannot be used: step patch waits for one child workstream per item, but the children recorded " +
        "for this pass of the step (r-patch) were created for a gate without for_each. To give the step a new pass, the owner sends the work back to it: " +
        "`fuse-flow continue r --back-to patch`; or change the gate back.",
    );
  });
});

describe("hold", () => {
  test("continue is refused until every child is complete, naming each that is not, and the verification lists them", () => {
    handOut();
    expect(repo.refused("continue", "p")).toContain(
      "3 of the 3 child workstreams this step waits for are not complete: workstream p-patch-a (item a) has not been started; " +
        "workstream p-patch-b (item b) has not been started; workstream p-patch-c (item c) has not been started. Run each to its end: " +
        "`fuse-flow start <slug>` prints its current step; then continue this step.",
    );
    const done = finish("p-patch-a");
    expect(done).toContain(
      "  - Step patch of workstream p waits for this workstream and for workstream p-patch-b (item b), which has not been started, " +
        "and workstream p-patch-c (item c), which has not been started. Go on there once they are complete: `fuse-flow start p` prints that step, " +
        "with what the child workstreams return to it.",
    );
    expect(repo.refused("continue", "p")).toContain("2 of the 3 child workstreams this step waits for are not complete: workstream p-patch-b (item b) has not been started; workstream p-patch-c (item c) has not been started.");
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-a (item a), which is complete; waits for workstream p-patch-b (item b), which has not been started; waits for workstream p-patch-c (item c), which has not been started");
    finish("p-patch-b");
    expect(finish("p-patch-c")).toContain("  - Step patch of workstream p waits for this workstream. Go on there: `fuse-flow start p` prints that step, with what this workstream returns to it.");
    const out = repo.ok("continue", "p");
    expect(out).toContain("STEP consolidate (3 of 3)");
    expect(out).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a, the child of step patch).");
    expect(out).toContain("READ reports/p-patch-b.md (reports, returned by workstream p-patch-b for item b, the child of step patch).");
    expect(out).toContain("READ reports/p-patch-c.md (reports, returned by workstream p-patch-c for item c, the child of step patch).");
    expect(repo.state("p").steps.patch.verification).toEqual([
      "workstream p-patch-a (item a, unit): complete",
      "workstream p-patch-b (item b, unit): complete",
      "workstream p-patch-c (item c, unit): complete",
    ]);
  });

  test("a missing child and one that follows another workflow hold the step, and the owner's options name them", () => {
    repo.start("p", parent(FOR_EACH + "      - owner-action: approve the merge\n"));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`);
    repo.ok("continue", "p");
    finish("p-patch-a");
    repo.cleanupPath(".konductor/workstreams/p-patch-b.yml");
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-a (item a), which is complete; waits for workstream p-patch-b (item b), which does not exist");
    const missing = repo.refused("continue", "p");
    expect(missing).toContain("1 of the 2 child workstreams this step waits for is not complete: workstream p-patch-b (item b) has not been started. Run each to its end:");
    expect(repo.state("p-patch-b").parent).toEqual({ slug: "p", step: "patch", item: "b" });
    // Made unusable by following another workflow.
    repo.write(".konductor/workflows/other.yml", "version: 1\nname: other\nsteps:\n  - id: x\n    instruction: x\n");
    repo.write(".konductor/workstreams/p-patch-b.yml", repo.read(".konductor/workstreams/p-patch-b.yml").replace("workflow: unit", "workflow: other"));
    const unusable = repo.refused("continue", "p");
    expect(unusable).toContain("1 of the 2 child workstreams this step waits for is not complete: step patch waits for a child workstream p-patch-b that follows unit, but workstream p-patch-b was created for this pass of the step and follows other.");
    expect(unusable).not.toContain("Run each to its end");
    expect(repo.ok("start", "p")).toContain("STEP patch (2 of 3) waits for child workstreams that cannot be used: step patch waits for a child workstream p-patch-b that follows unit");
  });

  test("the hand-over of a step awaiting the owner names the unfinished children, and the owner skips the step without them", () => {
    repo.start("p", parent(FOR_EACH + "      - owner-action: approve the merge\n"));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`);
    repo.ok("continue", "p");
    finish("p-patch-a");
    finish("p-patch-b");
    repo.ok("continue", "p");
    expect(repo.status("p", "patch")).toBe("AWAITING_OWNER");
    // One child's workflow gains a step, so that child is no longer complete.
    repo.write(".konductor/workflows/unit.yml", `${repo.read(".konductor/workflows/unit.yml")}  - id: verify\n    instruction: Verify.\n`);
    const out = repo.ok("start", "p");
    expect(out).toContain("It cannot be approved yet: 2 of the 2 child workstreams this step waits for are not complete: workstream p-patch-a (item a) is at step verify (2 of 2), not handed out yet; workstream p-patch-b (item b) is at step verify (2 of 2), not handed out yet.");
    expect(out).toContain("  - Finish workstreams p-patch-a, p-patch-b first, then approve the merge.");
    expect(out).toContain("  - Skip this step, without what workstreams p-patch-a, p-patch-b would return.");
    expect(out).toContain("VERIFICATION: workstream p-patch-a (item a, unit): complete when the step's work was recorded; now workstream p-patch-a (item a) is at step verify (2 of 2), not handed out yet;");
    expect(repo.refused("continue", "p", "--owner-approved")).toContain("step patch cannot complete yet: 2 of the 2 child workstreams");
  });
});

describe("passes and skip", () => {
  test("a skip removes every child in which nothing happened and keeps the one with work, saying so for each", () => {
    repo.start("p", parent(FOR_EACH).replace("  - id: patch\n    instruction: Merge the patches.\n", "  - id: patch\n    instruction: Merge the patches.\n    condition: { agent: there is anything to patch }\n"));
    for (const f of ["a", "b", "c"]) repo.write(`units/${f}.json`);
    const out = repo.ok("continue", "p");
    expect(out).toContain("If this step does not apply, skip it before you start them; fuse-flow then removes them, since nothing has happened in them.");
    repo.ok("start", "p-patch-b");
    const skipped = repo.ok("continue", "p", "--skip", "only b is real, and it was handled by hand");
    expect(skipped).toContain("Removed the child workstream p-patch-a, in which nothing had happened.");
    expect(skipped).toContain("The child workstream p-patch-b stays as it is, because work was done in it.");
    expect(skipped).toContain("Removed the child workstream p-patch-c, in which nothing had happened.");
    expect(repo.state("p").steps.patch.children).toEqual([{ pass: 1, slug: "p-patch-b", item: "b", file: "units/b.json" }]);
    expect(repo.ok("continue", "p-patch-b", "--not-produced", "patch-report", "nothing to report")).toContain(
      "  - Step patch of workstream p no longer waits for this workstream: step patch was skipped (only b is real, and it was handled by hand).",
    );
    expect(repo.ok("start", "p")).toContain("READ reports: step patch was skipped (only b is real, and it was handled by hand), so no child workstream returned it and there is nothing to read.");
  });

  test("a send-back past the step re-reads the folder for the next pass, whose children get -2, and keeps the first pass's children", () => {
    handOut(["a", "b"]);
    repo.ok("start", "p-patch-a");
    repo.ok("continue", "p", "--back-to", "approve", "--note", "unit c was missed");
    repo.write("units/c.json");
    const out = repo.ok("continue", "p");
    expect(out).toContain(
      "DELEGATE: this step waits for 3 child workstreams, one per item of units (units/), each following workflow unit: " +
        "p-patch-a-2 (item a, given unit-spec), p-patch-b-2 (item b, given unit-spec), p-patch-c-2 (item c, given unit-spec).",
    );
    expect(repo.state("p").steps.patch.children).toEqual([
      { pass: 1, slug: "p-patch-a", item: "a", file: "units/a.json" },
      { pass: 1, slug: "p-patch-b", item: "b", file: "units/b.json" },
      { pass: 2, slug: "p-patch-a-2", item: "a", file: "units/a.json" },
      { pass: 2, slug: "p-patch-b-2", item: "b", file: "units/b.json" },
      { pass: 2, slug: "p-patch-c-2", item: "c", file: "units/c.json" },
    ]);
    // The first pass's children keep their work and learn what the new pass waits for.
    expect(repo.state("p-patch-a").steps.patch.history.length).toBeGreaterThan(0);
    repo.write("reports/p-patch-a.md");
    expect(repo.ok("continue", "p-patch-a")).toContain(
      "  - Step patch of workstream p no longer waits for this workstream: the owner sent the work back, and the step's new pass waits for workstreams p-patch-a-2, p-patch-b-2, p-patch-c-2.",
    );
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-c-2 (item c), which has not been started; earlier child workstreams p-patch-a, p-patch-b");
  });

  test("an item of a later pass whose slug an earlier pass's child already has is refused before any child is created", () => {
    handOut(["unit", "unit-2"]);
    repo.ok("continue", "p", "--back-to", "approve");
    repo.cleanupPath("units/unit-2.json");
    const out = repo.ok("continue", "p");
    expect(out).toContain(
      "waits for child workstreams that cannot be created: step patch cannot create its child workstreams: item unit of pass 2 would take the slug " +
        "p-patch-unit-2 of pass 1's child for item unit-2; rename the file units/unit.json.",
    );
    expect(repo.state("p").steps.patch.children.filter((ch: any) => ch.pass === 2)).toEqual([]);
    expect(repo.state("p-patch-unit-2").parent).toEqual({ slug: "p", step: "patch", item: "unit-2" });
  });

  test("a completed child is told when its parent step is complete and no longer waits", () => {
    handOut(["a"]);
    finish("p-patch-a");
    repo.ok("continue", "p");
    expect(repo.ok("start", "p-patch-a")).toContain("parent:   step patch of workstream p, which no longer waits for this one: step patch is complete\n");
  });
});

describe("returns", () => {
  test("a later step reads one document per child, says which child recorded nothing, and which has become unfinished", () => {
    handOut();
    finish("p-patch-a");
    repo.ok("start", "p-patch-b");
    repo.ok("continue", "p-patch-b", "--not-produced", "patch-report", "nothing to patch");
    const block = repo.ok("start", "p");
    expect(block).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a).");
    expect(block).toContain("RETURNS reports: workstream p-patch-b (item b) recorded no patch-report, so there is nothing to read.");
    expect(block).toContain("RETURNS reports: patch-report of workstream p-patch-c (item c), once p-patch-c is complete; read it then.");
    finish("p-patch-c");
    const later = repo.ok("continue", "p");
    expect(later).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a, the child of step patch).");
    expect(later).toContain("READ reports: workstream p-patch-b (item b), the child of step patch, recorded no patch-report, so there is nothing to read.");
    expect(later).toContain("READ reports/p-patch-c.md (reports, returned by workstream p-patch-c for item c, the child of step patch).");
    // The children's workflow gains a step, so none of them is complete any more.
    repo.write(".konductor/workflows/unit.yml", `${repo.read(".konductor/workflows/unit.yml")}  - id: verify\n    instruction: Verify.\n`);
    expect(repo.ok("start", "p")).toContain(
      "READ reports: workstream p-patch-a (item a), the child of step patch, is at step verify (2 of 2), not handed out yet, so it has not returned patch-report and there is nothing to read yet.",
    );
  });

  test("a per-item id is not one document: --after leaves the input unbound, and an optional later producer that wrote nothing does not fall back to the set", () => {
    const LATER = parent(FOR_EACH, '    optional_produces: { artifact: reports, path: "all-reports.md" }\n  - id: last\n    instruction: Last.\n    consumes: [reports]\n');
    repo.start("p", LATER);
    repo.write("units/a.json");
    repo.ok("continue", "p");
    finish("p-patch-a");
    repo.ok("continue", "p");
    // consolidate writes nothing: the last step reads the per-item set, not one document.
    const last = repo.ok("continue", "p");
    expect(last).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a, the child of step patch).");
    expect(last).not.toContain("all-reports.md");
    repo.ok("continue", "p");
    repo.write(".konductor/workflows/next.yml", "version: 1\nname: next\ninputs:\n  - artifact: reports\n    required: true\nsteps:\n  - id: x\n    instruction: x\n    consumes: [reports]\n");
    expect(repo.refused("start", "n", "--workflow", "next", "--after", "p")).toContain("workflow next requires the input reports, and workstream p has no document of that id");
  });
});

describe("hand-out edge cases", () => {
  test("an input beside the item file is bound to the shared document, as for a plain gate", () => {
    repo.write(".konductor/workflows/unit.yml", repo.read(".konductor/workflows/unit.yml").replace("inputs:\n", "inputs:\n  - artifact: brief\n"));
    const shared = parent(FOR_EACH.replace("inputs: { unit-spec: units }", "inputs: { unit-spec: units, brief: plan }")).replace(
      "  - id: approve\n",
      '  - id: plan\n    instruction: Plan.\n    produces: { artifact: plan, path: "plan.md" }\n  - id: approve\n',
    );
    repo.start("p", shared);
    repo.write("plan.md");
    repo.ok("continue", "p");
    repo.write("units/a.json");
    expect(repo.ok("continue", "p")).toContain("p-patch-a (item a, given unit-spec, brief)");
    expect(repo.state("p-patch-a").inputs).toEqual({ "unit-spec": "units/a.json", brief: "plan.md" });
  });

  test("a child under the slug that was created for another item, or for the step as a whole, cannot be used", () => {
    handOut(["a", "b"]);
    const file = ".konductor/workstreams/p-patch-a.yml";
    repo.write(file, repo.read(file).replace("  item: a\n", "  item: b\n"));
    expect(repo.refused("continue", "p")).toContain(
      "step patch waits for a child workstream p-patch-a for item a, but workstream p-patch-a exists and was created for item b. Rename that workstream's state file, or give the gate a slug of its own",
    );
    repo.write(file, repo.read(file).replace("  item: b\n", ""));
    expect(repo.refused("continue", "p")).toContain("workstream p-patch-a exists and was created for the step as a whole.");
  });

  test("a producer that recorded only nested files and dotfiles gives no item", () => {
    repo.start("p", parent(FOR_EACH));
    repo.write("units/sub/n.json");
    repo.write("units/.keep");
    expect(repo.ok("continue", "p", "--updated", "units/sub/n.json", "--updated", "units/.keep")).toContain(
      "cannot create its child workstreams: units/ holds no item: no file to make a child for.",
    );
  });

  test("the repository root as the folder lists its direct files", () => {
    const INPUT = `version: 1\nname: q\ninputs:\n  - artifact: units\nsteps:\n  - id: patch\n    instruction: Merge.\n    gates:\n${FOR_EACH}`;
    repo.write("q.yml", INPUT);
    repo.write("one.json");
    const out = repo.ok("start", "r", "--workflow", "q.yml", "--input", "units=.");
    expect(out).toContain("each following workflow unit: r-patch-one (item one, given unit-spec), r-patch-q (item q, given unit-spec).");
  });

  test("a folder a plain child returned gives the files that child recorded, not every file in the folder", () => {
    repo.write(
      ".konductor/workflows/lister.yml",
      'version: 1\nname: lister\nsteps:\n  - id: list\n    instruction: List.\n    produces: { artifact: units, path: "units/" }\n',
    );
    const VIA_CHILD = `version: 1
name: parent
steps:
  - id: approve
    instruction: Have the units listed.
    gates:
      - workflow: lister
        returns: [units]
  - id: patch
    instruction: Merge the patches.
    gates:
${FOR_EACH}`;
    repo.start("p", VIA_CHILD);
    repo.ok("start", "p-approve");
    repo.write("units/a.json");
    repo.write("units/stray.json");
    repo.ok("continue", "p-approve", "--updated", "units/a.json");
    const out = repo.ok("continue", "p");
    expect(out).toContain("this step waits for 1 child workstream, one per item of units (units/), each following workflow unit: p-patch-a (item a, given unit-spec).");
    expect(out).not.toContain("stray");
  });

  test("the pass is read under the lock, so a set recorded for pass 2 carries pass 2", () => {
    repo.start("p", parent(FOR_EACH));
    repo.write("units/a.json");
    repo.ok("continue", "p");
    repo.ok("continue", "p", "--back-to", "approve");
    // The step is handed out again with the new pass; the recorded set must say pass 2.
    expect(repo.ok("continue", "p")).toContain("p-patch-a-2 (item a, given unit-spec)");
    expect(repo.state("p").steps.patch.children.filter((ch: any) => ch.pass === 2)).toEqual([{ pass: 2, slug: "p-patch-a-2", item: "a", file: "units/a.json" }]);
  });

  test("a skip drops the record of a child that was never created", () => {
    repo.write(".konductor/workflows/unit.yml", `${repo.read(".konductor/workflows/unit.yml")}hands_off_to: nowhere\n`);
    repo.start("p", parent(FOR_EACH).replace("    instruction: Merge the patches.\n", "    instruction: Merge the patches.\n    condition: { agent: anything to patch }\n"));
    repo.write("units/a.json");
    const out = repo.ok("continue", "p");
    expect(out).toContain("waits for child workstreams that cannot be created: workflow unit cannot start: hands_off_to nowhere");
    expect(repo.state("p").steps.patch.children).toHaveLength(1);
    expect((repo.state("p").steps.patch.history as string[]).some((h) => h.includes("created child workstream"))).toBe(false);
    const skipped = repo.ok("continue", "p", "--skip", "nothing to patch");
    expect(skipped).toContain("Dropped the record of child workstream p-patch-a, which does not exist.");
    expect(repo.state("p").steps.patch.children).toBeUndefined();
  });

  test("with one child missing and one unfinished, the owner is offered restoring the missing one and finishing the other", () => {
    repo.start("p", parent(FOR_EACH + "      - owner-action: approve the merge\n"));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`);
    repo.ok("continue", "p");
    finish("p-patch-a");
    finish("p-patch-b");
    repo.ok("continue", "p");
    repo.write(".konductor/workflows/unit.yml", `${repo.read(".konductor/workflows/unit.yml")}  - id: verify\n    instruction: Verify.\n`);
    repo.cleanupPath(".konductor/workstreams/p-patch-a.yml");
    const out = repo.ok("start", "p");
    expect(out).toContain("It cannot be approved yet: 2 of the 2 child workstreams this step waits for are not complete: workstream p-patch-a (item a) does not exist; workstream p-patch-b (item b) is at step verify (2 of 2), not handed out yet.");
    expect(out).toContain("  - Restore workstream p-patch-a, or send the work back to this step for a new child workstream, then finish workstream p-patch-b, and then approve the merge.");
    expect(out).toContain("  - The owner has workstream p-patch-a restored: restore `.konductor/workstreams/p-patch-a.yml` from version control or a backup, then run `fuse-flow start p` for the owner's approval.");
    expect(out).toContain("  - Skip this step, without what workstreams p-patch-a, p-patch-b would return.");
  });

  test("with one child unusable and one unfinished, continue names both and does not tell the agent to run them", () => {
    handOut(["a", "b"]);
    repo.write(".konductor/workflows/other.yml", "version: 1\nname: other\nsteps:\n  - id: x\n    instruction: x\n");
    repo.write(".konductor/workstreams/p-patch-a.yml", repo.read(".konductor/workstreams/p-patch-a.yml").replace("workflow: unit", "workflow: other"));
    const out = repo.refused("continue", "p");
    expect(out).toContain("2 of the 2 child workstreams this step waits for are not complete: step patch waits for a child workstream p-patch-a that follows unit, but workstream p-patch-a was created for this pass of the step and follows other.");
    expect(out).toContain("; workstream p-patch-b (item b) has not been started.");
    expect(out).not.toContain("Run each to its end");
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-b (item b), which has not been started");
  });

  test("files recorded at the repository root are items of the root folder", () => {
    repo.start("p", parent(FOR_EACH).replace('produces: { artifact: units, path: "units/" }', 'produces: { artifact: units, path: "." }'));
    repo.write("a.json");
    repo.write("b.json");
    expect(repo.ok("continue", "p", "--updated", "a.json", "--updated", "b.json")).toContain(
      "each following workflow unit: p-patch-a (item a, given unit-spec), p-patch-b (item b, given unit-spec).",
    );
  });

  test("a child of a pass whose gate was edited to the other shape is told the step holds, not that the owner sent the work back", () => {
    handOut(["a", "b"]);
    repo.write("workflow-source.yml", parent("      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report }\n"));
    expect(finish("p-patch-b")).toContain(
      "  - Step patch of workstream p no longer waits for this workstream: the gate of step patch was edited to wait for one child, so the children recorded for its pass cannot be used until the owner sends the work back to it.",
    );
  });

  test("a sibling whose workflow cannot be read does not break a finishing child's hand-over", () => {
    handOut(["a", "b"]);
    const file = ".konductor/workstreams/p-patch-b.yml";
    repo.write(file, repo.read(file).replace("workflow: unit", "workflow: gone-workflow"));
    expect(finish("p-patch-a")).toContain(
      '  - Step patch of workstream p waits for this workstream and for workstream p-patch-b (item b), which cannot be read: no workflow named "gone-workflow" in ',
    );
  });

  test("a returned document that is gone from disk is listed with the restore hint", () => {
    handOut(["a"]);
    finish("p-patch-a");
    repo.cleanupPath("reports/p-patch-a.md");
    expect(repo.ok("start", "p")).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a). It does not exist, for example because earlier steps were skipped.");
    expect(repo.ok("continue", "p")).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a, the child of step patch). It does not exist, for example because earlier steps were skipped.");
  });
});
