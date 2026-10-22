// SPDX-License-Identifier: Apache-2.0
// How workstreams relate: a workstream started after another takes its
// documents as inputs, and a step with a workflow gate creates a child
// workstream, waits for it, and hands its returned documents to later steps.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

// A workflow by name, in the project's own workflows folder.
const install = (name: string, yaml: string) => repo.write(`.konductor/workflows/${name}.yml`, yaml);

describe("hand-off", () => {
  const SYSTEM = `version: 1
name: system
hands_off_to:
  - workflow: feature
    when: once per entry of the build order
steps:
  - id: plan
    instruction: Write the build order.
    produces:
      - artifact: build-order
        path: docs/{slug}-order.md
      - artifact: system-design
        path: docs/{slug}-design.md
`;
  const FEATURE = `version: 1
name: feature
inputs:
  - artifact: build-order
  - artifact: system-design
    required: true
  - artifact: brief
steps:
  - id: build
    instruction: Build the feature.
    consumes: [build-order, system-design, brief]
`;

  beforeEach(() => {
    install("system", SYSTEM);
    install("feature", FEATURE);
    repo.ok("start", "sys", "--workflow", "system");
    repo.write("docs/sys-order.md");
    repo.write("docs/sys-design.md");
  });

  test("the completion block names each hand-off with the command that starts it after this workstream", () => {
    const done = repo.ok("continue", "sys");
    expect(done).toContain("STATUS: workflow complete");
    expect(done).toContain(
      "NEXT STEP: <what the owner may want next, with the workflow that comes after this one where it applies: feature (once per entry of the build order)>",
    );
    expect(done).toContain(
      "  - This workflow hands off to feature, once per entry of the build order. Offer it to the owner where that applies, " +
        "and do not mention it where it does not; start it only once the owner agrees, with " +
        "`fuse-flow start <new-slug> --workflow feature --after sys`, which gives it this workstream's documents.",
    );
    // Nothing starts on its own.
    expect(repo.ok("list")).not.toContain("after sys");
  });

  test("a hand-off without a when text is offered to the owner with no condition", () => {
    install("system", SYSTEM.replace("  - workflow: feature\n    when: once per entry of the build order\n", "  - feature\n"));
    repo.ok("start", "sys-2", "--workflow", "system");
    repo.write("docs/sys-2-order.md");
    repo.write("docs/sys-2-design.md");
    const done = repo.ok("continue", "sys-2");
    expect(done).toContain("NEXT STEP: <what the owner may want next, with the workflow that comes after this one where it applies: feature>");
    expect(done).toContain(
      "  - This workflow hands off to feature. Offer it to the owner; start it only once the owner agrees, with " +
        "`fuse-flow start <new-slug> --workflow feature --after sys-2`, which gives it this workstream's documents.",
    );
  });

  test("--after binds each declared input to the earlier workstream's document of the same id; --input wins", () => {
    repo.ok("continue", "sys");
    repo.write("docs/my-order.md");
    const out = repo.ok("start", "feat", "--workflow", "feature", "--after", "sys", "--input", "build-order=docs/my-order.md");
    expect(out).toContain("after:    sys\n");
    expect(out).toContain("inputs:   build-order=docs/my-order.md, system-design=docs/sys-design.md, brief (not given)\n");
    expect(out).toContain("READ docs/my-order.md (input build-order).");
    expect(out).toContain("READ docs/sys-design.md (input system-design).");
    expect(out).toContain("READ brief: not given; the workstream was started without this input, so do the step without it.");
    expect(repo.state("feat")).toMatchObject({ after: "sys", inputs: { "build-order": "docs/my-order.md", "system-design": "docs/sys-design.md" } });

    // Each side of the link shows it.
    expect(repo.ok("status", "feat")).toContain("workstream feat (feature)\n  after: sys\n  inputs: build-order=docs/my-order.md");
    expect(repo.ok("status", "sys")).toContain("\nstarted after it: feat");
    expect(repo.ok("list")).toContain("  feat (feature, started ");
    expect(repo.ok("list")).toMatch(/feat \(feature, started \d{4}-\d{2}-\d{2}, after sys\)/);
  });

  test("an input passes on to a workstream started after the one it was given to", () => {
    repo.ok("continue", "sys");
    repo.ok("start", "feat", "--workflow", "feature", "--after", "sys");
    expect(repo.ok("start", "feat-2", "--workflow", "feature", "--after", "feat")).toContain(
      "inputs:   build-order=docs/sys-order.md, system-design=docs/sys-design.md, brief (not given)\n",
    );
  });

  test("an input path that does not exist is shown as missing, not refused", () => {
    const out = repo.ok("start", "feat", "--workflow", "feature", "--input", "system-design=docs/later.md");
    expect(out).toContain("READ docs/later.md (input system-design). It does not exist, for example because earlier steps were skipped.");
  });

  test("start refuses a required input that stays unbound, an undeclared input, and inputs for a workstream that exists", () => {
    expect(repo.refused("start", "feat", "--workflow", "feature")).toContain(
      "workflow feature requires the input system-design; give it with --input <id>=<path> or --after <earlier workstream>",
    );
    // sys has not recorded its design yet.
    expect(repo.refused("start", "feat", "--workflow", "feature", "--after", "sys")).toContain(
      "workflow feature requires the input system-design, and workstream sys has no document of that id",
    );
    expect(repo.refused("start", "feat", "--workflow", "feature", "--input", "design=x.md")).toContain(
      "--input design: workflow feature declares no such input (its inputs: build-order, system-design, brief)",
    );
    expect(repo.refused("start", "feat", "--workflow", "feature", "--after", "nope")).toContain('--after nope: no workstream "nope"');
    expect(repo.usage("start", "feat", "--workflow", "feature", "--input", "no-equals-sign")).toContain("--input takes <artifact-id>=<path>");
    expect(existsSync(join(repo.root, ".konductor/workstreams/feat.yml"))).toBe(false);

    repo.ok("start", "feat", "--workflow", "feature", "--input", "system-design=docs/sys-design.md");
    expect(repo.refused("start", "feat", "--after", "sys")).toContain("workstream feat exists; --after and --input bind inputs only when a workstream starts");
  });

  test("validate accepts input ids in consumes, refuses an input a step writes, and checks hand-off targets", () => {
    repo.write("ok.yml", FEATURE);
    expect(repo.ok("validate", "ok.yml")).toContain("valid:   ");
    repo.write(
      "writes-input.yml",
      `version: 1
name: writes-input
inputs:
  - artifact: brief
steps:
  - id: a
    instruction: Do it.
    produces: { artifact: brief, path: brief.md }
`,
    );
    expect(repo.refused("validate", "writes-input.yml")).toContain('"a" writes "brief", which is an input of the workflow; name the input differently');
    repo.write("lost.yml", `version: 1\nname: lost\nhands_off_to: nowhere\nsteps:\n  - id: a\n    instruction: Do it.\n`);
    expect(repo.refused("validate", "lost.yml")).toContain('hands_off_to nowhere: no workflow named "nowhere"');
    // A target that takes none of this workflow's documents is only a warning.
    repo.write("unrelated.yml", `version: 1\nname: unrelated\nhands_off_to: feature\nsteps:\n  - id: a\n    instruction: Do it.\n`);
    const warned = repo.ok("validate", "unrelated.yml");
    expect(warned).toContain("valid:   ");
    expect(warned).toContain("warning: hands_off_to feature: it declares no input this workflow produces, so --after gives it nothing");
  });
});

test("a file the owner moved and the producer rewrote in a later pass is read, and handed on, at its new path only", () => {
  install(
    "source",
    `version: 1\nname: source\nsteps:\n  - id: author\n    instruction: Write the specification.\n    produces: { artifact: specification, path: drafts/spec.md }\n    gates:\n      - owner-action: approve the specification\n  - id: consumer\n    instruction: Build to the specification.\n    consumes: [specification]\n`,
  );
  install("target", `version: 1\nname: target\ninputs:\n  - artifact: specification\n    required: true\nsteps:\n  - id: build\n    instruction: Build it.\n    consumes: [specification]\n`);
  repo.ok("start", "src", "--workflow", "source");
  repo.write("drafts/spec.md", "behaviour A\n");
  repo.ok("continue", "src");
  repo.write(".konductor/policy-overrides.yml", "artifacts:\n  specification:\n    path: approved/spec.md\n");
  repo.ok("continue", "src", "--back-to", "author", "--note", "Use approved/spec.md for the rewritten specification.");
  repo.write("approved/spec.md", "behaviour B\n");
  repo.ok("continue", "src");
  const local = repo.ok("continue", "src", "--owner-approved", "--note", "Approve behaviour B.");
  expect(local).toContain("READ approved/spec.md (from step author).");
  expect(local).not.toContain("drafts/spec.md");
  // The earlier pass's file stays in the step's history.
  expect(repo.state("src").steps.author.files.map((f: any) => f.path)).toContain("drafts/spec.md");
  const after = repo.ok("start", "tgt", "--workflow", "target", "--after", "src");
  expect(after).toContain("READ approved/spec.md (input specification).");
  expect(repo.state("tgt").inputs).toEqual({ specification: "approved/spec.md" });
});

test("a file an earlier fuse-flow recorded, then moved by the owner and rewritten, is read and handed on at its new path only", () => {
  install(
    "source",
    `version: 1\nname: source\nsteps:\n  - id: author\n    instruction: Write the specification.\n    produces: { artifact: specification, path: drafts/spec.md }\n    gates:\n      - owner-action: approve the specification\n  - id: consumer\n    instruction: Build to the specification.\n    consumes: [specification]\n`,
  );
  install("target", `version: 1\nname: target\ninputs:\n  - artifact: specification\n    required: true\nsteps:\n  - id: build\n    instruction: Build it.\n    consumes: [specification]\n`);
  repo.ok("start", "src", "--workflow", "source");
  repo.write("drafts/spec.md", "behaviour A\n");
  repo.ok("continue", "src");
  // A state file an earlier fuse-flow wrote kept only the records, without files.
  const old = repo.state("src");
  delete old.steps.author.files;
  repo.write(join(".konductor", "workstreams", "src.yml"), Bun.YAML.stringify(old, null, 2));
  repo.write(".konductor/policy-overrides.yml", "artifacts:\n  specification:\n    path: approved/spec.md\n");
  repo.ok("continue", "src", "--back-to", "author", "--note", "Use approved/spec.md for the rewritten specification.");
  repo.write("approved/spec.md", "behaviour B\n");
  repo.ok("continue", "src");
  const local = repo.ok("continue", "src", "--owner-approved", "--note", "Approve behaviour B.");
  expect(local).toContain("READ approved/spec.md (from step author).");
  expect(local).not.toContain("drafts/spec.md");
  expect(repo.state("src").steps.author.files.map((f: any) => f.path)).toContain("drafts/spec.md");
  const after = repo.ok("start", "tgt", "--workflow", "target", "--after", "src");
  expect(after).toContain("READ approved/spec.md (input specification).");
  expect(repo.state("tgt").inputs).toEqual({ specification: "approved/spec.md" });
});

describe("a document inside a folder the same step updates", () => {
  // The report lies inside the code the step updates.
  const BUILD = `version: 1
name: build
steps:
  - id: implementation
    instruction: Make the change and write the report.
    produces:
      - artifact: implementation-report
        path: docs/{slug}-report.md
    updates:
      - artifact: code
        path: .
    gates:
      - owner-action: approve the change
`;
  const FOLLOWUP = `version: 1
name: followup
inputs:
  - artifact: implementation-report
    required: true
steps:
  - id: follow
    instruction: Follow up on the report.
    consumes: [implementation-report]
`;

  beforeEach(() => {
    install("build", BUILD);
    install("followup", FOLLOWUP);
    repo.ok("start", "b", "--workflow", "build");
    repo.write("docs/b-report.md");
    repo.write("src/a.ts");
  });

  const records = [
    { artifact: "implementation-report", path: "docs/b-report.md", status: "approved" },
    { artifact: "code", path: ".", status: "approved" },
  ];

  test("a finished step records the document, and --after finds it by its id", () => {
    repo.ok("continue", "b", "--updated", "src/a.ts");
    repo.ok("continue", "b", "--owner-approved");
    const out = repo.ok("start", "next", "--workflow", "followup", "--after", "b");
    expect(out).toContain("inputs:   implementation-report=docs/b-report.md\n");
    expect(out).toContain("READ docs/b-report.md (input implementation-report).");
    expect(repo.state("b").steps.implementation.artifacts).toEqual(records);
  });

  test("a blocked step records the document, and once the owner approves it --after finds it by its id", () => {
    repo.ok("continue", "b", "--blocked", "waiting on a decision", "--updated", "src/a.ts");
    repo.ok("continue", "b", "--owner-approved");
    expect(repo.ok("start", "next", "--workflow", "followup", "--after", "b")).toContain("inputs:   implementation-report=docs/b-report.md\n");
    expect(repo.state("b").steps.implementation.artifacts).toEqual(records);
  });
});

describe("delegation gate", () => {
  const CHILD = `version: 1
name: child
inputs:
  - artifact: given-diff
steps:
  - id: review
    instruction: Review the diff.
    consumes: [given-diff]
    produces: { artifact: report, path: "reports/{slug}.md" }
    gates:
      - owner-action: approve the report
`;
  const PARENT = `version: 1
name: parent
steps:
  - id: intake
    instruction: Write the diff.
    produces: { artifact: diff, path: "diffs/{slug}.diff" }
  - id: adversarial
    instruction: Merge the new findings.
    gates:
      - workflow: child
        slug: "{slug}-adv"
        inputs: { given-diff: diff }
        returns: { findings: report }
  - id: summary
    instruction: Summarize.
    consumes: [findings]
`;

  beforeEach(() => install("child", CHILD));

  function toDelegation(): string {
    repo.start("pr", PARENT);
    repo.write("diffs/pr.diff");
    return repo.ok("continue", "pr");
  }

  function finishChild(slug = "pr-adv") {
    repo.ok("start", slug);
    repo.write(`reports/${slug}.md`);
    repo.ok("continue", slug);
    return repo.ok("continue", slug, "--owner-approved");
  }

  test("handing out the step creates the child once, with its inputs bound, and says to run it first", () => {
    const out = toDelegation();
    expect(out).toContain(
      "DELEGATE: this step waits for workstream pr-adv, which follows workflow child and was created for it, given given-diff. " +
        "First run it to its end: `fuse-flow start pr-adv` prints its current step.",
    );
    expect(out).toContain("RETURNS findings: workstream pr-adv's report, once pr-adv is complete; read it then.");
    expect(out).toContain("  1. Make sure workstream pr-adv is complete. fuse-flow checks it on continue and refuses the step until it is.");
    expect(repo.state("pr-adv")).toMatchObject({ workflow: "child", parent: { slug: "pr", step: "adversarial" }, inputs: { "given-diff": "diffs/pr.diff" } });
    expect(repo.state("pr").steps.adversarial.children).toEqual([{ pass: 1, slug: "pr-adv" }]);
    // Created, not started: nothing has been handed out in it.
    expect(repo.status("pr-adv", "review")).toBe("PENDING");

    // Printing the step again does not create another child.
    repo.ok("start", "pr");
    expect(repo.state("pr").steps.adversarial.children).toHaveLength(1);
    expect(repo.state("pr").steps.adversarial.history.filter((h: string) => h.includes("created child workstream"))).toHaveLength(1);

    const child = repo.ok("start", "pr-adv");
    expect(child).toContain("parent:   step adversarial of workstream pr, which waits for this one\n");
    expect(child).toContain("READ diffs/pr.diff (input given-diff).");
  });

  test("continue is refused while the child is not complete, in each of its states, and passes once it is", () => {
    toDelegation();
    expect(repo.refused("continue", "pr")).toContain(
      "workstream pr-adv, which this step waits for, has not been started. Run it to its end with `fuse-flow start pr-adv`, then continue this step.",
    );
    repo.ok("start", "pr-adv");
    expect(repo.refused("continue", "pr")).toContain("workstream pr-adv, which this step waits for, is at step review (1 of 1), IN_PROGRESS.");
    expect(repo.ok("status", "pr")).toContain("waits for workstream pr-adv, which is at step review (1 of 1), IN_PROGRESS");

    repo.ok("continue", "pr-adv", "--blocked", "the diff is empty");
    expect(repo.refused("continue", "pr")).toContain("is at step review (1 of 1), which is blocked: the diff is empty.");

    repo.ok("continue", "pr-adv", "--back-to", "review", "--note", "try again");
    repo.write("reports/pr-adv.md");
    repo.ok("continue", "pr-adv");
    expect(repo.refused("continue", "pr")).toContain("is at step review (1 of 1), which awaits the owner: approve the report.");
    expect(repo.state("pr").steps.adversarial.history.at(-1)).toContain("continue refused: workstream pr-adv");

    // The child's completion block sends the agent back to the parent.
    const done = repo.ok("continue", "pr-adv", "--owner-approved");
    expect(done).toContain("  - Step adversarial of workstream pr waits for this workstream. Go on there: `fuse-flow start pr` prints that step, with what this workstream returns to it.");

    expect(repo.ok("start", "pr")).toContain("READ reports/pr-adv.md (findings, returned by workstream pr-adv).");
    const next = repo.ok("continue", "pr");
    expect(repo.status("pr", "adversarial")).toBe("COMPLETED");
    expect(repo.state("pr").steps.adversarial.verification).toEqual(["workstream pr-adv (child): complete"]);
    // The later step reads the child's document.
    expect(next).toContain("READ reports/pr-adv.md (findings, returned by workstream pr-adv, the child of step adversarial).");
  });

  test("a send-back past the delegating step creates a fresh child and leaves the earlier one as it was", () => {
    toDelegation();
    finishChild();
    repo.ok("continue", "pr");
    const before = repo.read(".konductor/workstreams/pr-adv.yml");

    const back = repo.ok("continue", "pr", "--back-to", "adversarial", "--note", "review again");
    expect(back).toContain("DELEGATE: this step waits for workstream pr-adv-2,");
    expect(repo.state("pr").steps.adversarial.children).toEqual([
      { pass: 1, slug: "pr-adv" },
      { pass: 2, slug: "pr-adv-2" },
    ]);
    expect(repo.refused("continue", "pr")).toContain("workstream pr-adv-2, which this step waits for, has not been started.");

    finishChild("pr-adv-2");
    expect(repo.read(".konductor/workstreams/pr-adv.yml")).toBe(before);
    const next = repo.ok("continue", "pr");
    expect(next).toContain("READ reports/pr-adv-2.md (findings, returned by workstream pr-adv-2, the child of step adversarial).");
  });

  test("a skipped delegating step leaves no child", () => {
    const conditional = PARENT.replace("  - id: adversarial\n", "  - id: adversarial\n    condition: { agent: the change is not trivial }\n");
    repo.start("pr", conditional);
    repo.write("diffs/pr.diff");
    const out = repo.ok("continue", "pr");
    expect(out).toContain("If this step does not apply, skip it before you start pr-adv; fuse-flow then removes pr-adv, since nothing has happened in it.");
    expect(existsSync(join(repo.root, ".konductor/workstreams/pr-adv.yml"))).toBe(true);

    const skipped = repo.ok("continue", "pr", "--skip", "a one-line change");
    expect(skipped).toContain("Removed the child workstream pr-adv, in which nothing had happened.");
    expect(existsSync(join(repo.root, ".konductor/workstreams/pr-adv.yml"))).toBe(false);
    expect(repo.state("pr").steps.adversarial.children).toBeUndefined();
    expect(skipped).toContain("READ findings: step adversarial was skipped (a one-line change), so no child workstream returned it and there is nothing to read.");
  });

  test("a child slug taken by another workstream is refused, naming both", () => {
    install("other", `version: 1\nname: other\nsteps:\n  - id: a\n    instruction: Do it.\n`);
    repo.ok("start", "pr-adv", "--workflow", "other");
    repo.start("pr", PARENT);
    repo.write("diffs/pr.diff");
    expect(repo.ok("continue", "pr")).toContain(
      "step adversarial waits for a child workstream pr-adv that follows child, but workstream pr-adv exists and follows other.",
    );
    // Completing the unrelated workstream does not satisfy the gate.
    repo.ok("continue", "pr-adv");
    expect(repo.refused("continue", "pr")).toContain("but workstream pr-adv exists and follows other.");
    expect(repo.status("pr", "adversarial")).toBe("IN_PROGRESS");
    // Nor does the owner's acceptance of the blocked step.
    expect(repo.ok("continue", "pr", "--blocked", "the child slug is taken")).toContain("  - Skip this step, without what workstream pr-adv would return.");
    expect(repo.refused("continue", "pr", "--owner-approved")).toContain("step adversarial cannot complete yet: step adversarial waits for a child workstream pr-adv");
    expect(repo.status("pr", "adversarial")).toBe("BLOCKED");
  });

  test("the owner cannot approve a blocked delegating step while its child is unfinished; skipping it is the way past", () => {
    toDelegation();
    repo.ok("start", "pr-adv");
    const blocked = repo.ok("continue", "pr", "--blocked", "the child needs a decision");
    expect(blocked).not.toContain("  - Accept the step as it is.");
    expect(blocked).toContain("  - Skip this step, without what workstream pr-adv would return.");
    expect(blocked).toContain('  - The owner skips the step: run `fuse-flow continue pr --skip "<the owner\'s reason>"`.');
    expect(repo.refused("continue", "pr", "--owner-approved")).toContain(
      "step adversarial cannot complete yet: workstream pr-adv, which this step waits for, is at step review (1 of 1), IN_PROGRESS. " +
        "To go on without it, the owner skips the step",
    );
    expect(repo.status("pr", "adversarial")).toBe("BLOCKED");

    // Once the child is complete, the owner may accept the blocked step.
    repo.write("reports/pr-adv.md");
    repo.ok("continue", "pr-adv");
    repo.ok("continue", "pr-adv", "--owner-approved");
    expect(repo.ok("start", "pr")).toContain("  - Accept the step as it is.");
    repo.ok("continue", "pr", "--owner-approved");
    expect(repo.status("pr", "adversarial")).toBe("COMPLETED");
  });

  test("a returned id resolves to the newest child's document, even when an earlier step wrote the same id", () => {
    install("next", `version: 1\nname: next\ninputs:\n  - artifact: findings\nsteps:\n  - id: a\n    instruction: Read it.\n    consumes: [findings]\n`);
    const shadowing = PARENT.replace("produces: { artifact: diff,", "produces: [{ artifact: findings, path: early.md }, { artifact: diff,").replace(
      'path: "diffs/{slug}.diff" }',
      'path: "diffs/{slug}.diff" }]',
    );
    repo.start("pr", shadowing);
    repo.write("early.md");
    repo.write("diffs/pr.diff");
    repo.ok("continue", "pr");
    repo.ok("start", "pr-adv");
    repo.ok("continue", "pr-adv", "--not-produced", "report", "no findings");
    repo.ok("continue", "pr-adv", "--owner-approved");
    expect(repo.ok("continue", "pr")).toContain("READ findings: workstream pr-adv, the child of step adversarial, recorded no report, so there is nothing to read.");
    repo.ok("continue", "pr");
    // --after agrees with what the step block said: nothing, not the earlier early.md.
    expect(repo.ok("start", "n", "--workflow", "next", "--after", "pr")).toContain("inputs:   findings (not given)");
    expect(repo.state("pr").steps.intake.artifacts.map((a: any) => a.path)).toContain("early.md");
  });

  test("a skipped delegating step returns nothing, even when an earlier step wrote the same id", () => {
    install("next", `version: 1\nname: next\ninputs:\n  - artifact: findings\nsteps:\n  - id: a\n    instruction: Read it.\n    consumes: [findings]\n`);
    const shadowing = PARENT.replace("produces: { artifact: diff,", "produces: [{ artifact: findings, path: early.md }, { artifact: diff,")
      .replace('path: "diffs/{slug}.diff" }', 'path: "diffs/{slug}.diff" }]')
      .replace("  - id: adversarial\n", "  - id: adversarial\n    condition: { agent: the change is not trivial }\n");
    repo.start("pr", shadowing);
    repo.write("early.md");
    repo.write("diffs/pr.diff");
    repo.ok("continue", "pr");
    expect(repo.ok("continue", "pr", "--skip", "trivial")).toContain("READ findings: step adversarial was skipped (trivial), so no child workstream returned it");
    repo.ok("continue", "pr");
    expect(repo.ok("start", "n", "--workflow", "next", "--after", "pr")).toContain("inputs:   findings (not given)");
  });

  test("an unfinished delegating step returns nothing yet, even when an earlier step wrote the same id", () => {
    install("next", `version: 1\nname: next\ninputs:\n  - artifact: findings\nsteps:\n  - id: a\n    instruction: Read it.\n    consumes: [findings]\n`);
    const shadowing = PARENT.replace("produces: { artifact: diff,", "produces: [{ artifact: findings, path: early.md }, { artifact: diff,").replace(
      'path: "diffs/{slug}.diff" }',
      'path: "diffs/{slug}.diff" }]',
    );
    repo.start("pr", shadowing);
    repo.write("early.md");
    repo.write("diffs/pr.diff");
    repo.ok("continue", "pr");
    expect(repo.status("pr", "adversarial")).toBe("IN_PROGRESS");
    expect(repo.ok("start", "n", "--workflow", "next", "--after", "pr")).toContain("inputs:   findings (not given)");
    repo.ok("continue", "pr", "--blocked", "the child needs a decision");
    expect(repo.ok("start", "n-2", "--workflow", "next", "--after", "pr")).toContain("inputs:   findings (not given)");
  });

  test("a required child input with no document refuses the hand-out", () => {
    install("child", CHILD.replace("  - artifact: given-diff\n", "  - artifact: given-diff\n    required: true\n"));
    repo.start("pr", PARENT);
    expect(repo.ok("continue", "pr", "--not-produced", "diff", "nothing changed")).toContain(
      "STEP adversarial (2 of 3) waits for a child workstream that cannot be created: step adversarial cannot create its child " +
        "workstream pr-adv: child requires given-diff, and this workstream has no document to give it.",
    );
    expect(existsSync(join(repo.root, ".konductor/workstreams/pr-adv.yml"))).toBe(false);
    expect(repo.refused("continue", "pr")).toContain(
      "workstream pr-adv, which this step waits for, cannot be created: step adversarial cannot create its child workstream pr-adv: child requires given-diff",
    );
    repo.ok("continue", "pr", "--blocked", "no diff to review");
  });

  test("a child whose own workflow refers to other workflows wrongly is not created", () => {
    install("child", CHILD.replace("steps:\n", "hands_off_to: nowhere\nsteps:\n"));
    repo.start("pr", PARENT);
    repo.write("diffs/pr.diff");
    expect(repo.ok("continue", "pr")).toContain(
      'waits for a child workstream that cannot be created: workflow child cannot start: hands_off_to nowhere: no workflow named "nowhere"',
    );
    expect(existsSync(join(repo.root, ".konductor/workstreams/pr-adv.yml"))).toBe(false);
  });

  test("validate checks the gate against its child: inputs, required inputs, returns, and cycles", () => {
    const step = (gate: string) => `version: 1\nname: p\nsteps:\n  - id: a\n    instruction: Do it.\n    produces: { artifact: diff, path: d.diff }\n  - id: b\n    instruction: Wait.\n    gates:\n${gate}`;
    repo.write("unknown.yml", step("      - workflow: missing\n"));
    expect(repo.refused("validate", "unknown.yml")).toContain('step b, workflow missing: no workflow named "missing"');
    repo.write("bad-input.yml", step("      - workflow: child\n        inputs: { diff: diff }\n"));
    expect(repo.refused("validate", "bad-input.yml")).toContain('step b, workflow child: inputs names "diff", which child does not declare as an input');
    repo.write("bad-return.yml", step("      - workflow: child\n        returns: [verdict]\n"));
    expect(repo.refused("validate", "bad-return.yml")).toContain('step b, workflow child: returns "verdict" from "verdict", which child neither writes, returns nor takes as an input');
    repo.write("late-input.yml", step("      - workflow: child\n        inputs: { given-diff: later }\n"));
    expect(repo.refused("validate", "late-input.yml")).toContain('"b" gives its child "later", which no step before it produces or updates');
    repo.write("two.yml", step("      - workflow: child\n      - workflow: child\n"));
    expect(repo.refused("validate", "two.yml")).toContain('"b" has 2 workflow gates; a step waits for one child');
    repo.write("clash.yml", step("      - workflow: child\n        returns: [report]\n").replace("artifact: diff", "artifact: report"));
    expect(repo.ok("validate", "clash.yml")).toContain("valid:");

    install("child", CHILD.replace("  - artifact: given-diff\n", "  - artifact: given-diff\n    required: true\n"));
    repo.write("unbound.yml", step("      - workflow: child\n"));
    expect(repo.refused("validate", "unbound.yml")).toContain('step b, workflow child: child requires the input "given-diff", and the gate\'s inputs do not give it');

    // a waits for b, which waits for a.
    install("loop-a", `version: 1\nname: loop-a\nsteps:\n  - id: x\n    instruction: Wait.\n    gates: { workflow: loop-b }\n`);
    install("loop-b", `version: 1\nname: loop-b\nsteps:\n  - id: y\n    instruction: Wait.\n    gates: { workflow: loop-a }\n`);
    expect(repo.refused("validate", "loop-a")).toContain(
      "step x, workflow loop-b: the workflow gates lead back to this workflow (loop-a -> loop-b -> loop-a), so it would wait for itself",
    );
    expect(repo.refused("start", "l", "--workflow", "loop-a")).toContain("workflow loop-a cannot start:");
  });

  test("at run time, a child whose chain of parents already follows its workflow is refused", () => {
    install("outer", `version: 1\nname: outer\nsteps:\n  - id: x\n    instruction: Wait.\n    gates: { workflow: inner }\n`);
    install("inner", `version: 1\nname: inner\nsteps:\n  - id: y\n    instruction: Work.\n`);
    repo.ok("start", "o", "--workflow", "outer");
    // The inner workflow changes after the start, so that it waits for outer.
    install("inner", `version: 1\nname: inner\nsteps:\n  - id: y\n    instruction: Wait.\n    gates: { workflow: outer }\n`);
    expect(repo.ok("start", "o-x")).toContain("a child following outer would wait for itself: the chain of parents outer -> inner already follows it");
  });

  test("a gate field on another kind, and a workflow as a condition, are refused", () => {
    const one = (rest: string) => `version: 1\nname: w\nsteps:\n  - id: a\n    instruction: Do it.\n${rest}`;
    repo.write("a.yml", one("    gates:\n      - agent: review it\n        returns: [x]\n"));
    expect(repo.refused("validate", "a.yml")).toContain("returns goes on a workflow gate only");
    repo.write("b.yml", one("    condition: { workflow: child }\n"));
    expect(repo.refused("validate", "b.yml")).toContain("a condition cannot be a workflow");
    repo.write("c.yml", one("    gates:\n      - workflow: child\n        slug: fixed-name\n"));
    expect(repo.refused("validate", "c.yml")).toContain("slug is a template that contains {slug}");
  });
});

// Every JavaScript object inherits a property named "constructor", and
// "constructor" is a valid artifact id and check kind. Only what a workflow,
// the command line or the policy actually gives counts.
describe("an id that every object has as a property", () => {
  test("an input named constructor is bound only when it is given, and a required one is refused when it is not", () => {
    const W = `version: 1
name: w
inputs:
  - artifact: constructor
  - artifact: brief
steps:
  - id: a
    instruction: Read it.
    consumes: [constructor]
`;
    install("w", W);
    repo.write("c.md");
    repo.write("b.md");
    const out = repo.ok("start", "x", "--workflow", "w", "--input", "brief=b.md");
    expect(out).toContain("inputs:   constructor (not given), brief=b.md\n");
    expect(out).toContain("READ constructor: not given; the workstream was started without this input, so do the step without it.");
    expect(repo.ok("start", "y", "--workflow", "w", "--after", "x")).toContain("inputs:   constructor (not given), brief=b.md\n");
    const given = repo.ok("start", "z", "--workflow", "w", "--input", "constructor=c.md");
    expect(given).toContain("inputs:   constructor=c.md, brief (not given)\n");
    expect(given).toContain("READ c.md (input constructor).");

    install("w", W.replace("  - artifact: constructor\n", "  - artifact: constructor\n    required: true\n"));
    expect(repo.refused("start", "r", "--workflow", "w")).toContain("workflow w requires the input constructor; give it with --input <id>=<path>");
    expect(repo.refused("start", "r", "--workflow", "w", "--after", "x")).toContain(
      "workflow w requires the input constructor, and workstream x has no document of that id",
    );
  });

  test("a child's required input named constructor must be given, by validate and when the child is created", () => {
    install("child", `version: 1\nname: child\ninputs:\n  - artifact: constructor\n    required: true\nsteps:\n  - id: a\n    instruction: Work.\n`);
    const parent = (gate: string) =>
      `version: 1\nname: p\nsteps:\n  - id: a\n    instruction: Do it.\n    produces: { artifact: diff, path: d.diff }\n  - id: b\n    instruction: Wait.\n    gates:\n${gate}`;
    repo.write("unbound.yml", parent("      - workflow: child\n"));
    expect(repo.refused("validate", "unbound.yml")).toContain('step b, workflow child: child requires the input "constructor", and the gate\'s inputs do not give it');

    repo.start("pr", parent("      - workflow: child\n        inputs: { constructor: diff }\n"));
    expect(repo.ok("continue", "pr", "--not-produced", "diff", "nothing changed")).toContain(
      "step b cannot create its child workstream pr-b: child requires constructor, and this workstream has no document to give it.",
    );
    expect(existsSync(join(repo.root, ".konductor/workstreams/pr-b.yml"))).toBe(false);
  });

  test("a document named constructor is read from the step that wrote it, past a delegating step that does not return it", () => {
    install("child", `version: 1\nname: child\nsteps:\n  - id: r\n    instruction: Review.\n    produces: { artifact: report, path: "reports/{slug}.md" }\n`);
    install("next", `version: 1\nname: next\ninputs:\n  - artifact: constructor\nsteps:\n  - id: a\n    instruction: Read it.\n`);
    repo.start(
      "pr",
      `version: 1
name: p
steps:
  - id: intake
    instruction: Write it.
    produces: { artifact: constructor, path: "docs/{slug}.md" }
  - id: delegate
    instruction: Wait.
    gates:
      - workflow: child
        returns: { findings: report }
  - id: summary
    instruction: Summarize.
    consumes: [constructor]
`,
    );
    repo.write("docs/pr.md");
    repo.ok("continue", "pr");
    repo.ok("start", "pr-delegate");
    repo.write("reports/pr-delegate.md");
    repo.ok("continue", "pr-delegate");
    expect(repo.ok("continue", "pr")).toContain("READ docs/pr.md (from step intake).");
    expect(repo.ok("start", "n", "--workflow", "next", "--after", "pr")).toContain("inputs:   constructor=docs/pr.md\n");
  });

  test("a produced artifact named constructor is missing until it is written, and is then read from its step", () => {
    repo.start(
      "x",
      `version: 1\nname: w\nsteps:\n  - id: a\n    instruction: Write it.\n    produces: { artifact: constructor, path: c.md }\n  - id: b\n    instruction: Read it.\n    consumes: [constructor]\n`,
    );
    expect(repo.refused("continue", "x")).toStartWith("REFUSED: missing artifact(s): c.md (constructor).");
    repo.write("c.md");
    expect(repo.ok("continue", "x")).toContain("READ c.md (from step a).");
    expect(repo.state("x").steps.a.artifacts.map((a: any) => a.path)).toEqual(["c.md"]);
  });

  test("a check kind named constructor is unbound until the policy binds it", () => {
    repo.write(".konductor/policy-overrides.yml", "checks:\n  default: echo team\n");
    const out = repo.start("x", `version: 1\nname: w\nsteps:\n  - id: a\n    instruction: Build it.\n    gates:\n      - check: constructor\n`);
    expect(out).toContain("  1. This project has no command for the constructor check yet.");
  });

  test("an artifact named constructor can be reported not produced, and unchanged", () => {
    repo.start(
      "x",
      `version: 1\nname: w\nsteps:\n  - id: a\n    instruction: Write it.\n    produces: { artifact: constructor, path: c.md }\n  - id: b\n    instruction: Revise it.\n    updates: { artifact: constructor, path: c.md }\n`,
    );
    repo.ok("continue", "x", "--not-produced", "constructor", "nothing to write");
    expect(repo.state("x").steps.a.not_produced).toEqual({ constructor: "nothing to write" });
    repo.ok("continue", "x", "--unchanged", "constructor", "nothing to revise");
    expect(repo.state("x").steps.b.unchanged).toEqual({ constructor: "nothing to revise" });
    expect(repo.status("x", "b")).toBe("COMPLETED");
  });

  test("a policy can bind a check kind named constructor and place an artifact named constructor", () => {
    repo.write(".konductor/policy-overrides.yml", 'checks:\n  constructor: "true"\nartifacts:\n  constructor:\n    path: docs/c.md\n');
    const out = repo.start("x", `version: 1\nname: w\nsteps:\n  - id: a\n    instruction: Write it.\n    produces: { artifact: constructor, path: c.md }\n    gates:\n      - check: constructor\n`);
    expect(out).toContain("PRODUCE docs/c.md (constructor)");
    repo.write("docs/c.md");
    repo.ok("continue", "x");
    expect(repo.state("x").steps.a.verification).toEqual(["check constructor (`true`): passed"]);
  });
});
