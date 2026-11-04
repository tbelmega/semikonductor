// SPDX-License-Identifier: Apache-2.0
// How a workflow ends: the final hand-over block says what was left open and
// that the workflow is over, status shows how a finished run went, list puts
// finished and closed workstreams away and marks idle ones, and a finished
// workstream is not reopened.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import YAML from "yaml";
import { Repo } from "./helpers";

const TWO_STEPS = `version: 1
name: small
steps:
  - id: one
    instruction: Do it.
  - id: two
    instruction: Then this.
`;

const OWNER_LAST = `version: 1
name: gated
steps:
  - id: one
    instruction: Do it.
  - id: sign-off
    instruction: Ask for sign-off.
    gates:
      - owner-action: the owner signs off
`;

const ENDED = "This workflow has ended: anything under NEXT STEP or LEFT OPEN happens outside it";
const HARNESS = "If your harness lets you mark the conversation as done";
const OWN_REPLY = "Tell the owner in your own reply too, not only in this block, that the workflow has ended";
const WARNING = "WARNING: no LEFT OPEN was recorded for this workstream";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
  repo.write(".konductor/workflows/small.yml", TWO_STEPS);
  repo.write(".konductor/workflows/gated.yml", OWNER_LAST);
});
afterEach(() => repo.cleanup());

// Moves every history timestamp and the start date of `slug` back to 2020.
function backdate(slug: string): void {
  const path = `.konductor/workstreams/${slug}.yml`;
  repo.write(path, repo.read(path).replace(/\d{4}-\d{2}-\d{2}T/g, "2020-01-01T").replace(/started: "?\d{4}-\d{2}-\d{2}"?/, "started: 2020-01-01"));
}

describe("the final hand-over block", () => {
  test("LEFT OPEN given with the last step's work is printed in the block and kept for status", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    const out = repo.ok("continue", "w", "--left-open", "the High finding is with the author");
    expect(out).toContain("- LEFT OPEN: the High finding is with the author\n");
    expect(out).not.toContain(WARNING);
    expect(repo.state("w").left_open).toBe("the High finding is with the author");
    expect(repo.ok("status", "w")).toContain("  left open: the High finding is with the author\n");
  });

  test("without LEFT OPEN the workstream still completes, and the block warns and asks for the line", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    const out = repo.ok("continue", "w");
    expect(out).toContain("- STATUS: workflow complete");
    expect(out).toContain("- LEFT OPEN: <what is still open for the owner");
    expect(out).toContain(WARNING);
    expect(out).toContain('`fuse-flow continue w --left-open "<text>"`');
    expect(repo.ok("status", "w")).toContain("  left open: not recorded\n");
  });

  test("a top-level workstream's block says the workflow ended, asks the agent to say so too, and names the harness line", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    const out = repo.ok("continue", "w", "--left-open", "none");
    expect(out).toContain(`- STATUS: workflow complete. ${ENDED}, with no step of it tracking it and no gate of it checking it.\n`);
    expect(out).toContain(OWN_REPLY);
    expect(out).toContain(HARNESS);
    // NEXT STEP, then LEFT OPEN, then DECISIONS.
    expect(out.indexOf("- NEXT STEP:")).toBeLessThan(out.indexOf("- LEFT OPEN:"));
    expect(out.indexOf("- LEFT OPEN:")).toBeLessThan(out.indexOf("- DECISIONS:"));
  });

  test("LEFT OPEN given with a step that is not the last is not kept, and the agent is told", () => {
    repo.ok("start", "w", "--workflow", "small");
    const out = repo.ok("continue", "w", "--left-open", "too early");
    expect(out).toContain("LEFT OPEN was not kept: the workflow goes on with step two.");
    expect(repo.state("w").left_open).toBeUndefined();
  });

  test("a send-back drops what was left open with the work it was about", () => {
    repo.ok("start", "w", "--workflow", "gated");
    repo.ok("continue", "w");
    repo.ok("continue", "w", "--left-open", "the sign-off notes");
    expect(repo.state("w").left_open).toBe("the sign-off notes");
    repo.ok("continue", "w", "--back-to", "one", "--note", "redo it");
    expect(repo.state("w").left_open).toBeUndefined();
  });

  test("--left-open goes with the report that the work is done, not with the owner's decisions or a block", () => {
    repo.ok("start", "w", "--workflow", "small");
    expect(repo.usage("continue", "w", "--blocked", "stuck", "--left-open", "x")).toContain("--left-open goes with the report that the work is done");
    expect(repo.refused("continue", "w", "--left-open", "  ")).toContain("--left-open needs the text");
  });
});

describe("recording LEFT OPEN after the end", () => {
  test("a workstream that ended at the owner's approval records LEFT OPEN once, and nothing else changes", () => {
    repo.ok("start", "w", "--workflow", "gated");
    repo.ok("continue", "w");
    repo.ok("continue", "w");
    repo.ok("continue", "w", "--owner-approved", "--note", "signed");
    const before = repo.state("w");
    expect(before.left_open).toBeUndefined();

    const out = repo.ok("continue", "w", "--left-open", "the launch email is still to send");
    expect(out).toContain("w: LEFT OPEN recorded");
    expect(out).toContain("- LEFT OPEN: the launch email is still to send\n");
    const after = repo.state("w");
    expect(after.left_open).toBe("the launch email is still to send");
    expect(after.steps).toEqual(before.steps);

    expect(repo.refused("continue", "w", "--left-open", "again")).toContain("already records what it left open: the launch email is still to send");
    expect(repo.refused("continue", "w")).toContain("workflow complete; there is nothing to continue");
  });

  test("--left-open on a complete workstream goes alone", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    repo.ok("continue", "w");
    repo.write("notes.md");
    expect(repo.refused("continue", "w", "--left-open", "x", "--updated", "notes.md")).toContain("Give --left-open alone");
    expect(repo.state("w").left_open).toBeUndefined();
  });
});

describe("a child workstream", () => {
  beforeEach(() => {
    repo.write(".konductor/workflows/child.yml", "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do the part.\n");
    repo.write(
      ".konductor/workflows/parent.yml",
      "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: Delegate.\n    gates:\n      - workflow: child\n  - id: wrap\n    instruction: Wrap up.\n",
    );
    repo.ok("start", "p", "--workflow", "parent");
  });

  const childSlug = () => repo.state("p").steps.delegate.children[0].slug as string;

  test("whose parent still waits prints LEFT OPEN but not the end statement or the harness line", () => {
    const child = childSlug();
    repo.ok("start", child);
    const out = repo.ok("continue", child, "--left-open", "one flaky test");
    expect(out).toContain("- LEFT OPEN: one flaky test\n");
    expect(out).toContain("- STATUS: workflow complete\n");
    expect(out).not.toContain(ENDED);
    expect(out).not.toContain(HARNESS);
    expect(out).not.toContain(OWN_REPLY);
  });

  test("ended with finish records LEFT OPEN the same way", () => {
    const child = childSlug();
    repo.ok("start", child);
    const failed = repo.ok("finish", child, "--outcome", "failed", "--reason", "the API is gone", "--left-open", "ask the API team");
    expect(failed).toContain("- LEFT OPEN: ask the API team\n");
    expect(repo.state(child).left_open).toBe("ask the API team");
  });

  test("finish without LEFT OPEN warns", () => {
    const child = childSlug();
    repo.ok("start", child);
    const out = repo.ok("finish", child, "--outcome", "failed", "--reason", "the API is gone");
    expect(out).toContain(WARNING);
  });
});

describe("status of a finished run", () => {
  test("prints the outcome, the owner's decisions with notes, the checks, the decisions file and LEFT OPEN, and no decision count", () => {
    repo.ok("start", "w", "--workflow", "gated");
    repo.ok("continue", "w");
    repo.ok("continue", "w", "--left-open", "nothing besides the email");
    repo.ok("continue", "w", "--owner-approved", "--note", "looks good");
    const out = repo.ok("status", "w");
    expect(out).toContain("END OF RUN\n");
    expect(out).toContain("  outcome: succeeded\n");
    expect(out).toContain("  owner's decisions: sign-off: approved: looks good\n");
    expect(out).toContain("  checks: none ran\n");
    expect(out).toContain("  decisions file: .konductor/decisions/w.md (not written)\n");
    expect(out).toContain("  left open: nothing besides the email\n");
    expect(out).not.toMatch(/open decisions?/i);
  });

  test("an unfinished workstream's status has no end-of-run summary", () => {
    repo.ok("start", "w", "--workflow", "small");
    expect(repo.ok("status", "w")).not.toContain("END OF RUN");
  });
});

describe("list", () => {
  test("hides complete and closed workstreams with a count, and --all shows them", () => {
    repo.ok("start", "done", "--workflow", "small");
    repo.ok("continue", "done");
    repo.ok("continue", "done");
    repo.ok("start", "dropped", "--workflow", "small");
    repo.ok("close", "dropped", "--note", "not needed");
    repo.ok("start", "live", "--workflow", "small");

    const out = repo.ok("list");
    expect(out).toMatch(/\n {2}live \(small, started [0-9-]+\): step one, 1 of 2, IN_PROGRESS\n/);
    expect(out).not.toContain("  done (");
    expect(out).not.toContain("  dropped (");
    expect(out).toContain("  2 complete or closed workstreams are not shown; `fuse-flow list --all` shows them\n");

    const all = repo.ok("list", "--all");
    expect(all).toContain("  done (small, started ");
    expect(all).toContain("  dropped (small, started ");
    expect(all).not.toContain("not shown");
  });

  test("with only finished workstreams, says none are unfinished", () => {
    repo.ok("start", "done", "--workflow", "small");
    repo.ok("continue", "done");
    repo.ok("continue", "done");
    expect(repo.ok("list")).toStartWith("WORKSTREAMS in this project: none unfinished\n");
  });

  test("marks a workstream idle after 7 days without a recorded change, but not one that waits for the owner", () => {
    repo.ok("start", "stale", "--workflow", "small");
    repo.ok("start", "waiting", "--workflow", "gated");
    repo.ok("continue", "waiting");
    repo.ok("continue", "waiting");
    repo.ok("start", "fresh", "--workflow", "small");
    backdate("stale");
    backdate("waiting");

    const out = repo.ok("list");
    expect(out).toMatch(/\n {2}stale \([^)]*\): step one, 1 of 2, IN_PROGRESS; idle: no recorded change for \d+ days, since 2020-01-01\n/);
    expect(out).toMatch(/\n {2}waiting \([^)]*\): step sign-off, 2 of 2, AWAITING_OWNER\n/);
    expect(out).toMatch(/\n {2}fresh \([^)]*\): step one, 1 of 2, IN_PROGRESS\n/);
  });

  test("the idle threshold comes from the policy", () => {
    repo.ok("start", "w", "--workflow", "small");
    const path = ".konductor/workstreams/w.yml";
    const fiveDaysAgo = new Date(Date.now() - 5 * 86_400_000).toISOString().slice(0, 10);
    repo.write(path, repo.read(path).replace(/\d{4}-\d{2}-\d{2}T/g, `${fiveDaysAgo}T`));
    expect(repo.ok("list")).not.toContain("idle:");
    repo.write(".konductor/policy-overrides.yml", "idle_days: 3\n");
    expect(repo.ok("list")).toMatch(/w \([^)]*\): step one, 1 of 2, IN_PROGRESS; idle: no recorded change for 5 days/);
  });

  test("--all is the only argument it takes", () => {
    expect(repo.usage("list", "--everything")).toContain("error: list takes no arguments but --all");
  });
});

describe("a finished workstream is not reopened", () => {
  test("continue refuses and names starting a new workstream after it; --back-to is refused too", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    repo.ok("continue", "w");
    const out = repo.refused("continue", "w");
    expect(out).toContain("workflow complete; there is nothing to continue. A finished workstream is not reopened");
    expect(out).toContain("`fuse-flow start <new-slug> --workflow <name or path> --after w`");
    expect(out).toContain("--after does not choose the workflow");
    expect(repo.refused("continue", "w", "--back-to", "one", "--note", "again")).toContain("workflow complete; there is nothing to continue");
  });

  test("list --all and status show which workstream followed which", () => {
    repo.ok("start", "w", "--workflow", "small");
    repo.ok("continue", "w");
    repo.ok("continue", "w");
    repo.ok("start", "w2", "--workflow", "small", "--after", "w");
    expect(repo.ok("list", "--all")).toContain("  w2 (small, started ");
    expect(repo.ok("list", "--all")).toMatch(/w2 \(small, started [0-9-]+, after w\)/);
    expect(repo.ok("status", "w")).toContain("started after it: w2");
    expect(repo.ok("status", "w2")).toContain("  after: w");
  });
});

describe("after the first review", () => {
  test("the end-of-run summary names the checks of skipped steps as not run", () => {
    repo.write(
      ".konductor/workflows/checked.yml",
      `version: 1
name: checked
steps:
  - id: build
    instruction: Build it.
    gates:
      - script: "true"
  - id: deploy
    instruction: Deploy it.
    gates:
      - script: "true"
`,
    );
    repo.ok("start", "w", "--workflow", "checked");
    repo.ok("continue", "w");
    repo.ok("continue", "w", "--skip", "the owner deploys by hand");
    const checks = repo.ok("status", "w").split("\n").find((l) => l.startsWith("  checks: "))!;
    expect(checks).toContain("build: script `true`: passed");
    expect(checks).toContain("deploy: script `true`: not run");
  });

  test("a workstream with no recorded event yet is idle from the day it started", () => {
    repo.write(".konductor/workflows/held.yml", 'version: 1\nname: held\nsteps:\n  - id: one\n    instruction: Do it.\n    condition: "check: unfamiliar"\n');
    repo.ok("start", "w", "--workflow", "held");
    const path = ".konductor/workstreams/w.yml";
    expect(repo.state("w").steps.one?.history ?? []).toEqual([]);
    repo.write(path, repo.read(path).replace(/started: "?\d{4}-\d{2}-\d{2}"?/, "started: 2020-01-01"));
    expect(repo.ok("list")).toMatch(/w \([^)]*\): step one, 1 of 1, PENDING; idle: no recorded change for \d+ days, since 2020-01-01/);
  });

  test("LEFT OPEN given before an owner gate that is not the last is dropped when the owner approves it", () => {
    repo.write(
      ".konductor/workflows/held-after.yml",
      `version: 1
name: held-after
steps:
  - id: one
    instruction: Do it.
    gates:
      - owner-action: the owner approves
  - id: two
    instruction: Then this.
    condition: "check: unfamiliar"
`,
    );
    repo.ok("start", "w", "--workflow", "held-after");
    repo.ok("continue", "w", "--left-open", "too early");
    repo.ok("continue", "w", "--owner-approved");
    expect(repo.state("w").steps.two.status).toBe("PENDING");
    expect(repo.state("w").left_open).toBeUndefined();
  });

  test("finish does not overwrite a LEFT OPEN recorded while it ran", async () => {
    repo.write(".konductor/workflows/child.yml", "version: 1\nname: child\nsteps:\n  - id: work\n    instruction: Do the part.\n");
    repo.write(
      ".konductor/workflows/parent.yml",
      "version: 1\nname: parent\nsteps:\n  - id: delegate\n    instruction: Delegate.\n    gates:\n      - workflow: child\n",
    );
    repo.ok("start", "p", "--workflow", "parent");
    const child = repo.state("p").steps.delegate.children[0].slug as string;
    repo.ok("start", child);
    repo.ok("continue", child);
    // Both race to record once; exactly one wins, and the winner's text stays.
    const [a, b] = await Promise.all([
      repo.runInBackground(["finish", child, "--outcome", "succeeded", "--left-open", "from finish"]),
      repo.runInBackground(["continue", child, "--left-open", "from continue"]),
    ]);
    const kept = repo.state(child).left_open;
    const winners = [a.code === 0 && "from finish", b.code === 0 && "from continue"].filter(Boolean);
    expect(winners).toEqual([kept]);
  });
});

describe("after the second review", () => {
  test("dropping an early LEFT OPEN does not delete one recorded while the command waited for the lock", async () => {
    repo.write(
      ".konductor/workflows/held-after.yml",
      `version: 1
name: held-after
steps:
  - id: one
    instruction: Do it.
    gates:
      - owner-action: the owner approves
  - id: two
    instruction: Then this.
    condition: "check: unfamiliar"
`,
    );
    repo.ok("start", "w", "--workflow", "held-after");
    repo.ok("continue", "w");
    repo.ok("continue", "w", "--owner-approved");
    const path = ".konductor/workstreams/w.yml";
    // The early text, as a command finishing step one would have left it.
    const early = YAML.parse(repo.read(path));
    early.left_open = "early";
    repo.write(path, YAML.stringify(early));

    // Hold the state file's lock, so `continue` reads the early text and then
    // waits for the lock to drop it.
    repo.write(`${path}.lock`, "0\n");
    const waiting = repo.runInBackground(["continue", "w"]);
    await Bun.sleep(1000);
    // Meanwhile, as another command would under the lock: the owner skips
    // step two and the agent records the final text.
    const later = YAML.parse(repo.read(path));
    later.steps.two = { status: "SKIPPED", skip_reason: "the owner skipped it", artifacts: [], history: [] };
    later.left_open = "final";
    repo.write(path, YAML.stringify(later));
    repo.cleanupPath(`${path}.lock`);

    // Refused either way: step two was pending, or the workflow is complete now.
    expect((await waiting).code).toBe(1);
    expect(repo.state("w").left_open).toBe("final");
  });
});

test("the end-of-run summary names the checks that ran as step conditions, with their results", () => {
  repo.write(
    ".konductor/workflows/conditional.yml",
    `version: 1
name: conditional
steps:
  - id: one
    instruction: Do it.
    condition: { script: "true" }
  - id: two
    instruction: Then this.
    condition: { script: "false" }
`,
  );
  repo.ok("start", "w", "--workflow", "conditional");
  repo.ok("continue", "w");
  const checks = repo.ok("status", "w").split("\n").find((l) => l.startsWith("  checks: "))!;
  expect(checks).toContain("one: condition `true`: exited 0");
  expect(checks).toContain("two: condition `false`: exited 1");
});

test("a condition is reported as the command that ran, and one an edit put in its place as not run", () => {
  const conditional = (script: string) => `version: 1\nname: conditional\nsteps:\n  - id: one\n    instruction: Do it.\n    condition: { script: "${script}" }\n`;
  repo.write(".konductor/workflows/conditional.yml", conditional("true"));
  repo.ok("start", "w", "--workflow", "conditional");
  repo.ok("continue", "w");
  repo.write(".konductor/workflows/conditional.yml", conditional("test -n x"));
  const checks = repo.ok("status", "w").split("\n").find((l) => l.startsWith("  checks: "))!;
  expect(checks).toContain("one: condition `true`: exited 0");
  expect(checks).toContain("one: condition script `test -n x`: not run");
});

test("a multi-line condition command with backticks in it is reported with its result", () => {
  repo.write(
    ".konductor/workflows/conditional.yml",
    "version: 1\nname: conditional\nsteps:\n  - id: one\n    instruction: Do it.\n    condition:\n      script: |\n        echo `pwd`\n        true\n",
  );
  repo.ok("start", "w", "--workflow", "conditional");
  repo.ok("continue", "w");
  const status = repo.ok("status", "w");
  // The command as fuse-flow ran it, without the block scalar's final newline.
  expect(status).toContain("one: condition `echo `pwd`\ntrue`: exited 0");
  expect(status).not.toContain(": not run");
});

test("a condition that ran stays in the summary after an edit removes it or makes it the agent's", () => {
  const conditional = (condition: string) => `version: 1\nname: conditional\nsteps:\n  - id: one\n    instruction: Do it.\n${condition}`;
  repo.write(".konductor/workflows/conditional.yml", conditional('    condition: { script: "true" }\n'));
  repo.ok("start", "w", "--workflow", "conditional");
  repo.ok("continue", "w");
  for (const edit of ["", '    condition: { agent: "the change touches the API" }\n']) {
    repo.write(".konductor/workflows/conditional.yml", conditional(edit));
    const checks = repo.ok("status", "w").split("\n").find((l) => l.startsWith("  checks: "))!;
    expect(checks).toBe("  checks: one: condition `true`: exited 0");
  }
});
