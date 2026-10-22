// SPDX-License-Identifier: Apache-2.0
// Who reviews and how the reviewer is started come from the policy files, as
// do the owner's rulings where fuse-flow and the house rules overlap.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { Repo } from "./helpers";

const FLOW = `version: 1
name: reviewed
steps:
  - id: build
    instruction: Build it.
    updates:
      - artifact: patch
        path: src/
    gates:
      - agent: review the diff against the spec
`;

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

test("the reviewer table merges across the policy files, the more specific file winning per author model", () => {
  expect(repo.start("feat", FLOW)).not.toContain("Pick the reviewer's model");

  repo.write(
    "home/.konductor/policy-overrides.yml",
    "review:\n  reviewers:\n    claude-opus-5.5: { model: gpt-6.1-sol, effort: high }\n    gpt-6.1-sol: { model: claude-opus-5.5, effort: high }\n",
  );
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  reviewers:\n    gpt-6.1-sol: { model: claude-opus-5.6 }\n");
  expect(repo.ok("start", "feat")).toContain(
    "Pick the reviewer's model by the model you run on: if you run on claude-opus-5.5, gpt-6.1-sol at high effort; " +
      "if you run on gpt-6.1-sol, claude-opus-5.6. If yours is not listed, follow the review guide.",
  );
});

test("a launch command replaces the subagent, and the findings file stays where the author reads it", () => {
  // With no launch in any policy file, the house rules may name one.
  expect(repo.start("feat", FLOW)).toContain(
    "Start the reviewer the way the house rules ask, such as a review command they name, or else as a fresh " +
      "subagent in your own harness, with none of your context.",
  );

  // A launch set in policy is a setting: it is printed as it is, without deferring to house rules.
  repo.write(".konductor/policy-overrides.yml", "review:\n  launch: subagent\n");
  const set = repo.ok("start", "feat");
  expect(set).toContain("Start the reviewer as a fresh subagent in your own harness, with none of your context.");
  expect(set).not.toContain("house rules ask");

  repo.write(".konductor/policy-overrides.yml", 'review:\n  launch:\n    command: opencode run -m {model} "$(cat {prompt_file})"\n');
  const out = repo.ok("start", "feat");
  expect(out).not.toContain("fresh subagent");
  expect(out).not.toContain("house rules ask");
  expect(out).toContain(
    'Start the reviewer with `opencode run -m {model} "$(cat {prompt_file})"`, with none of your context. In a launch ' +
      "command, replace {model} and {effort} with the reviewer's, {prompt_file} with a file you write the review " +
      "request to, and {findings_file} with the findings file.",
  );
  expect(out).toContain("The reviewer writes its findings to .konductor/reviews/feat/build-round-<n>.json");
  // The agent waits for the command, so it must return once the findings are written.
  expect(out).toContain(
    "A launch command must return once the reviewer has written the findings file; one that has not returned has not finished the round.",
  );
  expect(set).not.toContain("A launch command must return");
  // Findings are private to the checkout, like the workstream state.
  expect(repo.read(".konductor/reviews/.gitignore")).toBe("*\n");
});

test("a reviewer row can be started its own way, such as a model only another harness runs", () => {
  repo.write(
    "home/.konductor/policy-overrides.yml",
    "review:\n  reviewers:\n" +
      "    claude-opus-5.5:\n      model: gpt-6.1-sol\n      launch:\n        command: opencode run -m {model}\n" +
      "    gpt-6.1-sol: { model: claude-opus-5.5, launch: subagent }\n",
  );
  const out = repo.start("feat", FLOW);
  expect(out).toContain(
    "if you run on claude-opus-5.5, gpt-6.1-sol, started with `opencode run -m {model}`; if you run on gpt-6.1-sol, " +
      "claude-opus-5.5, started as a fresh subagent in your own harness. If yours is not listed, follow the review guide. " +
      "For a row that names no start of its own, and for a model not listed, start the reviewer the way the house rules " +
      "ask, such as a review command they name, or else as a fresh subagent in your own harness. Start it with none " +
      "of your context. In a launch command, replace {model}",
  );

  // When a policy file sets the same launch for every reviewer, a row's matching launch goes without saying.
  repo.write(".konductor/policy-overrides.yml", "review:\n  launch: subagent\n");
  expect(repo.ok("start", "feat")).toContain(
    "if you run on gpt-6.1-sol, claude-opus-5.5. If yours is not listed, follow the review guide. For a row that " +
      "names no start of its own, and for a model not listed, start the reviewer as a fresh subagent in your own harness.",
  );
});

test("the owner's rulings from every policy file are printed with the step, the user's first", () => {
  expect(repo.start("feat", FLOW)).not.toContain("RULINGS");

  repo.write("home/.konductor/policy-overrides.yml", "rulings:\n  - Commit messages follow the house rules.\n");
  repo.write(
    ".konductor/policy-overrides.local.yml",
    "rulings:\n  - In fuse-flow workstreams, the workflow's review gates replace the review loop of the project's own review skill.\n",
  );
  expect(repo.ok("start", "feat")).toContain(
    "STEP build (1 of 1): Build it.\n" +
      "RULINGS: where this workflow and the house rules overlap, the owner ruled:\n" +
      "  - Commit messages follow the house rules.\n" +
      "  - In fuse-flow workstreams, the workflow's review gates replace the review loop of the project's own review skill.\n",
  );
});

test("a launch that is neither subagent nor a command is refused with the file that holds it", () => {
  repo.start("feat", FLOW);
  repo.write(".konductor/policy-overrides.yml", "review:\n  launch: terminal\n");
  expect(repo.refused("start", "feat")).toContain(".konductor/policy-overrides.yml is not a valid policy file");
});

test("on a step with a review, the lines for stopping early ask for the rounds used and any required fix still open", () => {
  expect(repo.start("feat", FLOW)).toContain(
    "  VERIFICATION: <the check results so far, the review rounds used of the cap, and any required fix still open; or none>\n",
  );
});

test("a policy's review guide that does not exist is refused, naming the file and the path", () => {
  repo.start("feat", FLOW);
  repo.write(".konductor/policy-overrides.yml", "review:\n  guide: guides/review.md\n");
  const out = repo.refused("start", "feat");
  expect(out).toContain(".konductor/policy-overrides.yml sets review.guide to guides/review.md");
  expect(out).toContain(".konductor/guides/review.md does not exist");
  repo.write(".konductor/guides/review.md", "# review\n");
  expect(repo.ok("start", "feat")).toContain("It reviews src/ against .konductor/guides/review.md.");
});

test("the local policy file is kept out of git, as the workstreams and reviews are", () => {
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  max_rounds: 3\n");
  repo.start("feat", FLOW);
  expect(repo.read(".konductor/.gitignore")).toBe("/policy-overrides.local.yml\n");
  // A .gitignore the project keeps there gains the line once, and keeps its own lines.
  repo.write(".konductor/.gitignore", "/scratch/\n");
  repo.ok("status", "feat");
  repo.ok("status", "feat");
  expect(repo.read(".konductor/.gitignore")).toBe("/scratch/\n/policy-overrides.local.yml\n");
});

describe("the review guide that applies must be a file; one it overrides need not exist", () => {
  const GATED = FLOW.replace("      - agent: review the diff against the spec\n", "      - agent: review the diff against the spec\n        guide: missing.md\n");

  test("a project policy's guide replaces a gate's guide that does not exist", () => {
    repo.write(".konductor/review-guides/actual.md", "# review\n");
    repo.write(".konductor/policy-overrides.yml", "review:\n  guide: review-guides/actual.md\n");
    expect(repo.start("feat", GATED)).toContain("It reviews src/ against .konductor/review-guides/actual.md.");
    expect(repo.ok("validate", "workflow-source.yml")).toContain("valid:   ");
  });

  test("a team policy's guide replaces a user policy's guide that does not exist", () => {
    repo.write("home/.konductor/policy-overrides.yml", "review:\n  guide: nowhere.md\n");
    repo.write(".konductor/review-guides/actual.md", "# review\n");
    repo.write(".konductor/policy-overrides.yml", "review:\n  guide: review-guides/actual.md\n");
    expect(repo.start("feat", FLOW)).toContain("It reviews src/ against .konductor/review-guides/actual.md.");
  });

  test("a user policy's guide that does not exist and applies is refused", () => {
    repo.write("home/.konductor/policy-overrides.yml", "review:\n  guide: nowhere.md\n");
    const out = repo.refused("start", "feat", "--workflow", repo.write("workflow-source.yml", FLOW));
    expect(out).toContain("policy-overrides.yml sets review.guide to nowhere.md");
    expect(out).toContain("nowhere.md does not exist");
    expect(repo.run(["status", "feat"]).out).toContain('no workstream "feat"');
  });

  test("a folder is not a review guide, from a gate or from a policy", () => {
    repo.write("guides/.keep", "");
    const gate = repo.write("dir.yml", FLOW.replace("      - agent: review the diff against the spec\n", "      - agent: review the diff against the spec\n        guide: guides/\n"));
    expect(repo.refused("start", "feat", "--workflow", gate)).toContain(`the review guide of agent(review the diff against the spec) is a folder, not a file: ${repo.root}/guides`);
    expect(repo.refused("validate", "dir.yml")).toContain("is a folder, not a file");
    repo.write(".konductor/guides/.keep", "");
    repo.write(".konductor/policy-overrides.yml", "review:\n  guide: guides/\n");
    expect(repo.refused("start", "other", "--workflow", repo.write("workflow-source.yml", FLOW))).toContain(
      ".konductor/policy-overrides.yml sets review.guide to guides/, and " + `${repo.root}/.konductor/guides is a folder, not a file`,
    );
  });
});

test("the local policy file is kept out of git when a later line of .konductor/.gitignore negates the rule", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo.root, ...args], { env: repo.env });
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  expect(git("init", "-q").exitCode).toBe(0);
  repo.write(".konductor/.gitignore", "/policy-overrides.local.yml\n!*.yml\n");
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  max_rounds: 3\n");
  repo.start("feat", FLOW);
  expect(git("check-ignore", "-q", ".konductor/policy-overrides.local.yml").exitCode).toBe(0);
  const once = repo.read(".konductor/.gitignore");
  repo.ok("status", "feat");
  expect(repo.read(".konductor/.gitignore")).toBe(once);
});

describe("a delegated workflow's review guide is checked as it applies, before any workstream is created", () => {
  const PARENT = `version: 1
name: parent
steps:
  - id: delegate
    instruction: Delegate the review.
    gates:
      - workflow: child
`;
  const CHILD = `version: 1
name: child
steps:
  - id: build
    instruction: Build it.
    updates:
      - artifact: patch
        path: src/
    gates:
      - agent: review the diff
        guide: missing.md
`;

  test("a child whose guide does not exist is refused by validate and by start, and no workstream is created", () => {
    repo.write(".konductor/workflows/child.yml", CHILD);
    const parent = repo.write(".konductor/workflows/parent.yml", PARENT);
    const invalid = repo.refused("validate", parent);
    expect(invalid).toContain("step delegate, workflow child: ");
    expect(invalid).toContain("the review guide of agent(review the diff) does not exist");
    expect(repo.refused("start", "s", "--workflow", "parent")).toContain("the review guide of agent(review the diff) does not exist");
    expect(repo.run(["status", "s"]).out).toContain('no workstream "s"');
    expect(repo.run(["status", "s-delegate"]).out).toContain('no workstream "s-delegate"');
  });

  test("a project policy's guide that exists makes the same child usable", () => {
    repo.write(".konductor/workflows/child.yml", CHILD);
    repo.write(".konductor/workflows/parent.yml", PARENT);
    repo.write(".konductor/review-guides/actual.md", "# review\n");
    repo.write(".konductor/policy-overrides.yml", "review:\n  guide: review-guides/actual.md\n");
    expect(repo.ok("validate", "parent")).toContain("valid:   ");
    repo.ok("start", "s", "--workflow", "parent");
    expect(repo.ok("start", "s-delegate")).toContain("It reviews src/ against .konductor/review-guides/actual.md.");
  });

  test("a child whose guide went missing after the workflow started is not created, and the step says why", () => {
    repo.write(".konductor/guides/team.md", "# review\n");
    repo.write(".konductor/workflows/child.yml", CHILD.replace("missing.md", "../guides/team.md"));
    repo.write(".konductor/workflows/parent.yml", `version: 1\nname: parent\nsteps:\n  - id: intake\n    instruction: Read the request.\n${PARENT.split("steps:\n")[1]}`);
    repo.ok("start", "s", "--workflow", "parent");
    rmSync(join(repo.root, ".konductor/guides/team.md"));
    const out = repo.ok("continue", "s");
    expect(out).toContain("the review guide of agent(review the diff) does not exist");
    expect(out).not.toContain("fuse-flow start s-delegate");
    expect(repo.run(["status", "s-delegate"]).out).toContain('no workstream "s-delegate"');
  });

  test("an existing child whose guide went missing is not handed out, and a finished one still counts", () => {
    repo.write(".konductor/guides/team.md", "# review\n");
    repo.write(".konductor/workflows/child.yml", CHILD.replace("missing.md", "../guides/team.md"));
    repo.write(".konductor/workflows/parent.yml", PARENT);
    repo.ok("start", "s", "--workflow", "parent");
    expect(repo.ok("status", "s-delegate")).toContain("workstream s-delegate");
    rmSync(join(repo.root, ".konductor/guides/team.md"));
    const missing = "the review guide of agent(review the diff) does not exist";
    const out = repo.ok("start", "s");
    expect(out).toContain("STEP delegate (1 of 1) waits for a child workstream that cannot be used: a review guide cannot be followed");
    expect(out).toContain(missing);
    expect(out).not.toContain("fuse-flow start s-delegate");
    expect(repo.refused("start", "s-delegate")).toContain(missing);

    repo.write(".konductor/guides/team.md", "# review\n");
    repo.ok("start", "s-delegate");
    repo.ok("continue", "s-delegate", "--skip", "The owner waived the build.");
    rmSync(join(repo.root, ".konductor/guides/team.md"));
    expect(repo.ok("start", "s")).not.toContain(missing);
    expect(repo.ok("continue", "s")).toContain("delegate: COMPLETED");
  });
});

describe("a review guide that went missing blocks only the steps that still print it", () => {
  const TWO = `version: 1
name: two
steps:
  - id: write
    instruction: Write the note.
    produces: { artifact: note, path: docs/note.md }
    gates:
      - agent: review the note
        guide: guides/team.md
  - id: ship
    instruction: Ship it.
    gates:
      - owner-action: approve
`;

  test("after the step with that review is done, status, list, start and the owner's decisions still work", () => {
    repo.write("guides/team.md", "# review\n");
    repo.start("m1", TWO);
    repo.write("docs/note.md");
    repo.reviewed("m1", "write");
    repo.ok("continue", "m1");
    rmSync(join(repo.root, "guides/team.md"));
    expect(repo.ok("status", "m1")).toContain("> ship");
    expect(repo.ok("list")).toContain("  m1 (two, started ");
    expect(repo.ok("start", "m1")).toContain("STEP ship (2 of 2)");
    const missing = `the review guide of agent(review the note) does not exist: ${repo.root}/guides/team.md`;
    expect(repo.refused("continue", "m1", "--back-to", "write")).toContain(missing);
    expect(repo.status("m1", "write")).toBe("COMPLETED");
    expect(repo.ok("continue", "m1", "--skip", "the owner shipped it by hand")).toContain("ship: SKIPPED");
  });

  test("while that step is still to come, start and continue refuse it and name the file; status and list still read the workstream", () => {
    repo.write("guides/team.md", "# review\n");
    repo.start("m1", TWO);
    rmSync(join(repo.root, "guides/team.md"));
    const missing = `the review guide of agent(review the note) does not exist: ${repo.root}/guides/team.md`;
    expect(repo.refused("start", "m1")).toContain(missing);
    expect(repo.refused("continue", "m1")).toContain(missing);
    expect(repo.ok("status", "m1")).toContain("> write");
    expect(repo.ok("list")).toContain("  m1 (two, started ");
  });

  test("the owner can skip or jump past the review whose guide is missing, but not past a step before it", () => {
    const missing = `the review guide of agent(review the note) does not exist: ${repo.root}/guides/team.md`;
    repo.write("guides/team.md", "# review\n");
    repo.start("m1", TWO);
    repo.ok("start", "m2", "--workflow", join(repo.root, "workflow-source.yml"));
    repo.ok("start", "m3", "--workflow", repo.write("three.yml", `version: 1\nname: three\nsteps:\n  - id: intake\n    instruction: Read the request.\n${TWO.split("steps:\n")[1]}`));
    rmSync(join(repo.root, "guides/team.md"));
    expect(repo.ok("continue", "m1", "--skip", "The owner waived this review.")).toContain("write: SKIPPED");
    expect(repo.status("m1", "ship")).toBe("IN_PROGRESS");
    repo.ok("continue", "m2", "--forward-to", "ship");
    expect(repo.status("m2", "write")).toBe("SKIPPED");
    expect(repo.status("m2", "ship")).toBe("IN_PROGRESS");
    expect(repo.refused("continue", "m3", "--skip", "Nothing to read.")).toContain(missing);
    expect(repo.status("m3", "intake")).toBe("IN_PROGRESS");
    expect(repo.ok("start", "m4", "--workflow", join(repo.root, "three.yml"), "--from", "ship")).toContain("STEP ship (3 of 3)");
    expect(repo.refused("start", "m5", "--workflow", join(repo.root, "three.yml"), "--from", "intake")).toContain(missing);
  });

  test("a jump the hand-out overtakes, as a condition that now skips the step, never prints a review guide that is missing", () => {
    const missing = `the review guide of agent(review the note) does not exist: ${repo.root}/guides/team.md`;
    repo.write("guides/team.md", "# review\n");
    const conditional = `version: 1\nname: conditional\nsteps:\n  - id: intake\n    condition: "check: wanted"\n    instruction: Read the request.\n${TWO.split("steps:\n")[1]}`;
    expect(repo.start("m1", conditional)).toContain("checks: { wanted: <command> }");
    expect(repo.status("m1", "intake")).toBe("PENDING");
    repo.write(".konductor/policy-overrides.yml", 'checks:\n  wanted: "false"\n');
    rmSync(join(repo.root, "guides/team.md"));
    const out = repo.refused("continue", "m1", "--forward-to", "ship");
    expect(out).toContain(missing);
    expect(out).not.toContain("against guides/team.md");
  });

  test("a new workstream started --from past a delegating step needs no review guide of that step's child", () => {
    const missing = "the review guide of agent(review the note) does not exist";
    repo.write("guides/team.md", "# review\n");
    repo.write(".konductor/workflows/child.yml", TWO.replace("name: two", "name: child").replace("guides/team.md", "../../guides/team.md"));
    repo.write(
      ".konductor/workflows/parent.yml",
      "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: Delegate the note.\n    gates:\n      - workflow: child\n  - id: ship\n    instruction: Ship it.\n",
    );
    repo.ok("validate", "parent");
    rmSync(join(repo.root, "guides/team.md"));
    expect(repo.refused("validate", "parent")).toContain(missing);
    expect(repo.refused("start", "m1", "--workflow", "parent")).toContain(missing);
    expect(repo.ok("start", "m2", "--workflow", "parent", "--from", "ship")).toContain("STEP ship (2 of 2)");
    expect(repo.status("m2", "delegate")).toBe("SKIPPED");
  });
});

test("the local policy file is kept out of git when the last rule of .konductor/.gitignore only looks like ours", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo.root, ...args], { env: repo.env });
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  expect(git("init", "-q").exitCode).toBe(0);
  // Git keeps leading spaces as part of the pattern, so this rule matches nothing.
  repo.write(".konductor/.gitignore", "  /policy-overrides.local.yml\n");
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  max_rounds: 3\n");
  repo.start("feat", FLOW);
  expect(git("check-ignore", "-q", ".konductor/policy-overrides.local.yml").exitCode).toBe(0);
  const once = repo.read(".konductor/.gitignore");
  repo.ok("status", "feat");
  expect(repo.read(".konductor/.gitignore")).toBe(once);
});

test("the local policy file is kept out of git when the last rule of .konductor/.gitignore ends in a tab, which git keeps", () => {
  const git = (...args: string[]) => Bun.spawnSync(["git", "-C", repo.root, ...args], { env: repo.env });
  rmSync(join(repo.root, ".git"), { recursive: true, force: true });
  expect(git("init", "-q").exitCode).toBe(0);
  repo.write(".konductor/.gitignore", "/policy-overrides.local.yml\t\n");
  repo.write(".konductor/policy-overrides.local.yml", "review:\n  max_rounds: 3\n");
  repo.start("feat", FLOW);
  expect(git("check-ignore", "-q", ".konductor/policy-overrides.local.yml").exitCode).toBe(0);
  const once = repo.read(".konductor/.gitignore");
  repo.ok("status", "feat");
  expect(repo.read(".konductor/.gitignore")).toBe(once);
});
