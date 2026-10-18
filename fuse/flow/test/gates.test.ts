// SPDX-License-Identifier: Apache-2.0
// Gates: steps that wait for the owner, checks bound through policy, literal
// script gates, agent gates and their round cap, steps the agent reports as
// blocked, and the owner's decisions on them.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

// What every agent gate says about starting the reviewer and where its findings go.
const SCHEMA = join(FLOW_DIR, "workflows", "schemas", "review-findings.schema.json");
const subagent = (findings: string) =>
  "Start the reviewer the way the house rules ask, such as a review command they name, or else as a fresh " +
  "subagent in your own harness, with none of your context. The reviewer writes " +
  `its findings to ${findings}, where <n> is the round, following ${SCHEMA}; read them from there. `;

const GATED = `version: 1
name: gated
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
    gates:
      - owner-action: approve the design
  - id: build
    instruction: Make the tests pass.
    gates:
      - script: test -f tests.pass
  - id: release
    instruction: Release it.
`;

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.start("feat", GATED);
});
afterEach(() => repo.cleanup());

function approveDesign() {
  repo.write("design.md");
  repo.ok("continue", "feat");
  repo.ok("continue", "feat", "--owner-approved");
}

test("an owner gate holds the step and prints the pre-filled hand-over block until the owner approves", () => {
  repo.write("design.md");
  const recorded = repo.ok("continue", "feat");
  expect(recorded).toStartWith("design: work recorded; the step awaits the owner's action\n\nOWNER'S TURN: end your message with this hand-over block.");
  expect(recorded).toContain("SUMMARY: <the task you worked on, in a sentence>. Workstream feat, step design, 1 of 3.\n");
  expect(recorded).toContain("STATUS: awaiting owner action. The owner is asked to approve the design.\n");
  expect(recorded).toContain("PRODUCED: design.md (new)\n");
  expect(recorded).toContain("VERIFICATION: none\n");
  // The owner sees the options in plain words; the commands come after the block, for the agent only.
  expect(recorded).toContain("NEXT STEP:\n  - Approve the design.\n  - Send the work back to redo this step, with what to change.\nDECISIONS: ");
  expect(recorded).toContain("so its checks and reviews run again.\n\nFOR YOU, NOT FOR THE OWNER:");
  const block = recorded.slice(0, recorded.indexOf("FOR YOU, NOT FOR THE OWNER:"));
  expect(block.split("\n").filter((l) => /^(SUMMARY|STATUS|PRODUCED|VERIFICATION|NEXT STEP|  - )/.test(l)).join("\n")).not.toContain("fuse-flow");
  expect(recorded).toContain(
    '\n  - The owner does what the step asks (approve the design): run `fuse-flow continue feat --owner-approved --note "<what the owner said>"`.\n',
  );
  expect(recorded).toContain("To rework an artifact, name the step that produces it: design (design.md).");
  expect(repo.status("feat", "design")).toBe("AWAITING_OWNER");
  expect(repo.state("feat").steps.design.artifacts).toEqual([{ artifact: "sketch", path: "design.md", status: "draft" }]);

  // Without the owner's word the workstream does not move.
  expect(repo.refused("continue", "feat")).toContain('step "design" is AWAITING_OWNER; only the owner can move it on');
  expect(repo.ok("start", "feat")).toContain("STATUS: awaiting owner action.");

  // A status line in the file, which the reminder below names.
  repo.write("design.md", "Status: draft\n");
  const approved = repo.ok("continue", "feat", "--owner-approved", "--note", "looks good");
  // The sketch artifact has no guide, so the reminder names the file's own status line instead.
  expect(approved).toStartWith(
    "design: owner approved; COMPLETED\nIf any of design.md records a status of its own, such as a 'Status: draft' line, set it to approved.\n\nSTEP build (2 of 3)",
  );
  expect(repo.status("feat", "design")).toBe("COMPLETED");
  expect(repo.state("feat").steps.design.artifacts[0].status).toBe("approved");
  expect(repo.state("feat").steps.design.history.at(-1)).toContain("owner approved: looks good");
});

test("--owner-approved is a flag with no value, and each option belongs to one form", () => {
  repo.write("design.md");
  repo.ok("continue", "feat");
  expect(repo.usage("continue", "feat", "--owner-approved=false")).toContain("error:");
  expect(repo.usage("continue", "feat", "--owner-approved", "yes")).toContain("continue takes <slug>");
  expect(repo.usage("continue", "feat", "--note", "x")).toContain("--note goes with --owner-approved");
  expect(repo.usage("continue", "feat", "--owner-approved", "--updated", "a")).toContain("--updated reports the agent's work; it does not go with --owner-approved");
  expect(repo.status("feat", "design")).toBe("AWAITING_OWNER");
});

test("--owner-approved is refused for a step the agent has not finished", () => {
  expect(repo.refused("continue", "feat", "--owner-approved")).toContain(
    'step "design" is IN_PROGRESS, not awaiting the owner or blocked; finish it and run continue without --owner-approved',
  );
});

test("a script gate closes the step only when its command exits 0", () => {
  approveDesign();
  const failed = repo.refused("continue", "feat");
  expect(failed).toStartWith("REFUSED: script `test -f tests.pass` failed (exit 1)\n\nSTEP build (2 of 3)");
  expect(failed).toContain("  1. Run `FUSE_FLOW_SLUG=feat FUSE_FLOW_STEP=build sh -c 'test -f tests.pass'`. Fix the work, or the check if the check is wrong, until it passes.");
  expect(repo.status("feat", "build")).toBe("IN_PROGRESS");
  expect(repo.state("feat").steps.build.history.at(-1)).toContain("continue refused: script `test -f tests.pass` failed (exit 1)");

  repo.write("tests.pass");
  const passed = repo.ok("continue", "feat");
  expect(passed).toStartWith("build: COMPLETED\n\nSTEP release (3 of 3)");
  expect(repo.state("feat").steps.build.verification).toEqual(["script `test -f tests.pass`: passed"]);
});

test("a script runs from the repository root, knows its step, and shows the end of its output", () => {
  const repo2 = new Repo();
  try {
    repo2.start(
      "env",
      `version: 1
name: env
steps:
  - id: probe
    instruction: x
    gates:
      - script: test "$FUSE_FLOW_SLUG/$FUSE_FLOW_STEP" = env/probe && test -f workflow-source.yml && seq 1 100 && exit 7
`,
    );
    const out = repo2.refused("continue", "env");
    expect(out).toContain("failed (exit 7)");
    expect(out).toContain("\n81\n");
    expect(out).toContain("\n100\n");
    expect(out).not.toContain("\n80\n");
  } finally {
    repo2.cleanup();
  }
});

test("a script that prints more than fits in memory still reports its exit code and the end of its output", () => {
  const repo2 = new Repo();
  try {
    // 300 MB of output, then a cut-off line longer than the part of the output
    // that is read back, then the lines that explain the failure.
    repo2.start(
      "loud",
      `version: 1
name: loud
steps:
  - id: build
    instruction: x
    gates:
      - script: yes | head -c 300000000; head -c 100000 /dev/zero | tr '\\0' z; echo; echo why it failed; exit 3
`,
    );
    const out = repo2.refused("continue", "loud");
    expect(out).toContain("failed (exit 3)");
    expect(out).toContain("\nwhy it failed\n");
    expect(out).not.toContain("zzzzzzzzzz");
  } finally {
    repo2.cleanup();
  }
});

const CHECKED = `version: 1
name: checked
steps:
  - id: build
    instruction: Build it.
    gates:
      - check: default
      - check: lint
`;

test("a check gate runs the command the policy binds, and says where the binding is", () => {
  const r = new Repo();
  try {
    const unbound = r.start("feat", CHECKED);
    expect(unbound).toContain("  1. This project has no command for the default check yet. Find it in the project");
    expect(unbound).toContain("If the project has no check command for agents, suggest that the owner add one");
    expect(r.refused("continue", "feat")).toStartWith("REFUSED: This project has no command for the default check yet.");

    r.write(".konductor/policy-overrides.yml", 'checks:\n  default: test -f built\n  lint: "none"\n');
    const bound = r.ok("start", "feat");
    expect(bound).toContain(
      "  1. Run `FUSE_FLOW_SLUG=feat FUSE_FLOW_STEP=build sh -c 'test -f built'`, the project's default check (bound in .konductor/policy-overrides.yml). Fix the work",
    );
    expect(bound).toContain("  2. The lint check is not configured in this project (bound to none in .konductor/policy-overrides.yml); there is nothing to run.");
    expect(r.refused("continue", "feat")).toContain("REFUSED: check default (`test -f built`) failed (exit 1)");
    expect(r.state("feat").steps.build.verification).toEqual(["check default (`test -f built`): failed (exit 1)", "check lint: not run"]);
    expect(r.ok("continue", "feat", "--blocked", "x")).toContain("VERIFICATION: check default (`test -f built`): failed (exit 1); check lint: not run");
    r.ok("continue", "feat", "--owner-approved");
    r.cleanupPath(".konductor/workstreams");
    r.start("feat", CHECKED);

    r.write("built");
    expect(r.ok("continue", "feat")).toContain("STATUS: workflow complete");
    expect(r.state("feat").steps.build.verification).toEqual([
      "check default (`test -f built`): passed",
      "check lint: not configured in this project",
    ]);
  } finally {
    r.cleanup();
  }
});

test("the policy files override each other from the general to the specific", () => {
  const r = new Repo();
  try {
    r.write("home/.konductor/policy-overrides.yml", "checks:\n  default: echo user\n  lint: echo user-lint\n");
    r.write(".konductor/policy-overrides.yml", "checks:\n  default: echo team\n");
    const team = r.start("feat", CHECKED);
    expect(team).toContain("Run `FUSE_FLOW_SLUG=feat FUSE_FLOW_STEP=build sh -c 'echo team'`, the project's default check (bound in .konductor/policy-overrides.yml)");
    expect(team).toContain(`Run \`FUSE_FLOW_SLUG=feat FUSE_FLOW_STEP=build sh -c 'echo user-lint'\`, the project's lint check (bound in home/.konductor/policy-overrides.yml)`);

    r.write(".konductor/policy-overrides.local.yml", "checks:\n  default: echo mine\n");
    expect(r.ok("start", "feat")).toContain("Run `FUSE_FLOW_SLUG=feat FUSE_FLOW_STEP=build sh -c 'echo mine'`, the project's default check (bound in .konductor/policy-overrides.local.yml)");

    r.write(".konductor/policy-overrides.yml", "checks:\n  default: [not, a, command]\n");
    expect(r.refused("start", "feat")).toContain(".konductor/policy-overrides.yml is not a valid policy file");
  } finally {
    r.cleanup();
  }
});

test("a check names a kind; a command written as a check is refused with the script form", () => {
  const out = repo.refused("validate", repo.write("bad.yml", CHECKED.replace("check: lint", "check: npm test")));
  expect(out).toContain("check names a kind of check, a single lower-case word such as default; for a command use `script: npm test`");
  for (const legacy of ["owner", "none"]) {
    const bad = repo.refused("validate", repo.write(`${legacy}.yml`, CHECKED.replace("- check: lint", `- ${legacy}`)));
    expect(bad).toContain(`the legacy gate \`${legacy}\` is no longer accepted`);
  }
});

test("failed checks never block a step; the agent reports it blocked, and the owner can accept it as it is", () => {
  approveDesign();
  for (let i = 0; i < 4; i++) repo.refused("continue", "feat");
  expect(repo.status("feat", "build")).toBe("IN_PROGRESS");

  const blocked = repo.ok("continue", "feat", "--blocked", "the test needs a database this host does not have");
  expect(blocked).toStartWith("build: BLOCKED: the test needs a database this host does not have\n\nOWNER'S TURN:");
  // The last refused attempt's results stay visible to the owner.
  expect(blocked).toContain("VERIFICATION: script `test -f tests.pass`: failed (exit 1)\n");
  expect(blocked).toContain("STATUS: blocked. blocked by the agent: the test needs a database this host does not have\n");
  expect(repo.status("feat", "build")).toBe("BLOCKED");

  // Once blocked, only the owner moves it on, even if the check would pass now.
  repo.write("tests.pass");
  expect(repo.refused("continue", "feat")).toContain('step "build" is BLOCKED; only the owner can move it on');
  expect(repo.refused("continue", "feat", "--blocked", "again")).toContain('step "build" is BLOCKED; only the owner can move it on');

  const resumed = repo.ok("start", "feat");
  expect(resumed).toContain('  - The owner accepts the step as it is: run `fuse-flow continue feat --owner-approved --note "<the owner\'s decision>"`.');
  expect(resumed).toContain("  - The owner sends the work back: run `fuse-flow continue feat --back-to <step>");
  expect(resumed).toContain("name the step that produces it: design (design.md), build.");
  // build has no agent gate, so there are no review rounds to grant, and no gate suggests a step.
  expect(resumed).not.toContain("--more-rounds");
  expect(resumed).not.toContain("the step's gates suggest");
  expect(repo.refused("continue", "feat", "--more-rounds", "1")).toContain('step "build" has no agent gate');

  const accepted = repo.ok("continue", "feat", "--owner-approved", "--note", "accepted without the database test");
  expect(repo.status("feat", "build")).toBe("COMPLETED");
  expect(accepted).toContain("STEP release (3 of 3)");
});

test("an agent gate prints its review and its round cap: 2, the workflow's max_rounds, or the policy's", () => {
  const other = new Repo();
  try {
    const wf = `version: 1
name: w
steps:
  - id: review
    instruction: Review the change.
    updates:
      - artifact: patch
        path: src/
    gates:
      - agent: review the diff against the spec
        max_rounds: 3
      - agent("check the docs")
`;
    const out = other.start("feat", wf);
    expect(out).toContain(
      "  1. Have an independent agent review the diff against the spec. It reviews src/. " +
        subagent(".konductor/reviews/feat/review-gate1-round-<n>.json") +
        "Classify each finding as a required fix, optional or a false positive, with the reason; a finding the owner " +
        "already accepted or deferred is not a required fix. A P0 or P1 finding you have checked is a required fix; " +
        "a P2 or P3 finding is optional: fix it when the fix is cheap, and list the rest as deferred in the hand-over. " +
        "Fix what is required and review again, until a round ends with no required fix. That round passes and ends " +
        "the review: fixing optional findings after it starts no further round. Every round " +
        "that ends with a required fix counts, whatever the cause. After 3 such rounds, make the last round's fixes anyway, start no further " +
        "review, and report the step blocked, naming the fixes no reviewer has seen: run " +
        '`fuse-flow continue feat --blocked "<what is still open, and the fixes no reviewer has seen>" --gate 1`.',
    );
    expect(out).toContain("  2. Have an independent agent check the docs. It reviews src/.");
    expect(out).toContain("After 2 such rounds, make the last round's fixes anyway");

    // The user's policy fills in only what the workflow leaves open; the team's wins over the workflow.
    other.write("home/.konductor/policy-overrides.yml", "review:\n  max_rounds: 5\n  reviewer: a different model\n");
    const user = other.ok("start", "feat");
    expect(user).toContain("After 3 such rounds");
    expect(user).toContain("After 5 such rounds");
    expect(user).toContain("The reviewer: a different model.");
    other.write(".konductor/policy-overrides.yml", "review:\n  max_rounds: 1\n");
    expect(other.ok("start", "feat").match(/After 1 such rounds/g)).toHaveLength(2);
  } finally {
    other.cleanup();
  }
});

test("a review guide comes from the winning library entry only; a replaced library is not looked at", () => {
  const r = new Repo();
  try {
    r.start(
      "feat",
      `version: 1
name: w
steps:
  - id: write
    instruction: Write it.
    produces:
      - artifact: essay
        path: essay.md
    gates:
      - agent: review the essay
`,
    );
    // The user's library has a review guide for essay, filed twice.
    r.write("home/.konductor/library/artifacts/essay/review.md", "# user rules\n");
    r.write("home/.konductor/library/artifacts/writing/essay/review.md", "# user rules\n");
    // The project's entry, with a guide and no review guide, replaces both.
    r.write(".konductor/library/artifacts/essay/guide.md", "# guide\n");
    expect(r.ok("start", "feat")).toContain(
      "It reviews essay.md, with its guide .konductor/library/artifacts/essay/guide.md as the definition of a good artifact.",
    );
  } finally {
    r.cleanup();
  }
});

test("where the step instruction and a shipped guide disagree, the instruction wins; the project's own guide is a house rule", () => {
  const r = new Repo();
  try {
    r.start(
      "feat",
      `version: 1
name: w
steps:
  - id: write
    instruction: Write it without a plan section.
    produces:
      - artifact: essay
        path: essay.md
    gates:
      - agent: review the essay
  - id: notes
    instruction: Write notes.
    produces:
      - artifact: research-note
        path: notes.md
    gates:
      - agent: review the notes
  - id: scribble
    instruction: Scribble.
    produces:
      - artifact: scribble
        path: scribble.md
    gates:
      - agent: review the scribble
`,
    );
    r.write(".konductor/library/artifacts/essay/guide.md", "# guide\n");
    const guided = r.ok("start", "feat");
    // A guide in the project's own library is a house rule: the shipped instruction does not win by default.
    expect(guided).toContain(
      "GUIDES: The guide .konductor/library/artifacts/essay/guide.md comes from this project's or the owner's own library or " +
        "policy, so it is a house rule: where the step instruction disagrees with it, follow the owner's ruling, else " +
        "the guide when it clearly applies, and ask the owner when it is unclear. Name each disagreement in your " +
        "hand-over block.",
    );
    expect(guided).toContain(
      "Give the reviewer the step instruction as well: The guide .konductor/library/artifacts/essay/guide.md comes from this " +
        "project's or the owner's own library or policy, so it is a house rule: where the instruction disagrees with " +
        "it, report the disagreement, and the author settles it with the owner's ruling or the house rules; it is not " +
        "a required fix by itself.",
    );
    expect(guided).not.toContain("the instruction wins");

    // A guide that ships with fuse: the instruction wins.
    r.write("essay.md", "# essay\n");
    r.ok("continue", "feat");
    const shipped = r.ok("start", "feat");
    expect(shipped).toContain("STEP notes");
    expect(shipped).toContain(
      "GUIDES: where the step instruction above and a guide disagree, follow the instruction, and name each " +
        "disagreement in your hand-over block.",
    );
    expect(shipped).toContain(
      "Give the reviewer the step instruction as well: where it and a guide disagree, the instruction wins, so " +
        "following the instruction is not a required fix.",
    );

    // A step whose artifacts have no guide gets neither line.
    r.write("notes.md", "# notes\n");
    r.ok("continue", "feat");
    const unguided = r.ok("start", "feat");
    expect(unguided).toContain("STEP scribble");
    expect(unguided).not.toContain("GUIDES:");
    expect(unguided).not.toContain("Give the reviewer the step instruction");
  } finally {
    r.cleanup();
  }
});

test("a project guide stays a house rule when it is a symlink, and when a shipped review guide checks the artifact", () => {
  const r = new Repo();
  try {
    // The gate's guide exists before the workstream starts, as a workflow's guide does.
    r.write("shipped-review.md", "# review\n");
    r.start(
      "feat",
      `version: 1
name: w
steps:
  - id: write
    instruction: Write it without a plan section.
    produces:
      - artifact: essay
        path: essay.md
    gates:
      - agent: review the essay
        guide: shipped-review.md
`,
    );
    // The project's guide is a symlink to a skill outside the library; where it leads does not make it shipped.
    r.write("skills/essay-writing/SKILL.md", "# guide\n");
    r.write(".konductor/library/artifacts/essay/.keep");
    symlinkSync("../../../../skills/essay-writing/SKILL.md", join(r.root, ".konductor/library/artifacts/essay/guide.md"));
    const out = r.ok("start", "feat");
    expect(out).toContain("GUIDES: The guide skills/essay-writing/SKILL.md comes from this project's or the owner's own library or policy, so it is a house rule");
    // The reviewer checks against the gate's shipped guide, and still hears that the project's guide is a house rule.
    expect(out).toContain(
      "Give the reviewer the step instruction as well: where it and a guide that ships with fuse disagree, the " +
        "instruction wins, so following the instruction is not a required fix. The guide skills/essay-writing/SKILL.md comes " +
        "from this project's or the owner's own library or policy, so it is a house rule: where the instruction " +
        "disagrees with it, report the disagreement",
    );

    // A project review guide that is a symlink is a house rule too.
    r.write("skills/essay-review/SKILL.md", "# review\n");
    symlinkSync("../../../../skills/essay-review/SKILL.md", join(r.root, ".konductor/library/artifacts/essay/review.md"));
    const reviewed = r.ok("start", "feat");
    expect(reviewed).toContain("It reviews essay.md against skills/essay-review/SKILL.md.");
    expect(reviewed).toContain(
      "Give the reviewer the step instruction as well: The guides skills/essay-writing/SKILL.md, skills/essay-review/SKILL.md " +
        "come from this project's or the owner's own library or policy, so they are house rules",
    );
    expect(reviewed).not.toContain("the instruction wins");
  } finally {
    r.cleanup();
  }
});

test("a gate guide in the project's own library is a house rule, even for another artifact; a gate's own guide is not", () => {
  const r = new Repo();
  try {
    const workflow = (guide: string) => `version: 1
name: w
steps:
  - id: build
    instruction: Build it.
    updates:
      - artifact: patch
        path: src/
    gates:
      - agent: review the patch
        guide: ${guide}
`;
    r.write(".konductor/library/artifacts/team-review/guide.md", "# team review\n");
    r.write(".konductor/workflows/w.yml", workflow("../library/artifacts/team-review/guide.md"));
    const owned = r.ok("start", "feat", "--workflow", "w");
    expect(owned).toContain(
      "Give the reviewer the step instruction as well: The guide .konductor/library/artifacts/team-review/guide.md " +
        "comes from this project's or the owner's own library or policy, so it is a house rule",
    );
    expect(owned).not.toContain("the instruction wins");

    // A guide next to the workflow is part of the workflow, so the instruction wins over it.
    r.write(".konductor/workflows/review.md", "# review\n");
    r.write(".konductor/workflows/w.yml", workflow("review.md"));
    expect(r.ok("start", "feat")).toContain(
      "Give the reviewer the step instruction as well: where it and a guide disagree, the instruction wins, so " +
        "following the instruction is not a required fix.",
    );
  } finally {
    r.cleanup();
  }
});

test("a review guide decides the pass rule; a project's own replaces the workflow's gate guide", () => {
  const r = new Repo();
  try {
    r.write("flows/review-rules.md", "# rules\n");
    r.write(
      "flows/wf.yml",
      `version: 1
name: w
steps:
  - id: write
    instruction: Write it.
    produces:
      - artifact: essay
        path: essay.md
    gates:
      - agent: review the essay
        guide: review-rules.md
`,
    );
    const out = r.ok("start", "feat", "--workflow", `${r.root}/flows/wf.yml`);
    expect(out).toContain(
      `It reviews essay.md against flows/review-rules.md. ${subagent(".konductor/reviews/feat/write-round-<n>.json")}Classify each finding as a required fix, optional or a false positive`,
    );
    expect(out).toContain(
      "is not a required fix. The review guide decides what counts as a required fix and when a round passes; where it " +
        "does not say, a P0 or P1 finding you have checked is a required fix; a P2 or P3 finding is optional: fix it when " +
        "the fix is cheap, and list the rest as deferred in the hand-over. Fix what is required and review again, until a " +
        "round ends with no required fix. That round passes and ends the review: fixing optional findings after it starts no further round.",
    );

    r.write(".konductor/library/artifacts/essay/review.md", "# house rules\n");
    expect(r.ok("start", "feat")).toContain("It reviews essay.md against .konductor/library/artifacts/essay/review.md.");
    // An entry in a folder below artifacts/ is found the same way.
    r.cleanupPath(".konductor/library/artifacts/essay");
    r.write(".konductor/library/artifacts/prose/essay/review.md", "# house rules\n");
    expect(r.ok("start", "feat")).toContain("It reviews essay.md against .konductor/library/artifacts/prose/essay/review.md.");
    r.write(".konductor/review.md", "# policy guide\n");
    r.write(".konductor/policy-overrides.yml", "review:\n  guide: review.md\n");
    expect(r.ok("start", "feat")).toContain("It reviews essay.md against .konductor/review.md.");
  } finally {
    r.cleanup();
  }
});

const REVIEWED = `version: 1
name: reviewed
steps:
  - id: spec
    instruction: Write the spec.
    produces:
      - artifact: paper
        path: spec.md
  - id: implement
    instruction: Implement the spec.
    gates:
      - agent: review the diff against the spec
        route_back_to: [spec, implement]
  - id: release
    instruction: Release it.
`;

test("the owner can grant more review rounds, on a blocked step or ahead of time", () => {
  const other = new Repo();
  try {
    other.start("feat", REVIEWED);
    other.write("spec.md");
    expect(other.ok("continue", "feat")).toContain("After 2 such rounds, make the last round's fixes anyway");

    // Ahead of time, on a step in progress.
    const early = other.ok("continue", "feat", "--more-rounds", "1", "--note", "this one is hard");
    expect(early).toStartWith("implement: owner granted 1 more review round; the step is IN_PROGRESS\n\nSTEP implement");
    expect(early).toContain("After 3 (2 plus 1 granted by the owner) such rounds");

    const blocked = other.ok("continue", "feat", "--blocked", "the reviewer wants an API the spec rules out");
    expect(blocked).toContain('  - The owner grants more review rounds: run `fuse-flow continue feat --more-rounds <n> --note "<the owner\'s decision>"`.');
    expect(blocked).toContain("; the step's gates suggest spec or implement.");
    expect(blocked).toContain("VERIFICATION: review (review the diff against the spec): <rounds used> of 3 (2 plus 1 granted by the owner) rounds");
    expect(other.refused("continue", "feat")).toContain('step "implement" is BLOCKED');

    const granted = other.ok("continue", "feat", "--more-rounds", "2");
    expect(granted).toContain("After 5 (2 plus 3 granted by the owner) such rounds");
    expect(other.status("feat", "implement")).toBe("IN_PROGRESS");
    expect(other.ok("continue", "feat")).toContain("STEP release (3 of 3)");
  } finally {
    other.cleanup();
  }
});

test("the owner can send the work back from a blocked step to it or an earlier step, which starts over", () => {
  const other = new Repo();
  try {
    other.start("feat", REVIEWED);
    other.write("spec.md", "Status: approved\n");
    other.ok("continue", "feat");
    other.ok("continue", "feat", "--blocked", "the spec itself is wrong about the API");

    expect(other.refused("continue", "feat", "--back-to", "release")).toContain('step "release" comes after "implement"');
    expect(other.refused("continue", "feat", "--back-to", "nowhere")).toContain('no step "nowhere" in workflow reviewed');

    const back = other.ok("continue", "feat", "--back-to", "spec", "--note", "fix the API section first");
    // The paper artifact has no guide, so the reminder names the file's own status line instead.
    expect(back).toStartWith(
      "implement: owner sent the work back to spec\nIf any of spec.md records a status of its own, such as a 'Status: approved' line, set it back to draft.\n\nSTEP spec (1 of 3)",
    );
    // The file this workstream wrote is rework, not a file someone else left there.
    expect(back).not.toContain("already existed");
    const spec = other.state("feat").steps.spec;
    expect(spec.status).toBe("IN_PROGRESS");
    expect(spec.artifacts).toEqual([{ artifact: "paper", path: "spec.md", status: "draft" }]);
    expect(spec.history.at(-2)).toContain("owner sent the work back from implement to spec: fix the API section first");
    expect(other.state("feat").steps.implement.status).toBe("PENDING");
    // spec.md is still on disk, so the agent can amend it and continue.
    expect(other.ok("continue", "feat")).toContain("STEP implement (2 of 3)");
  } finally {
    other.cleanup();
  }
});

// The send-back rules let the owner send work back from a step in progress
// too; before, the agent had to report a block that never happened.
test("--back-to answers the current step whatever its status", () => {
  expect(repo.ok("continue", "feat", "--back-to", "design")).toContain("STEP design (1 of 3)");
  expect(repo.status("feat", "design")).toBe("IN_PROGRESS");
  expect(repo.state("feat").steps.design.history.some((h: string) => h.includes("blocked"))).toBe(false);
  repo.write("design.md");
  repo.ok("continue", "feat");
  expect(repo.refused("continue", "feat", "--more-rounds", "1")).toContain('step "design" has no agent gate');
  expect(repo.ok("continue", "feat", "--back-to", "design")).toContain("STEP design (1 of 3)");
});

test("a produces path that existed before the step, unrecorded, is reported when the step is handed out", () => {
  const r = new Repo();
  try {
    r.write("design.md", "someone else's\n");
    const out = r.start("feat", GATED);
    expect(out).toContain("design.md already existed when the step was handed out, and this workstream did not write it.");
    expect(r.state("feat").steps.design.existed).toEqual(["design.md"]);
    expect(r.ok("continue", "feat")).toContain("PRODUCED: design.md (updated)");
  } finally {
    r.cleanup();
  }
});

test("--more-rounds takes a whole number, and each owner decision goes alone", () => {
  expect(repo.usage("continue", "feat", "--more-rounds", "0")).toContain("--more-rounds takes a whole number of rounds, 1 or more");
  expect(repo.usage("continue", "feat", "--more-rounds", "two")).toContain("--more-rounds takes a whole number");
  expect(repo.usage("continue", "feat", "--more-rounds", "1", "--owner-approved")).toContain("--owner-approved and --more-rounds are different decisions");
  // --back-to may record the files written so far with --updated (send-back rules), but no other report.
  expect(repo.usage("continue", "feat", "--back-to", "design", "--not-produced", "sketch", "x")).toContain(
    "--not-produced reports the agent's work; it does not go with --back-to",
  );
  expect(repo.usage("continue", "feat", "--owner-approved", "--updated", "a")).toContain("--updated reports the agent's work; it does not go with --owner-approved");
});

test("--blocked needs a reason, and goes with no other decision or report", () => {
  expect(repo.usage("continue", "feat", "--blocked")).toContain("--blocked");
  expect(repo.usage("continue", "feat", "--blocked=")).toContain("--blocked needs a value");
  expect(repo.usage("continue", "feat", "--blocked", "x", "--owner-approved")).toContain("are different decisions");
  // --blocked may record the files written so far with --updated, but no other report.
  expect(repo.usage("continue", "feat", "--blocked", "x", "--not-produced", "sketch", "y")).toContain(
    "--not-produced reports the agent's work; it does not go with --blocked",
  );
  expect(repo.status("feat", "design")).toBe("IN_PROGRESS");
});

test("continue still succeeds and prints the next step when its check changes the workflow file", () => {
  const other = new Repo();
  try {
    other.start("feat", "version: 1\nname: w\nsteps:\n  - id: a\n    instruction: a\n    gates: \"script: rm workflow-source.yml\"\n  - id: b\n    instruction: b\n");
    expect(other.ok("continue", "feat")).toContain("STEP b (2 of 2)");
    expect(other.status("feat", "a")).toBe("COMPLETED");
  } finally {
    other.cleanup();
  }
});

test("a blocked step records the files it wrote, so its hand-over and its record after acceptance list them", () => {
  const r = new Repo();
  try {
    r.start(
      "feat",
      `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
      - artifact: notes
        path: notes/
    gates:
      - agent: review the design
  - id: release
    instruction: Release it.
`,
    );
    r.write("design.md");
    r.write("notes/a.md");
    r.write("extra.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the review does not converge", "--updated", "notes/a.md", "--updated", "extra.md");
    expect(blocked).toContain("PRODUCED: design.md (new); notes/a.md (new); extra.md (updated, outside the declared paths)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/a.md", status: "draft" },
    ]);

    r.ok("continue", "feat", "--owner-approved", "--note", "good enough");
    const rows = r.ok("status", "feat").split("\n");
    expect(rows.find((l) => l.includes(" design "))).toContain("design.md (approved), notes/a.md (approved)");
  } finally {
    r.cleanup();
  }
});

const TWO_REVIEWS = `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
    gates:
      - script: test -f design.md
      - agent: review the design
      - agent: review the design as a principal engineer
      - owner-action: run the checks only you can run, then approve the design
`;

test("the owner accepts the review that blocked, and the step goes back to the agent for the reviews still ahead", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    // The cap instruction names the review it belongs to, by its number in the list.
    expect(r.ok("start", "feat")).toContain(
      '`fuse-flow continue feat --blocked "<what is still open, and the fixes no reviewer has seen>" --gate 2`.',
    );
    expect(r.refused("continue", "feat", "--blocked", "x", "--gate", "1")).toContain(
      "--gate names one of the step's reviews by its number in the step's list: 2 (review the design), 3 (review the design as a principal engineer)",
    );

    const blocked = r.ok("continue", "feat", "--blocked", "the design review does not converge", "--gate", "2");
    const ahead = "review (review the design as a principal engineer)";
    const owner = "run the checks only you can run, then approve the design";
    // Accepting the review alone still reaches the owner's action; accepting the whole step skips it too.
    expect(blocked).toContain(`  - Accept this review as it is, and go on with the gates still ahead: ${ahead}; the step then awaits the owner action: ${owner}.\n`);
    expect(blocked).toContain(`  - Accept the whole step as it is, without the gates still ahead: ${ahead}, ${owner}.\n`);
    expect(blocked).toContain(
      '  - The owner accepts this review as it is: run `fuse-flow continue feat --owner-approved --gate 2 --note "<the owner\'s decision>"`.',
    );
    expect(blocked).toContain(
      '  - The owner accepts the whole step as it is: run `fuse-flow continue feat --owner-approved --note "<the owner\'s decision>"`.',
    );
    expect(r.refused("continue", "feat", "--owner-approved", "--gate", "3")).toContain(
      "the step was blocked at review 2 (review the design); --gate 3 accepts only that review",
    );

    const accepted = r.ok("continue", "feat", "--owner-approved", "--gate", "2", "--note", "the open points can wait");
    expect(accepted).toStartWith("design: owner accepted review 2 (review the design) as it is; the step is IN_PROGRESS\n\nSTEP design");
    expect(accepted).toContain("  2. The owner accepted this review (review the design) as it was; do not run it again.\n");
    expect(accepted).toContain("  3. Have an independent agent review the design as a principal engineer.");
    expect(r.status("feat", "design")).toBe("IN_PROGRESS");

    const done = r.ok("continue", "feat");
    expect(done).toContain("STATUS: awaiting owner action.");
    expect(done).toContain("review (review the design): accepted by the owner as it was;");
    r.ok("continue", "feat", "--owner-approved");
    expect(r.status("feat", "design")).toBe("COMPLETED");
  } finally {
    r.cleanup();
  }
});

test("a step blocked at its last review still offers accepting that review alone, so its checks and owner action still run", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    // Accepting the whole step completes it, so the option names the owner's action it skips.
    const owner = "run the checks only you can run, then approve the design";
    expect(blocked).toContain(
      `NEXT STEP:\n  - Accept this review as it is, and finish the step; it then awaits the owner action: ${owner}.\n` +
        `  - Accept the whole step as it is, without the gates still ahead: ${owner}.\n`,
    );
    expect(blocked).toContain(
      '  - The owner accepts this review as it is: run `fuse-flow continue feat --owner-approved --gate 3 --note "<the owner\'s decision>"`.\n' +
        '  - The owner accepts the whole step as it is: run `fuse-flow continue feat --owner-approved --note "<the owner\'s decision>"`.\n',
    );

    r.ok("continue", "feat", "--owner-approved", "--gate", "3");
    expect(r.status("feat", "design")).toBe("IN_PROGRESS");
    // The plain continue reruns the checks and stops at the owner's action.
    expect(r.ok("continue", "feat")).toContain(
      "STATUS: awaiting owner action. The owner is asked to run the checks only you can run, then approve the design.\n",
    );
    expect(r.state("feat").steps.design.verification).toEqual(["script `test -f design.md`: passed"]);
  } finally {
    r.cleanup();
  }
});

test("accepting a step blocked at no named review names the owner's action it skips with the gates not passed", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the design needs a decision");
    expect(blocked).toContain(
      "  - Accept the whole step as it is, without the gates not recorded as passed: script `test -f design.md`, " +
        "review (review the design), review (review the design as a principal engineer), run the checks only you can run, then approve the design.\n",
    );
  } finally {
    r.cleanup();
  }
});

test("after the owner accepts a later review, the step block does not ask again for the reviews that passed before it", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    // Reviews run in list order, so the agent reached review 3 only after review 2 passed.
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    const accepted = r.ok("continue", "feat", "--owner-approved", "--gate", "3");
    expect(accepted).toContain("  2. This review (review the design) passed earlier in this pass; do not run it again.\n");
    expect(accepted).toContain("  3. The owner accepted this review (review the design as a principal engineer) as it was; do not run it again.\n");
    expect(accepted).not.toContain("Have an independent agent");
    // The hand-over still asks for the rounds that review used.
    expect(r.ok("continue", "feat")).toContain(
      "review (review the design): <rounds used> of 2 rounds, <any required fix still open, and any fix made after the last review, which no reviewer has seen>; " +
        "review (review the design as a principal engineer): accepted by the owner as it was",
    );
  } finally {
    r.cleanup();
  }
});

test("a review the owner accepted no longer counts as accepted once the workflow changes that review", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the design review does not converge", "--gate", "2");
    r.ok("continue", "feat", "--owner-approved", "--gate", "2");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("- agent: review the design\n", "- agent: review all security properties\n"));
    const resumed = r.ok("start", "feat");
    expect(resumed).not.toContain("The owner accepted this review");
    expect(resumed).toContain("  2. Have an independent agent review all security properties.");
    const done = r.ok("continue", "feat");
    expect(done).not.toContain("accepted by the owner as it was");
    expect(done).toContain("review (review all security properties): <rounds used> of 2 rounds");
  } finally {
    r.cleanup();
  }
});

test("a review the owner accepted no longer counts as accepted once an edit moves it to another number", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    r.ok("continue", "feat", "--owner-approved", "--gate", "3");
    // The accepted review is now number 2, and a new review is number 3.
    r.write("workflow-source.yml", TWO_REVIEWS.replace("      - agent: review the design\n", "").replace("- owner-action:", "- agent: review the tests\n      - owner-action:"));
    const resumed = r.ok("start", "feat");
    expect(resumed).not.toContain("The owner accepted this review");
    expect(resumed).toContain("  3. Have an independent agent review the tests.");
  } finally {
    r.cleanup();
  }
});

test("accepting the review a step was blocked at is refused, not a crash, when an edit removed that review", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    expect(blocked).toContain("--owner-approved --gate 3");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("      - agent: review the design\n", ""));
    const refused = r.run(["continue", "feat", "--owner-approved", "--gate", "2"]);
    expect(refused.code).toBe(1);
    expect(refused.out).not.toContain("TypeError");
    expect(refused.out).toContain(
      "the step was blocked at review 3, which the workflow no longer has, since it was edited; the owner accepts the whole step " +
        "with --owner-approved alone, grants more rounds with --more-rounds, or sends the work back with --back-to",
    );
    expect(r.status("feat", "design")).toBe("BLOCKED");
    // The hand-over no longer offers accepting that review alone.
    const handOver = r.ok("start", "feat");
    expect(handOver).not.toContain("--owner-approved --gate");
    expect(handOver).toContain("  - Accept the whole step as it is, without the gates not recorded as passed:");
    r.ok("continue", "feat", "--owner-approved");
    expect(r.status("feat", "design")).toBe("COMPLETED");
  } finally {
    r.cleanup();
  }
});

test("a later acceptance does not exempt an earlier review once an edit changes that review", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the design review does not converge", "--gate", "2");
    r.ok("continue", "feat", "--owner-approved", "--gate", "2");
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    r.ok("continue", "feat", "--owner-approved", "--gate", "3");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("- agent: review the design\n", "- agent: review data protection\n"));
    const resumed = r.ok("start", "feat");
    expect(resumed).not.toContain("passed earlier in this pass");
    expect(resumed).toContain("  2. Have an independent agent review data protection.");
    expect(resumed).toContain("  3. The owner accepted this review (review the design as a principal engineer) as it was; do not run it again.\n");
  } finally {
    r.cleanup();
  }
});

test("a review inferred to have passed before an accepted one runs again once an edit changes it", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    r.ok("continue", "feat", "--owner-approved", "--gate", "3");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("- agent: review the design\n", "- agent: review data protection\n"));
    const resumed = r.ok("start", "feat");
    expect(resumed).not.toContain("passed earlier in this pass");
    expect(resumed).toContain("  2. Have an independent agent review data protection.");
  } finally {
    r.cleanup();
  }
});

test("accepting the review a step was blocked at is refused once an edit puts another review at its number", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    // Review 3 is now another review: the first review is gone and a new one follows.
    r.write(
      "workflow-source.yml",
      TWO_REVIEWS.replace("      - agent: review the design\n", "").replace("- owner-action:", "- agent: review the tests\n      - owner-action:"),
    );
    const handOver = r.ok("start", "feat");
    expect(handOver).not.toContain("--owner-approved --gate");
    expect(handOver).toContain("  - Accept the whole step as it is, without the gates not recorded as passed:");
    const refused = r.run(["continue", "feat", "--owner-approved", "--gate", "3"]);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "the step was blocked at review 3 (review the design as a principal engineer), and an edit has changed it since: it is now " +
        "review 3 (review the tests); the owner accepts the whole step with --owner-approved alone, grants more " +
        "rounds with --more-rounds, or sends the work back with --back-to",
    );
    expect(r.status("feat", "design")).toBe("BLOCKED");
    expect(r.state("feat").steps.design.accepted_gates).toBeUndefined();
  } finally {
    r.cleanup();
  }
});

test("a block an earlier fuse-flow recorded by number is bound to the review as the first command after the upgrade reads it", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the principal review does not converge", "--gate", "3");
    // A state file an earlier fuse-flow wrote records only the number.
    const old = r.state("feat");
    delete old.steps.design.blocked_review;
    r.write(join(".konductor", "workstreams", "feat.yml"), Bun.YAML.stringify(old, null, 2));
    expect(r.state("feat").steps.design.blocked_review).toBeUndefined();
    expect(r.ok("start", "feat")).toContain("--owner-approved --gate 3");
    expect(r.state("feat").steps.design.blocked_review.review).toBe("review 3 (review the design as a principal engineer)");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("- agent: review the design as a principal engineer\n", "- agent: review the risks\n"));
    expect(r.refused("continue", "feat", "--owner-approved", "--gate", "3")).toContain(
      "the step was blocked at review 3 (review the design as a principal engineer), and an edit has changed it since: it is now " +
        "review 3 (review the risks); the owner accepts the whole step with --owner-approved alone",
    );
  } finally {
    r.cleanup();
  }
});

test("an accepted review stays accepted when its text contains the words of the history line", () => {
  const r = new Repo();
  try {
    const text = "review the patch (security) as it is: check input validation";
    r.start("feat", TWO_REVIEWS.replace("review the design\n", `"${text}"\n`));
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the security review does not converge", "--gate", "2");
    const accepted = r.ok("continue", "feat", "--owner-approved", "--gate", "2", "--note", "approved");
    expect(accepted).toContain(`  2. The owner accepted this review (${text}) as it was; do not run it again.\n`);
    expect(accepted).not.toContain(`Have an independent agent ${text}`);
    // The owner's note is the note, not the end of the review's text.
    expect(accepted).toContain('OWNER SAID: "approved"\n');
    expect(accepted).not.toContain("OWNER SAID: \"check input validation");
  } finally {
    r.cleanup();
  }
});

// One review whose guide sits beside the workflow file.
const GUIDED = (guide: string) => `version: 1
name: w
steps:
  - id: review
    instruction: Review the change.
    updates:
      - artifact: reviewed-code
        path: src/
    gates:
      - agent: inspect the change
        guide: ${guide}
      - owner-action: approve the result
  - id: release
    instruction: Release it.
`;

// Block the review, have the owner accept it, then apply `edit`.
function acceptThenEdit(r: Repo, edit: () => void): string {
  r.write("review-first.md", "# Check only the spelling\n");
  r.write("review-second.md", "# Check access controls and reject any authorization bypass\n");
  r.start("feat", GUIDED("review-first.md"));
  r.write("src/change.ts");
  r.ok("continue", "feat", "--blocked", "the review was inconclusive", "--gate", "1", "--updated", "src/change.ts");
  expect(r.ok("continue", "feat", "--owner-approved", "--gate", "1", "--note", "accept")).toContain(
    "  1. The owner accepted this review (inspect the change) as it was; do not run it again.\n",
  );
  edit();
  return r.ok("start", "feat");
}

const TAKEN_BACK =
  "TAKEN BACK: the owner accepted review 1 (inspect the change) following review-first.md for reviewed-code as it was, but an " +
  "edit of the workflow, of a review guide or of the policy has changed that review since, so the acceptance no longer holds and " +
  "the review runs again below; its rounds count afresh, from findings files of its own. Tell the owner in your hand-over; the " +
  "owner's note on that acceptance is not an acceptance now.\n";

test("an accepted review runs again, and the step block says why, once an edit gives it another review guide", () => {
  const r = new Repo();
  try {
    const resumed = acceptThenEdit(r, () => r.write("workflow-source.yml", GUIDED("review-second.md")));
    expect(resumed).not.toContain("The owner accepted this review");
    expect(resumed).toContain(TAKEN_BACK);
    expect(resumed).toContain("  1. Have an independent agent inspect the change. It reviews src/ against review-second.md.");
    const handOver = r.ok("continue", "feat", "--updated", "src/change.ts");
    expect(handOver).not.toContain("accepted by the owner as it was");
    expect(handOver).toContain("review (inspect the change): <rounds used> of 2 rounds, ");
    expect(handOver).toContain(" (the owner's acceptance of this review was taken back, since an edit changed it)");
  } finally {
    r.cleanup();
  }
});

test("an accepted review runs again once the text of its review guide changes", () => {
  const r = new Repo();
  try {
    const resumed = acceptThenEdit(r, () => r.write("review-first.md", "# Check access controls as well\n"));
    expect(resumed).not.toContain("The owner accepted this review");
    expect(resumed).toContain(TAKEN_BACK);
    expect(resumed).toContain("  1. Have an independent agent inspect the change. It reviews src/ against review-first.md.");
  } finally {
    r.cleanup();
  }
});

test("an accepted review stays accepted while its text, number and review guide are unchanged", () => {
  const r = new Repo();
  try {
    const resumed = acceptThenEdit(r, () => r.write("workflow-source.yml", GUIDED("review-first.md").replace("Release it.", "Release it now.")));
    expect(resumed).toContain("  1. The owner accepted this review (inspect the change) as it was; do not run it again.\n");
    expect(resumed).not.toContain("TAKEN BACK");
  } finally {
    r.cleanup();
  }
});

test("an acceptance an earlier fuse-flow recorded by number only is taken back with a notice once the review's text changes after the upgrade", () => {
  const r = new Repo();
  try {
    r.start("feat", TWO_REVIEWS);
    r.write("design.md");
    r.ok("continue", "feat", "--blocked", "the design review does not converge", "--gate", "2");
    r.ok("continue", "feat", "--owner-approved", "--gate", "2", "--note", "accept");
    // A state file an earlier fuse-flow wrote names the acceptance only by number and history line.
    const old = r.state("feat");
    delete old.steps.design.accepted_reviews;
    r.write(join(".konductor", "workstreams", "feat.yml"), Bun.YAML.stringify(old, null, 2));
    // The first command after the upgrade binds the acceptance to the review as the workflow names it then.
    r.ok("status", "feat");
    r.write("workflow-source.yml", TWO_REVIEWS.replace("- agent: review the design\n", "- agent: review the design and its risks\n"));
    const resumed = r.ok("start", "feat");
    expect(resumed).toContain('OWNER SAID: "accept"\n');
    expect(resumed).toContain("TAKEN BACK: the owner accepted review 2 (review the design) as it was, but an edit of the workflow");
    expect(resumed).toContain("  2. Have an independent agent review the design and its risks.");
  } finally {
    r.cleanup();
  }
});

test("accepting the review a step was blocked at is refused once its review guide changed", () => {
  const r = new Repo();
  try {
    r.write("review-first.md", "# Check only the spelling\n");
    r.write("review-second.md", "# Check access controls\n");
    r.start("feat", GUIDED("review-first.md"));
    r.write("src/change.ts");
    r.ok("continue", "feat", "--blocked", "the review was inconclusive", "--gate", "1", "--updated", "src/change.ts");
    r.write("workflow-source.yml", GUIDED("review-second.md"));
    expect(r.ok("start", "feat")).not.toContain("--owner-approved --gate");
    expect(r.refused("continue", "feat", "--owner-approved", "--gate", "1")).toContain(
      "the step was blocked at review 1 (inspect the change) following review-first.md for reviewed-code, and an edit has changed " +
        "it since: it is now review 1 (inspect the change) following review-second.md for reviewed-code; the owner accepts the " +
        "whole step with --owner-approved alone",
    );
    expect(r.status("feat", "review")).toBe("BLOCKED");
  } finally {
    r.cleanup();
  }
});

test("a step awaiting the owner names the gates an edit added after its work was recorded, and is not approved until they run", () => {
  const r = new Repo();
  try {
    const flow = (gates: string) => `version: 1
name: add-gate
steps:
  - id: work
    instruction: Do the work.
    gates:
${gates}      - owner-action: approve the work
  - id: finish
    instruction: Finish.
`;
    r.start("feat", flow(""));
    r.ok("continue", "feat");
    expect(r.status("feat", "work")).toBe("AWAITING_OWNER");
    expect(r.ok("start", "feat")).not.toContain("have not run on it");
    r.write("workflow-source.yml", flow("      - script: \"false\"\n      - agent: review the work\n"));
    const handOver = r.ok("start", "feat");
    expect(handOver).toContain(
      "STATUS: awaiting owner action. The owner is asked to approve the work. An edit of the workflow added or changed gates " +
        "after the work was recorded, and they have not run on it: script `false`, review (review the work). It cannot be " +
        "approved until they have run.\n",
    );
    expect(handOver).toContain("  - Redo this step, so that the gates that have not run on its work run: script `false`, review (review the work).\n");
    // Approving would not run them, so it is refused until the step runs them.
    expect(r.refused("continue", "feat", "--owner-approved")).toContain("step work cannot be approved yet");
    expect(r.status("feat", "work")).toBe("AWAITING_OWNER");
  } finally {
    r.cleanup();
  }
});

const NOTES = `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
      - artifact: notes
        path: notes/
    gates:
      - agent: review the design
      - owner-action: approve the design
  - id: release
    instruction: Release it.
`;

test("a blocked step records a folder it created whole when no file in it is named, as a finished step does", () => {
  const r = new Repo();
  try {
    r.start("feat", NOTES);
    r.write("design.md");
    r.write("notes/a.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    expect(blocked).toContain("PRODUCED: design.md (new); notes/ (new)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/", status: "draft" },
    ]);
  } finally {
    r.cleanup();
  }

  // A folder that existed before the step does not say which files are the step's.
  const shared = new Repo();
  try {
    shared.write("notes/old.md");
    shared.start("feat", NOTES);
    shared.write("design.md");
    shared.write("notes/a.md");
    expect(shared.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1")).toContain("PRODUCED: design.md (new)\n");
    expect(shared.state("feat").steps.design.artifacts).toEqual([{ artifact: "sketch", path: "design.md", status: "draft" }]);
  } finally {
    shared.cleanup();
  }
});

test("files a blocked step recorded stay recorded when the agent later finishes the step without naming them again", () => {
  const r = new Repo();
  try {
    r.write("notes/old.md");
    r.start("feat", NOTES);
    r.write("design.md");
    r.write("notes/a.md");
    r.write("extra.md");
    r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "notes/a.md", "--updated", "extra.md");
    r.ok("continue", "feat", "--owner-approved", "--gate", "1");
    const done = r.ok("continue", "feat");
    expect(done).toContain("PRODUCED: design.md (new); notes/a.md (new); extra.md (updated, outside the declared paths)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/a.md", status: "draft" },
    ]);
  } finally {
    r.cleanup();
  }
});

test("a folder a blocked step recorded whole stays recorded whole when the agent later names a new file in it", () => {
  const r = new Repo();
  try {
    r.start(
      "feat",
      `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
      - artifact: notes
        path: notes/
    gates:
      - agent: review the design
  - id: release
    instruction: Release it.
    consumes: [notes]
`,
    );
    r.write("design.md");
    r.write("notes/a.md");
    r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    r.ok("continue", "feat", "--owner-approved", "--gate", "1");
    r.write("notes/b.md");
    const done = r.ok("continue", "feat", "--updated", "notes/b.md");
    // The owner accepted a review, not the work, and the step has no owner gate.
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "done" },
      { artifact: "notes", path: "notes/", status: "done" },
    ]);
    // The next step reads the whole folder, the file from before the block and the new one.
    expect(done).toContain("READ notes/ (from step design).");
  } finally {
    r.cleanup();
  }
});

// NOTES, with a next step that reads the notes.
const NOTES_READ = `version: 1
name: w
steps:
  - id: design
    instruction: Write the design.
    produces:
      - artifact: sketch
        path: design.md
      - artifact: notes
        path: notes/
    gates:
      - agent: review the design
  - id: release
    instruction: Release it.
    consumes: [notes]
`;

test("a folder a blocked step recorded whole stays recorded whole when a later block names a file in it", () => {
  const r = new Repo();
  try {
    r.start("feat", NOTES_READ);
    r.write("design.md");
    r.write("notes/a.md");
    r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    r.ok("continue", "feat", "--more-rounds", "1");
    r.write("notes/b.md");
    const blocked = r.ok("continue", "feat", "--blocked", "the review still does not converge", "--gate", "1", "--updated", "notes/b.md");
    expect(blocked).toContain("PRODUCED: design.md (new); notes/ (new)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/", status: "draft" },
    ]);
    // The next step reads the whole folder, not only the file the second block named.
    const next = r.ok("continue", "feat", "--owner-approved");
    expect(next).toContain("READ notes/ (from step design).");
    expect(next).not.toContain("READ notes/b.md");
  } finally {
    r.cleanup();
  }
});

test("files a blocked step named in a folder stay its record when a later block names none, as when the step finishes", () => {
  const r = new Repo();
  try {
    r.start("feat", NOTES_READ);
    r.write("design.md");
    r.write("notes/a.md");
    r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1", "--updated", "notes/a.md");
    r.ok("continue", "feat", "--more-rounds", "1");
    const blocked = r.ok("continue", "feat", "--blocked", "the review still does not converge", "--gate", "1");
    expect(blocked).toContain("PRODUCED: design.md (new); notes/a.md (new)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([
      { artifact: "sketch", path: "design.md", status: "draft" },
      { artifact: "notes", path: "notes/a.md", status: "draft" },
    ]);
  } finally {
    r.cleanup();
  }
});

test("a blocked step records a produced file that existed before the step, as a finished step does", () => {
  const r = new Repo();
  try {
    r.write("design.md", "someone else's\n");
    r.start("feat", NOTES_READ);
    r.write("design.md", "the step's own design\n");
    const blocked = r.ok("continue", "feat", "--blocked", "the review does not converge", "--gate", "1");
    expect(blocked).toContain("PRODUCED: design.md (updated)\n");
    expect(r.state("feat").steps.design.artifacts).toEqual([{ artifact: "sketch", path: "design.md", status: "draft" }]);

    r.ok("continue", "feat", "--owner-approved");
    expect(r.ok("status", "feat").split("\n").find((l) => l.includes(" design "))).toContain("design.md (approved)");
  } finally {
    r.cleanup();
  }
});

test("at the round cap the agent makes the last fixes, starts no further review, and names the fixes no reviewer has seen", () => {
  const r = new Repo();
  try {
    r.start("feat", REVIEWED);
    r.write("spec.md");
    const rule = "make the last round's fixes anyway, start no further review, and report the step blocked, naming the fixes no reviewer has seen";
    expect(r.ok("continue", "feat")).toContain(
      `After 2 such rounds, ${rule}: run \`fuse-flow continue feat --blocked "<what is still open, and the fixes no reviewer has seen>" --gate 1\`.`,
    );
    const blocked = r.ok("continue", "feat", "--blocked", "two P1 findings stay open", "--gate", "1");
    expect(blocked).toContain(
      "VERIFICATION: review (review the diff against the spec): <rounds used> of 2 rounds, <any required fix still open, and any fix made after the last review, which no reviewer has seen>\n",
    );
    // The review guide says it in the same words.
    expect(readFileSync(join(FLOW_DIR, "workflows", "fuse", "review.md"), "utf8").replace(/\s+/g, " ")).toContain(rule);
  } finally {
    r.cleanup();
  }
});

test("the step block prints a check's command with the variables fuse-flow sets, so it runs by hand as on continue", () => {
  const r = new Repo();
  try {
    const out = r.start(
      "env",
      `version: 1
name: env
steps:
  - id: probe
    instruction: x
    gates:
      - script: test "$FUSE_FLOW_SLUG/$FUSE_FLOW_STEP" = env/probe
`,
    );
    const command = /  1\. Run `(.*?)`\. Fix the work/.exec(out)?.[1];
    expect(command).toBe(`FUSE_FLOW_SLUG=env FUSE_FLOW_STEP=probe sh -c 'test "$FUSE_FLOW_SLUG/$FUSE_FLOW_STEP" = env/probe'`);
    const env = { ...r.env };
    delete env.FUSE_FLOW_SLUG;
    delete env.FUSE_FLOW_STEP;
    expect(Bun.spawnSync(["sh", "-c", command!], { cwd: r.root, env }).exitCode).toBe(0);
    expect(r.ok("continue", "env")).toContain("STATUS: workflow complete");
  } finally {
    r.cleanup();
  }
});

test("status shows each review gate's cap with the rounds granted, and the closing block says where to count the rounds", () => {
  const r = new Repo();
  try {
    r.start("feat", REVIEWED);
    r.write("spec.md");
    r.ok("continue", "feat");
    const row = () => r.ok("status", "feat").split("\n").find((l) => l.includes(" implement "));
    expect(row()).toContain("gates agent(review the diff against the spec) [cap 2]");
    r.ok("continue", "feat", "--more-rounds", "1");
    expect(row()).toContain("gates agent(review the diff against the spec) [cap 3, 2 plus 1 granted]");

    r.ok("continue", "feat");
    const closing = r.ok("continue", "feat");
    expect(closing).toContain(
      "VERIFICATION: implement: review (review the diff against the spec): <rounds used> of 3 (2 plus 1 granted by the owner) rounds, " +
        "counted from the findings files of the step's last pass, .konductor/reviews/feat/implement-round-<n>.json\n",
    );
  } finally {
    r.cleanup();
  }
});

test("two continue commands at once record the step once", async () => {
  const same = new Repo();
  try {
    same.start("feat", "version: 1\nname: same\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - script: sleep 1\n");
    const results = await Promise.all([same.runInBackground(["continue", "feat"]), same.runInBackground(["continue", "feat"])]);
    expect(results.map((r) => r.code).sort()).toEqual([0, 1]);
    expect(results.find((r) => r.code === 1)?.out).toContain('step "build" is COMPLETED now: another fuse-flow command moved it while this one ran. Run `fuse-flow start feat` to see where');
    expect(same.state("feat").steps.build).toMatchObject({ status: "COMPLETED" });
  } finally {
    same.cleanup();
  }
});

test("a continue that was running while the owner sent the work back to its step does not finish the new pass", async () => {
  const same = new Repo();
  try {
    same.start("feat", "version: 1\nname: same\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - script: touch started && sleep 2\n  - id: ship\n    instruction: y\n");
    const running = same.runInBackground(["continue", "feat"]);
    for (let i = 0; i < 100 && !existsSync(join(same.root, "started")); i++) await Bun.sleep(50);
    same.ok("continue", "feat", "--back-to", "build", "--note", "redo the build");
    const late = await running;
    expect(late.code).toBe(1);
    expect(late.out).toContain('step "build" was sent back to while this command ran and is in pass 2 now, so the checks this command ran on pass 1 are not recorded for it.');
    expect(same.state("feat").steps.build).toMatchObject({ status: "IN_PROGRESS", pass: 2 });
  } finally {
    same.cleanup();
  }
});

test("a failing continue that was running while the owner sent the work back records nothing in the new pass", async () => {
  const same = new Repo();
  try {
    same.write(".konductor/workflows/child.yml", "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Work.\n");
    same.start(
      "feat",
      "version: 1\nname: same\nsteps:\n  - id: build\n    instruction: x\n    gates:\n      - workflow: child\n" +
        '      - script: "touch started; while [ ! -f release ]; do sleep 0.02; done; false"\n  - id: ship\n    instruction: y\n',
    );
    same.ok("start", "feat-build");
    same.ok("continue", "feat-build");
    const running = same.runInBackground(["continue", "feat"]);
    for (let i = 0; i < 200 && !existsSync(join(same.root, "started")); i++) await Bun.sleep(25);
    same.ok("continue", "feat", "--back-to", "build", "--note", "redo the build");
    same.write("release");
    const late = await running;
    expect(late.code).toBe(1);
    expect(late.out).toContain('step "build" was sent back to while this command ran and is in pass 2 now, so the checks this command ran on pass 1 are not recorded for it.');
    const build = same.state("feat").steps.build;
    expect(build).toMatchObject({ status: "IN_PROGRESS", pass: 2 });
    expect(build.verification).toBeUndefined();
    const pass2 = build.history.slice(build.history.findLastIndex((h: string) => h.includes("owner sent the work back")));
    expect(pass2.filter((h: string) => h.includes("refused"))).toEqual([]);
    // The new pass's hand-over does not report the old pass's checks.
    const handover = same.ok("continue", "feat", "--blocked", "the new child has not run");
    expect(handover).toContain("VERIFICATION: workstream feat-build-2: not checked; script");
    expect(handover).not.toContain("workstream feat-build (child): complete");
  } finally {
    same.cleanup();
  }
});

test("the findings file of each review carries the review's --gate number", () => {
  repo.write(".konductor/policy-overrides.yml", "checks:\n  default: \"true\"\n");
  const out = repo.start(
    "f",
    `version: 1
name: f
steps:
  - id: build
    instruction: Build it.
    gates:
      - check: default
      - agent: review the code
      - agent: review the docs
`,
  );
  expect(out).toContain(".konductor/reviews/f/build-gate2-round-<n>.json");
  expect(out).toContain(".konductor/reviews/f/build-gate3-round-<n>.json");
  expect(out).toContain('" --gate 2`.');
  expect(out).toContain('" --gate 3`.');
  expect(out).not.toContain("build-gate1-round");
});

test("a step without an owner gate records its work as done, and a later owner gate approves it", () => {
  const r = new Repo();
  try {
    r.start(
      "feat",
      `version: 1
name: spec-then-design
steps:
  - id: intake
    instruction: Write the spec as a draft.
    produces: { artifact: spec, path: spec.md }
  - id: design
    instruction: Write the design.
    produces: { artifact: sketch, path: design.md }
    gates:
      - owner-action: approve the spec and the design
`,
    );
    r.write("spec.md");
    r.ok("continue", "feat");
    // No owner has seen the spec yet, so neither the state file nor status calls it approved.
    expect(r.state("feat").steps.intake.artifacts).toEqual([{ artifact: "spec", path: "spec.md", status: "done" }]);
    expect(r.state("feat").steps.intake.files).toEqual([{ artifact: "spec", path: "spec.md", kind: "whole", pass: "this", status: "done" }]);
    expect(r.ok("status", "feat")).toContain("spec.md (done)");
    r.write("design.md");
    r.ok("continue", "feat");
    expect(r.state("feat").steps.intake.artifacts[0].status).toBe("done");
    // The owner's gate approves the work of the steps before it that have no owner gate of their own.
    r.ok("continue", "feat", "--owner-approved");
    expect(r.state("feat").steps.intake.artifacts[0].status).toBe("approved");
    expect(r.state("feat").steps.intake.files[0].status).toBe("approved");
    expect(r.state("feat").steps.design.artifacts[0].status).toBe("approved");
  } finally {
    r.cleanup();
  }
});

test("a state file an earlier fuse-flow wrote with approved for a step without an owner gate is still read", () => {
  const r = new Repo();
  try {
    r.start("feat", "version: 1\nname: one\nsteps:\n  - id: intake\n    instruction: Write.\n    produces: { artifact: spec, path: spec.md }\n  - id: next\n    instruction: Go on.\n");
    r.write("spec.md");
    r.ok("continue", "feat");
    const file = ".konductor/workstreams/feat.yml";
    r.write(file, r.read(file).replaceAll("status: done", "status: approved"));
    expect(r.ok("status", "feat")).toContain("spec.md (approved)");
    expect(r.ok("start", "feat")).toContain("STEP next (2 of 2)");
  } finally {
    r.cleanup();
  }
});
