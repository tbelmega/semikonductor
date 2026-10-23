// SPDX-License-Identifier: Apache-2.0
// Child outcomes and reruns: a child workstream's agent declares with `finish`
// whether it succeeded or failed; a for_each parent carries succeeded children
// into the next pass, re-runs failed ones on its own or on the owner's
// selection, and holds its gate on failures when the gate asks it to.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
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
  - artifact: previous-verdict
steps:
  - id: patch
    instruction: Patch the unit.
    consumes: [unit-spec]
    produces: { artifact: patch-report, path: "reports/{slug}.md" }
  - id: verify
    instruction: Verify the patch.
    produces: { artifact: verdict, path: "verdicts/{slug}.md" }
`,
  );
});
afterEach(() => repo.cleanup());

// A parent whose `approve` step records a folder of units and whose `patch`
// step waits for one child per unit, with the gate written by the test.
const parent = (gate: string, consolidate = "    consumes: [reports, verdicts]\n") => `version: 1
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

const gate = (extra = "") => `      - workflow: unit
        for_each: units
        inputs: { unit-spec: units }
        returns: { reports: patch-report, verdicts: verdict }
${extra}`;

describe("gate parsing", () => {
  test("accept goes on any workflow gate; rerun, rerun_override and retries need for_each; each takes only its own values", () => {
    repo.write("ok.yml", parent(gate("        accept: succeeded\n        rerun: failed\n        rerun_override: false\n        retries: 2\n")));
    expect(repo.ok("validate", "ok.yml")).toContain("valid:");
    repo.write("zero.yml", parent(gate("        retries: 0\n")));
    expect(repo.ok("validate", "zero.yml")).toContain("valid:");
    const plain = (extra: string) => parent(`      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report, verdicts: verdict }\n${extra}`);
    repo.write("plain-accept.yml", plain("        accept: finished\n"));
    expect(repo.ok("validate", "plain-accept.yml")).toContain("valid:");

    repo.write("bad-accept.yml", parent(gate("        accept: always\n")));
    expect(repo.refused("validate", "bad-accept.yml")).toContain('accept is finished or succeeded; got "always"');
    repo.write("script-accept.yml", parent('      - script: "true"\n        accept: finished\n'));
    expect(repo.refused("validate", "script-accept.yml")).toContain("accept goes on a workflow gate only");
    repo.write("plain-rerun.yml", plain("        rerun: failed\n"));
    expect(repo.refused("validate", "plain-rerun.yml")).toContain("rerun needs for_each on the gate");
    repo.write("bad-rerun.yml", parent(gate("        rerun: some\n")));
    expect(repo.refused("validate", "bad-rerun.yml")).toContain('rerun is all or failed; got "some"');
    repo.write("plain-override.yml", plain("        rerun_override: false\n"));
    expect(repo.refused("validate", "plain-override.yml")).toContain("rerun_override needs for_each on the gate");
    repo.write("bad-override.yml", parent(gate("        rerun_override: no\n")));
    expect(repo.refused("validate", "bad-override.yml")).toContain('rerun_override is true or false; got "no"');
    repo.write("plain-retries.yml", plain("        retries: 1\n"));
    expect(repo.refused("validate", "plain-retries.yml")).toContain("retries needs for_each on the gate");
    repo.write("retries-all.yml", parent(gate("        retries: 1\n")));
    expect(repo.refused("validate", "retries-all.yml")).toContain("retries needs rerun: failed; under rerun: all there is nothing to retry");
    repo.write("retries-neg.yml", parent(gate("        rerun: failed\n        retries: -1\n")));
    expect(repo.refused("validate", "retries-neg.yml")).toContain("retries is a whole number, 0 or more; got -1");
    repo.write("retries-frac.yml", parent(gate("        rerun: failed\n        retries: 1.5\n")));
    expect(repo.refused("validate", "retries-frac.yml")).toContain("retries is a whole number, 0 or more; got 1.5");
    repo.write("retries-str.yml", parent(gate('        rerun: failed\n        retries: "2"\n')));
    expect(repo.refused("validate", "retries-str.yml")).toContain('retries is a whole number, 0 or more; got "2"');
    repo.write("as-condition.yml", parent(gate()).replace("    gates:\n", "    condition: { agent: anything, accept: succeeded }\n    gates:\n"));
    expect(repo.refused("validate", "as-condition.yml")).toContain("a condition has no accept");
  });

  test("an inputs value may name one of the gate's own returns, unless the child requires it or a parent document shares the id", () => {
    repo.write("bound.yml", parent(gate().replace("inputs: { unit-spec: units }", "inputs: { unit-spec: units, previous-verdict: verdicts }")));
    expect(repo.ok("validate", "bound.yml")).toContain("valid:");
    // A renamed return binds by its parent-side id.
    repo.write(
      "renamed.yml",
      parent(gate().replace("inputs: { unit-spec: units }", "inputs: { unit-spec: units, previous-verdict: last }").replace("verdicts: verdict", "last: verdict"), "    consumes: [reports, last]\n"),
    );
    expect(repo.ok("validate", "renamed.yml")).toContain("valid:");

    repo.write(".konductor/workflows/unit.yml", repo.read(".konductor/workflows/unit.yml").replace("  - artifact: previous-verdict\n", "  - artifact: previous-verdict\n    required: true\n"));
    expect(repo.refused("validate", "bound.yml")).toContain(
      'step patch, workflow unit: inputs binds "previous-verdict" from the gate\'s own return "verdicts", the item\'s previous attempt, which a first attempt does not have; unit must not require that input',
    );
    const ambiguous = parent(gate().replace("inputs: { unit-spec: units }", "inputs: { unit-spec: units, previous-verdict: verdicts }")).replace(
      "  - id: approve\n",
      '  - id: plan\n    instruction: Plan.\n    produces: { artifact: verdicts, path: "verdicts.md" }\n  - id: approve\n',
    );
    repo.write("ambiguous.yml", ambiguous);
    expect(repo.refused("validate", "ambiguous.yml")).toContain(
      '"patch" gives its child "verdicts", which is both a document of this workflow and one of the gate\'s own returns; rename the return, as in returns: { <new id>: verdict }',
    );
  });
});

describe("legacy state", () => {
  test("a state file with no outcome reads as succeeded once complete and status names no outcome", () => {
    repo.start("p", parent(gate()));
    repo.write("units/a.json");
    repo.ok("continue", "p");
    repo.ok("start", "p-patch-a");
    repo.write("reports/p-patch-a.md");
    repo.ok("continue", "p-patch-a");
    repo.write("verdicts/p-patch-a.md");
    const done = repo.ok("continue", "p-patch-a");
    expect(done).toContain("STATUS: workflow complete");
    expect(done).not.toContain("OUTCOME");
    expect(repo.state("p-patch-a").outcome).toBeUndefined();
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-a (item a), which is complete");
    expect(repo.ok("status", "p")).not.toContain("outcome");
  });
});

// Hands the parent's `patch` step out with one child per file.
function handOut(files = ["a"]): void {
  repo.start("p", parent(gate()));
  for (const f of files) repo.write(`units/${f}.json`, `{"unit":"${f}"}\n`);
  repo.ok("continue", "p");
}

// Runs child `slug` through its patch step, so its verify step is in progress.
function toVerify(slug: string): void {
  repo.ok("start", slug);
  repo.write(`reports/${slug}.md`);
  repo.ok("continue", slug);
}

// Runs child `slug` to its end.
function complete(slug: string): string {
  toVerify(slug);
  repo.write(`verdicts/${slug}.md`);
  return repo.ok("continue", slug);
}

describe("finish", () => {
  test("failed on a step in progress records the named verdict, skips the rest, and the parent reads both", () => {
    handOut();
    toVerify("p-patch-a");
    repo.write("verdicts/p-patch-a.md", "cannot be patched\n");
    const out = repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "the API it calls is gone", "--updated", "verdicts/p-patch-a.md");
    expect(out).toContain("p-patch-a: ended as failed at step verify: the API it calls is gone");
    expect(out).toContain("STATUS: workflow complete\nOUTCOME: failed at step verify: the API it calls is gone\n");
    expect(out).toContain("verify: verdicts/p-patch-a.md (new)");
    const child = repo.state("p-patch-a");
    expect(child.outcome).toEqual({ kind: "failed", reason: "the API it calls is gone", step: "verify" });
    expect(child.steps.verify).toMatchObject({ status: "SKIPPED", skip_reason: "ended as failed: the API it calls is gone" });
    expect(child.steps.verify.history.some((h: string) => h.endsWith("finished by the agent as failed: the API it calls is gone"))).toBe(true);
    expect(repo.ok("status", "p-patch-a")).toContain("workflow complete; it ended as failed at step verify: the API it calls is gone");
    expect(repo.ok("status", "p")).toContain("waits for workstream p-patch-a (item a), which is complete, ended as failed at step verify: the API it calls is gone");
    const next = repo.ok("continue", "p");
    expect(next).toContain("READ verdicts/p-patch-a.md (verdicts, returned by workstream p-patch-a for item a, the child of step patch, which ended as failed at step verify: the API it calls is gone).");
    expect(next).toContain("READ reports/p-patch-a.md (reports, returned by workstream p-patch-a for item a, the child of step patch, which ended as failed at step verify: the API it calls is gone).");
  });

  test("failed on a child never started records only the named files, even where a produced path already exists", () => {
    handOut(["a", "b"]);
    repo.write("reports/p-patch-b.md", "someone else's file\n");
    repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "out of scope");
    const child = repo.state("p-patch-b");
    expect(child.outcome).toEqual({ kind: "failed", reason: "out of scope", step: "patch" });
    expect(child.steps.patch).toMatchObject({ status: "SKIPPED", artifacts: [] });
    expect(child.steps.verify.status).toBe("SKIPPED");
    // Not untouched any more, so a parent skip keeps it.
    expect(repo.ok("continue", "p", "--skip", "handled by hand")).toContain("The child workstream p-patch-b stays as it is, because work was done in it.");
  });

  test("failed on a blocked step clears its blocked markers", () => {
    handOut();
    repo.ok("start", "p-patch-a");
    repo.ok("continue", "p-patch-a", "--blocked", "the spec is contradictory");
    repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "the spec is contradictory");
    expect(repo.state("p-patch-a").steps.patch).toMatchObject({ status: "SKIPPED", skip_reason: "ended as failed: the spec is contradictory" });
    expect(repo.state("p-patch-a").steps.patch.blocked_gate).toBeUndefined();
  });

  test("a step awaiting the owner is the owner's, so finish is refused there", () => {
    repo.write(".konductor/workflows/unit.yml", `${repo.read(".konductor/workflows/unit.yml")}    gates:\n      - owner-action: approve the verdict\n`);
    handOut();
    complete("p-patch-a");
    expect(repo.status("p-patch-a", "verify")).toBe("AWAITING_OWNER");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "failed", "--reason", "x")).toContain(
      "step verify awaits the owner; only the owner moves it: approve it, send it back, or skip it",
    );
  });

  test("on a complete child, failed only labels it, succeeded is optional, and a second declaration is refused", () => {
    handOut(["a", "b"]);
    complete("p-patch-a");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "failed", "--reason", "x", "--updated", "verdicts/p-patch-a.md")).toContain(
      "--updated: a complete child has nothing left to record",
    );
    const out = repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "the patch breaks the build");
    expect(out).toContain("OUTCOME: failed: the patch breaks the build");
    const child = repo.state("p-patch-a");
    expect(child.outcome).toEqual({ kind: "failed", reason: "the patch breaks the build" });
    expect(child.steps.verify.status).toBe("COMPLETED");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "succeeded")).toContain("workstream p-patch-a's outcome is already declared: failed");

    complete("p-patch-b");
    const ok = repo.ok("finish", "p-patch-b", "--outcome", "succeeded");
    expect(ok).toContain("p-patch-b: finished as succeeded");
    expect(ok).not.toContain("OUTCOME");
    expect(repo.state("p-patch-b").outcome).toEqual({ kind: "succeeded" });
  });

  test("succeeded on an unfinished child is refused: a success goes through every step", () => {
    handOut();
    repo.ok("start", "p-patch-a");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "succeeded")).toContain(
      "--outcome succeeded requires every step COMPLETED or SKIPPED; the current step is patch (IN_PROGRESS)",
    );
  });

  test("finish is for child workstreams whose parent still waits", () => {
    repo.start("solo", "version: 1\nname: solo\nsteps:\n  - id: x\n    instruction: x\n");
    expect(repo.refused("finish", "solo", "--outcome", "failed", "--reason", "x")).toContain("workstream solo has no parent");
    handOut();
    repo.ok("start", "p-patch-a");
    repo.ok("continue", "p", "--skip", "not needed after all");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "failed", "--reason", "x")).toContain(
      "step patch of workstream p no longer waits for this workstream: step patch was skipped (not needed after all); its outcome can no longer be declared",
    );
  });

  test("the arguments are checked before anything is read", () => {
    handOut();
    expect(repo.usage("finish", "p-patch-a")).toContain("finish takes --outcome succeeded or --outcome failed");
    expect(repo.usage("finish", "p-patch-a", "--outcome", "maybe")).toContain("finish takes --outcome succeeded or --outcome failed");
    expect(repo.usage("finish", "p-patch-a", "--outcome", "failed")).toContain('--outcome failed needs --reason "<why the workstream failed>"');
    expect(repo.usage("finish", "p-patch-a", "--outcome", "succeeded", "--reason", "x")).toContain("--reason goes with --outcome failed only");
    expect(repo.usage("finish", "p-patch-a", "--outcome", "succeeded", "--updated", "x.md")).toContain("--updated goes with --outcome failed only");
    expect(repo.usage("finish", "p-patch-a", "--outcome", "failed", "--outcome", "failed", "--reason", "x")).toContain("--outcome is given twice");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "failed", "--reason", "   ")).toContain("--reason needs a reason, not blank text");
  });

  test("new work voids a declaration: a step a workflow edit adds is handed out, or skipped by its condition", () => {
    handOut(["a", "b"]);
    complete("p-patch-a");
    repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "x");
    complete("p-patch-b");
    repo.ok("finish", "p-patch-b", "--outcome", "succeeded");
    const unit = repo.read(".konductor/workflows/unit.yml");
    repo.write(".konductor/workflows/unit.yml", `${unit}  - id: recheck\n    instruction: Recheck.\n`);
    repo.ok("start", "p-patch-a");
    expect(repo.state("p-patch-a").outcome).toBeUndefined();
    repo.write(".konductor/workflows/unit.yml", `${unit}  - id: recheck\n    instruction: Recheck.\n    condition: { script: "false" }\n`);
    repo.ok("start", "p-patch-b");
    expect(repo.state("p-patch-b").outcome).toBeUndefined();
    expect(repo.state("p-patch-b").steps.recheck.status).toBe("SKIPPED");
  });
});

// Parent `p` with gate `extra`, units a, b and c handed out; a succeeds, b fails, c is left unfinished.
function mixedPass(extra: string): void {
  repo.start("p", parent(gate(extra)));
  for (const f of ["a", "b", "c"]) repo.write(`units/${f}.json`, `{"unit":"${f}"}\n`);
  repo.ok("continue", "p");
  complete("p-patch-a");
  repo.ok("start", "p-patch-b");
  repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "the API is gone");
  repo.ok("start", "p-patch-c");
}

const pass2 = () => repo.state("p").steps.patch.children.filter((ch: { pass: number }) => ch.pass === 2);

describe("carry-over and --rerun", () => {
  test("the default rerun: all gives every item a new child and carries none over", () => {
    mixedPass("");
    repo.ok("continue", "p", "--back-to", "patch");
    repo.ok("start", "p");
    expect(pass2().map((ch: { slug: string }) => ch.slug)).toEqual(["p-patch-a-2", "p-patch-b-2", "p-patch-c-2"]);
    expect(repo.state("p").steps.patch.history.some((h: string) => h.includes("carried over"))).toBe(false);
  });

  test("rerun: failed carries the succeeded and unfinished children and gives the failed item a new child", () => {
    mixedPass("        rerun: failed\n");
    repo.ok("continue", "p", "--back-to", "patch");
    const out = repo.ok("start", "p");
    expect(pass2()).toEqual([
      { pass: 2, slug: "p-patch-a", item: "a", file: "units/a.json" },
      { pass: 2, slug: "p-patch-b-2", item: "b", file: "units/b.json" },
      { pass: 2, slug: "p-patch-c", item: "c", file: "units/c.json" },
    ]);
    expect(out).toContain("p-patch-a (item a, given unit-spec, carried over from pass 1, succeeded; do not run it again)");
    expect(out).toContain("p-patch-c (item c, given unit-spec, carried over from pass 1, is at step patch (1 of 2)");
    expect(out).toContain("p-patch-b-2 (item b, given unit-spec; rerun of item b: previous attempt p-patch-b ended as failed at step patch: the API is gone)");
    const history = repo.state("p").steps.patch.history.join("\n");
    expect(history).toContain("carried over 2 child workstreams from earlier passes: p-patch-a (item a, pass 1, succeeded), p-patch-c (item c, pass 1, unfinished)");
    expect(history).toContain("recorded 1 child workstream to create: p-patch-b-2 (item b)");
    // A carried child's parent still waits for it.
    repo.write("reports/p-patch-c.md");
    repo.ok("continue", "p-patch-c");
    repo.write("verdicts/p-patch-c.md");
    expect(repo.ok("continue", "p-patch-c")).not.toContain("no longer waits");
  });

  test("the owner's --rerun names exactly the items that get new children, and is consumed by the hand-out", () => {
    mixedPass("");
    // The send-back prints the step again, which hands it out and records the new set.
    repo.ok("continue", "p", "--back-to", "patch", "--rerun", "a", "--note", "redo a only");
    expect(repo.state("p").steps.patch.history.some((h: string) => h.endsWith("owner selected the items to re-run: a"))).toBe(true);
    const out = repo.ok("start", "p");
    expect(pass2().map((ch: { slug: string }) => ch.slug)).toEqual(["p-patch-a-2", "p-patch-b", "p-patch-c"]);
    expect(out).toContain("p-patch-b (item b, given unit-spec, carried over from pass 1, ended as failed at step patch: the API is gone; not re-run because --rerun did not name it)");
    expect(repo.state("p").steps.patch.rerun).toBeUndefined();
  });

  test("a later send-back without --rerun clears an earlier selection, and a skip drops it", () => {
    mixedPass("");
    repo.ok("continue", "p", "--back-to", "patch", "--rerun", "a");
    repo.ok("continue", "p", "--back-to", "approve");
    expect(repo.state("p").steps.patch.rerun).toBeUndefined();
    repo.ok("continue", "p");
    repo.ok("continue", "p", "--back-to", "patch", "--rerun", "b");
    repo.ok("continue", "p", "--skip", "not needed");
    expect(repo.state("p").steps.patch.rerun).toBeUndefined();
  });

  test("--rerun is checked against the step and its current items", () => {
    mixedPass("");
    expect(repo.usage("continue", "p", "--rerun", "a")).toContain("--rerun goes with --back-to");
    expect(repo.usage("continue", "p", "--back-to", "patch", "--rerun", "a,,b")).toContain("--rerun takes one or more item names, separated by commas");
    expect(repo.refused("continue", "p", "--back-to", "approve", "--rerun", "a")).toContain(
      "--rerun names items of step patch; send the work back to patch, or send it back without --rerun",
    );
    expect(repo.refused("continue", "p", "--back-to", "patch", "--rerun", "a,a")).toContain("--rerun names item a twice");
    expect(repo.refused("continue", "p", "--back-to", "patch", "--rerun", "a,zz")).toContain("--rerun names an item step patch does not have: zz; its items are a, b, c");
    expect(repo.status("p", "patch")).toBe("IN_PROGRESS");
  });

  test("a carried child that no longer fits the edited gate is reported unusable, with --rerun for its item as the way out", () => {
    mixedPass("        rerun: failed\n");
    repo.ok("continue", "p", "--back-to", "patch");
    repo.write(".konductor/workflows/unit2.yml", repo.read(".konductor/workflows/unit.yml").replace("name: unit", "name: unit2"));
    repo.write("workflow-source.yml", parent(gate("        rerun: failed\n").replace("workflow: unit\n", "workflow: unit2\n")));
    const out = repo.refused("continue", "p");
    expect(out).toContain("continue p --back-to patch --rerun a`");
  });

  test("rerun_override: false refuses the owner's list", () => {
    mixedPass("        rerun: failed\n        rerun_override: false\n");
    expect(repo.refused("continue", "p", "--back-to", "patch", "--rerun", "a")).toContain(
      "step patch's gate sets rerun_override: false, so the items to re-run follow its rerun setting (failed)",
    );
  });

  test("a step that has recorded no children has no items to re-run", () => {
    handOut();
    // With the folder emptied the new pass cannot derive its set, so it records none.
    rmSync(join(repo.root, "units/a.json"));
    repo.ok("continue", "p", "--back-to", "patch");
    expect(repo.state("p").steps.patch.children.some((ch: { pass: number }) => ch.pass === 2)).toBe(false);
    expect(repo.refused("continue", "p", "--back-to", "patch", "--rerun", "a")).toContain("has recorded no child workstreams in its current pass");
  });
});

describe("accept", () => {
  test("accept: finished, the default, lets a failed child through and later steps read its outcome", () => {
    handOut();
    repo.ok("start", "p-patch-a");
    repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "no");
    const next = repo.ok("continue", "p");
    expect(next).toContain("STEP consolidate");
    expect(next).toContain("workstream p-patch-a (item a), the child of step patch, ended as failed at step patch: no, and recorded no patch-report");
    // The step the failure skipped was not passed over, so there is nothing to restore.
    expect(next).toContain("ended as failed at step patch: no, and recorded no verdict, so there is nothing to read.");
  });

  test("accept: succeeded holds the step until every child has finished, then hands the failures to the owner grouped by reason", () => {
    repo.start("p", parent(gate("        accept: succeeded\n")));
    for (const f of ["a", "b", "c"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    complete("p-patch-a");
    for (const s of ["p-patch-b", "p-patch-c"]) {
      repo.ok("start", s);
      repo.ok("finish", s, "--outcome", "failed", "--reason", "the API is gone");
    }
    const refused = repo.refused("continue", "p");
    expect(refused).toContain(
      "2 of the 3 child workstreams this step waits for have not succeeded: workstream p-patch-b (item b) ended as failed at step patch: the API is gone; " +
        "workstream p-patch-c (item c) ended as failed at step patch: the API is gone. Report the step blocked so the owner decides",
    );
    expect(refused).toContain("continue p --back-to patch --rerun b,c --note");
    expect(refused).not.toContain("Run each to its end");

    const blocked = repo.ok("continue", "p", "--blocked", "two units failed");
    expect(blocked).toContain("2 child workstreams ended as failed: p-patch-b (item b), p-patch-c (item c) (same reason: the API is gone)");
    expect(blocked).toContain("continue p --back-to patch --rerun b,c --note");
    expect(repo.refused("continue", "p", "--owner-approved")).toContain("The owner sends the work back for new child workstreams");
  });

  test("with an unfinished sibling the agent is told to finish it first", () => {
    mixedPass("        accept: succeeded\n");
    const refused = repo.refused("continue", "p");
    expect(refused).toContain("have not completed and succeeded");
    expect(refused).toContain("Once every child is finished, report the step blocked");
  });
});

// A gate that binds the previous attempt's verdict to the new child.
const bindingGate = (extra: string) => `      - workflow: unit
        for_each: units
        inputs: { unit-spec: units, previous-verdict: verdicts }
        returns: { reports: patch-report, verdicts: verdict }
${extra}`;

// Child `slug` writes its verdict and declares itself failed at its verify step.
function failAtVerify(slug: string, reason = "the build breaks"): void {
  toVerify(slug);
  repo.write(`verdicts/${slug}.md`, `${reason}\n`);
  repo.ok("finish", slug, "--outcome", "failed", "--reason", reason, "--updated", `verdicts/${slug}.md`);
}

describe("automatic retry and the previous attempt's verdict", () => {
  test("the parent's continue opens the next pass for the failed items itself, with the previous verdict bound, until the budget is spent", () => {
    repo.start("p", parent(bindingGate("        rerun: failed\n        retries: 1\n")));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    expect(repo.state("p-patch-a").inputs["previous-verdict"]).toBeUndefined();
    complete("p-patch-a");
    failAtVerify("p-patch-b");

    const retry = repo.refused("continue", "p");
    expect(retry).toContain(
      "1 child workstream ended as failed: p-patch-b (item b) (the build breaks). Automatic retry 1 of 1: fuse-flow opened pass 2 of this step " +
        "with new child workstreams for items b; the other children are carried over. Run each new one to its end",
    );
    expect(retry).toContain("p-patch-a (item a, given unit-spec, carried over from pass 1, succeeded; do not run it again)");
    expect(retry).toContain(
      "p-patch-b-2 (item b, given unit-spec, previous-verdict; retry 1 of 1 for item b: previous attempt p-patch-b ended as failed at step verify: the build breaks; " +
        "previous-verdict at verdicts/p-patch-b.md)",
    );
    expect(retry).not.toContain("accept");
    const state = repo.state("p").steps.patch;
    expect(state).toMatchObject({ status: "IN_PROGRESS", pass: 2, retries_used: 1 });
    expect(state.rerun).toBeUndefined();
    expect(state.history.some((h: string) => h.endsWith("automatic retry 1 of 1 for items b"))).toBe(true);
    expect(repo.state("p-patch-b-2").inputs["previous-verdict"]).toBe("verdicts/p-patch-b.md");

    // The budget is spent: under the default accept: finished the step completes on the failure.
    failAtVerify("p-patch-b-2", "still breaks");
    expect(repo.ok("continue", "p")).toContain("STEP consolidate");
  });

  test("no retry while a child is unfinished; a spent budget under accept: succeeded goes to the owner, whose send-back resets it", () => {
    repo.start("p", parent(bindingGate("        rerun: failed\n        retries: 1\n        accept: succeeded\n")));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    failAtVerify("p-patch-b");
    repo.ok("start", "p-patch-a");
    expect(repo.refused("continue", "p")).not.toContain("Automatic retry");
    expect(repo.state("p").steps.patch.retries_used).toBeUndefined();
    repo.write("reports/p-patch-a.md");
    repo.ok("continue", "p-patch-a");
    repo.write("verdicts/p-patch-a.md");
    repo.ok("continue", "p-patch-a");

    expect(repo.refused("continue", "p")).toContain("Automatic retry 1 of 1");
    failAtVerify("p-patch-b-2", "still breaks");
    const spent = repo.refused("continue", "p");
    expect(spent).toContain("has not succeeded: workstream p-patch-b-2 (item b) ended as failed at step verify: still breaks");
    expect(spent).toContain("--back-to patch --rerun b --note");

    repo.ok("continue", "p", "--blocked", "b keeps failing");
    const back = repo.ok("continue", "p", "--back-to", "patch", "--rerun", "a,b", "--note", "try both once more");
    expect(repo.state("p").steps.patch.retries_used).toBeUndefined();
    expect(back).toContain("p-patch-a-3 (item a, given unit-spec, previous-verdict; rerun of item a: previous attempt p-patch-a succeeded; previous-verdict at verdicts/p-patch-a.md)");
    // Only the latest attempt is bound.
    expect(back).toContain("p-patch-b-3 (item b, given unit-spec, previous-verdict; rerun of item b: previous attempt p-patch-b-2 ended as failed at step verify: still breaks; previous-verdict at verdicts/p-patch-b-2.md)");
  });

  test("a previous attempt that recorded no verdict leaves the input unbound", () => {
    repo.start("p", parent(bindingGate("        rerun: failed\n        retries: 1\n")));
    repo.write("units/a.json", "{}\n");
    repo.ok("continue", "p");
    repo.ok("start", "p-patch-a");
    repo.ok("finish", "p-patch-a", "--outcome", "failed", "--reason", "no spec");
    const retry = repo.refused("continue", "p");
    expect(retry).toContain("p-patch-a-2 (item a, given unit-spec; retry 1 of 1 for item a: previous attempt p-patch-a ended as failed at step patch: no spec)");
    expect(repo.state("p-patch-a-2").inputs["previous-verdict"]).toBeUndefined();
  });
});

describe("mixed child outcomes", () => {
  test("a refused finish leaves the current step's own untouched child in place", () => {
    repo.write(".konductor/workflows/leaf.yml", "version: 1\nname: leaf\nsteps:\n  - id: x\n    instruction: x\n");
    repo.write(
      ".konductor/workflows/unit.yml",
      "version: 1\nname: unit\ninputs:\n  - artifact: unit-spec\n    required: true\nsteps:\n  - id: inner\n    instruction: Delegate.\n    gates:\n      - workflow: leaf\n",
    );
    repo.start("p", parent(gate().replace("        returns: { reports: patch-report, verdicts: verdict }\n", ""), ""));
    repo.write("units/a.json", "{}\n");
    repo.ok("continue", "p");
    repo.ok("start", "p-patch-a");
    expect(repo.state("p-patch-a-inner").parent.slug).toBe("p-patch-a");
    repo.ok("continue", "p", "--skip", "not needed");
    expect(repo.refused("finish", "p-patch-a", "--outcome", "failed", "--reason", "x")).toContain("no longer waits for this workstream");
    expect(repo.state("p-patch-a-inner").parent.slug).toBe("p-patch-a");
  });

  test("rerun: failed replaces an item whose earlier child is missing or cannot be read", () => {
    mixedPass("        rerun: failed\n");
    rmSync(join(repo.root, ".konductor/workstreams/p-patch-a.yml"));
    repo.write(".konductor/workstreams/p-patch-c.yml", "steps: [not, a, mapping\n");
    repo.ok("continue", "p", "--back-to", "patch");
    expect(pass2().map((ch: { slug: string }) => ch.slug)).toEqual(["p-patch-a-2", "p-patch-b-2", "p-patch-c-2"]);
    for (const slug of ["p-patch-a-2", "p-patch-c-2"]) expect(repo.state(slug).parent).toMatchObject({ slug: "p", step: "patch" });
  });

  test("a blocked step with failed and unfinished children offers a rerun of the failed ones and says the others still run", () => {
    mixedPass("        accept: succeeded\n");
    const out = repo.ok("continue", "p", "--blocked", "b failed");
    expect(out).toContain(
      "1 child workstream ended as failed: p-patch-b (item b) (the API is gone). Send the work back to this step for new child workstreams for them; " +
        "workstream p-patch-c is carried over unfinished and still runs to its end.",
    );
    expect(out).toContain("continue p --back-to patch --rerun b --note");
  });

  test("a failed child beside a missing or unusable one is replaced by the same send-back", () => {
    repo.write(".konductor/workflows/unit2.yml", repo.read(".konductor/workflows/unit.yml").replace("name: unit", "name: unit2"));
    repo.start("p", parent(gate("        accept: succeeded\n")));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    complete("p-patch-a");
    repo.ok("start", "p-patch-b");
    repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "the API is gone");
    const a = ".konductor/workstreams/p-patch-a.yml";
    repo.write(a, repo.read(a).replace("workflow: unit\n", "workflow: unit2\n"));
    repo.ok("continue", "p", "--blocked", "a is unusable, b failed");
    const blocked = repo.ok("start", "p");
    expect(blocked).toContain("--back-to patch --rerun a,b --note");
    rmSync(join(repo.root, a));
    expect(repo.ok("start", "p")).toContain("--back-to patch --rerun a,b --note");
  });

  test("an owner gate's hand-over with a missing and a failed child does not ask to finish the failed one", () => {
    repo.start("p", parent(`${gate("        accept: succeeded\n")}      - owner-action: approve the patches\n`));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    complete("p-patch-a");
    complete("p-patch-b");
    repo.ok("continue", "p");
    expect(repo.status("p", "patch")).toBe("AWAITING_OWNER");
    repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "the patch breaks the build");
    rmSync(join(repo.root, ".konductor/workstreams/p-patch-a.yml"));
    const out = repo.ok("start", "p");
    expect(out).not.toContain("finish workstream p-patch-b");
    // Restoring a alone would leave b failed, so approval would stay refused.
    expect(out).not.toContain("Restore workstream p-patch-a");
    expect(out).toContain("1 child workstream ended as failed: p-patch-b (item b) (the patch breaks the build), and workstream p-patch-a cannot be used as it is");
    expect(out).toContain("--back-to patch --rerun a,b --note");
    // The same with a child that exists but no longer fits the gate.
    repo.write(".konductor/workflows/unit2.yml", repo.read(".konductor/workflows/unit.yml").replace("name: unit", "name: unit2"));
    repo.write(".konductor/workstreams/p-patch-a.yml", repo.read(".konductor/workstreams/p-patch-b.yml").replace("workflow: unit\n", "workflow: unit2\n").replace("item: b", "item: a"));
    const unusable = repo.ok("start", "p");
    expect(unusable).not.toContain("Correct what holds the approval back");
    expect(unusable).toContain("--back-to patch --rerun a,b --note");
  });

  test("accept: succeeded on a plain gate with an owner gate: a child failed after the step awaits the owner holds the approval", () => {
    const plain = "      - workflow: unit\n        inputs: { unit-spec: units }\n        accept: succeeded\n      - owner-action: approve the patch\n";
    repo.start("p", parent(plain, ""));
    repo.write("units/a.json", "{}\n");
    repo.ok("continue", "p");
    complete("p-patch");
    repo.ok("continue", "p");
    expect(repo.status("p", "patch")).toBe("AWAITING_OWNER");
    repo.ok("finish", "p-patch", "--outcome", "failed", "--reason", "it does not build");
    const out = repo.ok("start", "p");
    expect(out).toContain("1 child workstream ended as failed: p-patch (it does not build)");
    expect(out).toContain("`fuse-flow continue p --back-to patch --note");
    expect(out).not.toContain("--rerun");
    expect(repo.refused("continue", "p", "--owner-approved")).toContain("The owner sends the work back for new child workstreams");
  });

  test("accept: succeeded on a plain workflow gate: a failed child holds the step and the owner's way is a plain send-back", () => {
    const plain = "      - workflow: unit\n        inputs: { unit-spec: units }\n        returns: { reports: patch-report, verdicts: verdict }\n        accept: succeeded\n";
    repo.start("p", parent(plain));
    repo.write("units/a.json", "{}\n");
    repo.ok("continue", "p");
    repo.ok("start", "p-patch");
    repo.ok("finish", "p-patch", "--outcome", "failed", "--reason", "no");
    const refused = repo.refused("continue", "p");
    expect(refused).toContain("workstream p-patch, which this step waits for, ended as failed at step patch: no");
    expect(refused).toContain("`fuse-flow continue p --back-to patch --note");
    expect(refused).not.toContain("--rerun");
    repo.ok("continue", "p", "--blocked", "the child failed");
    repo.ok("continue", "p", "--back-to", "patch");
    expect(repo.state("p").steps.patch.children.map((ch: { slug: string }) => ch.slug)).toEqual(["p-patch", "p-patch-2"]);
    complete("p-patch-2");
    expect(repo.ok("continue", "p")).toContain("STEP consolidate");
  });
});

describe("limits of reruns, retries and finish", () => {
  test("rerun: failed without retries opens no pass by itself", () => {
    repo.start("p", parent(gate("        rerun: failed\n")));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    complete("p-patch-a");
    repo.ok("start", "p-patch-b");
    repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "no");
    expect(repo.ok("continue", "p")).toContain("STEP consolidate");
    expect(repo.state("p").steps.patch.pass ?? 1).toBe(1);
  });

  test("no automatic retry while a child is missing; that child is the owner's", () => {
    repo.start("p", parent(gate("        rerun: failed\n        retries: 1\n")));
    for (const f of ["a", "b"]) repo.write(`units/${f}.json`, "{}\n");
    repo.ok("continue", "p");
    repo.ok("start", "p-patch-b");
    repo.ok("finish", "p-patch-b", "--outcome", "failed", "--reason", "no");
    rmSync(join(repo.root, ".konductor/workstreams/p-patch-a.yml"));
    const out = repo.refused("continue", "p");
    expect(out).not.toContain("Automatic retry");
    expect(repo.state("p").steps.patch.retries_used).toBeUndefined();
  });

  test("finish is refused once the parent step completed, or moved to a pass the child is not in", () => {
    handOut(["a", "b"]);
    complete("p-patch-a");
    repo.ok("start", "p-patch-b");
    repo.ok("continue", "p", "--back-to", "patch");
    expect(repo.refused("finish", "p-patch-b", "--outcome", "failed", "--reason", "x")).toContain("no longer waits for this workstream");
    for (const s of ["p-patch-a-2", "p-patch-b-2"]) complete(s);
    repo.ok("continue", "p");
    expect(repo.status("p", "patch")).toBe("COMPLETED");
    expect(repo.refused("finish", "p-patch-a-2", "--outcome", "failed", "--reason", "x")).toContain("no longer waits for this workstream");
  });
});
