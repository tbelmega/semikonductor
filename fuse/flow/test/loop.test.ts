// SPDX-License-Identifier: Apache-2.0
// Loop gates: a gate with repeat_from starts the steps from there again while
// it does not pass, instead of refusing or blocking. Each cycle is a new pass
// of the steps in the loop, needs no owner decision, and leaves the status of
// what the steps wrote alone.

import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FLOW_DIR, Repo } from "./helpers";

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

// A loop over poll and respond, closed by `gate` on respond, with report after it.
const looping = (gate: string, extra = "") => `version: 1
name: looping
steps:
  - id: open
    instruction: Open the pull requests.
  - id: poll
    instruction: Poll every pull request.
    produces:
      - artifact: ledger
        path: ledger.md
  - id: respond
    instruction: Act on new feedback.
    gates:
${gate}${extra}
  - id: report
    instruction: Write the report.
`;

const SCRIPT_LOOP = looping("      - script: test -f done.flag\n        repeat_from: poll\n        interval: 15m\n        max_cycles: 5");
const AGENT_LOOP = looping("      - agent: every pull request is merged or blocked\n        repeat_from: poll");
const OWNER_LOOP = looping("      - owner-action: confirm the deployment is healthy\n        repeat_from: poll");

// Through open and the first poll, so respond is handed out in cycle 1.
function toRespond(slug: string, yaml: string): void {
  repo.start(slug, yaml);
  repo.ok("continue", slug);
  repo.write("ledger.md", "# Ledger\n");
  repo.ok("continue", slug);
  expect(repo.status(slug, "respond")).toBe("IN_PROGRESS");
}

const cycleLines = (slug: string, step: string) =>
  (repo.state(slug).steps[step].history as string[]).filter((h) => / cycle \d+ of the loop at /.test(h));

// ---------------------------------------------------------------- E1 validate

function validateOut(yaml: string): { code: number; out: string } {
  const file = repo.write("flows/wf.yml", yaml);
  return repo.run(["validate", file]);
}

test("validate accepts repeat_from on check, script, owner-action and agent gates", () => {
  for (const gate of [
    "      - check: default\n        repeat_from: poll",
    "      - script: test -f x\n        repeat_from: poll",
    "      - owner-action: approve\n        repeat_from: poll",
    "      - agent: every pull request is merged or blocked\n        repeat_from: poll\n        interval: 15m\n        max_cycles: 300",
    "      - script: test -f x\n        repeat_from: respond",
  ]) {
    const r = validateOut(looping(gate));
    expect(r.out).toContain("valid:");
    expect(r.code).toBe(0);
  }
});

test("validate refuses the loop gates the engine cannot run", () => {
  const refusals: [string, string][] = [
    [looping("      - workflow: other\n        repeat_from: poll"), "a workflow gate cannot be a loop gate"],
    [looping("      - script: test -f x\n        repeat_from: report"), 'repeats from "report", which is not this step or a step listed before it'],
    [looping("      - script: test -f x\n        repeat_from: nowhere"), 'repeats from "nowhere", which is not this step or a step listed before it'],
    [looping("      - script: test -f x\n        repeat_from: poll\n      - check: default"), 'the loop gate of "respond" must be its last gate'],
    [looping("      - script: test -f x\n        repeat_from: poll\n      - agent: done\n        repeat_from: poll"), '"respond" has 2 loop gates; a step has at most one'],
    [looping("      - script: test -f x\n        repeat_from: poll", "\n    condition:\n      agent: there is feedback"), '"respond" carries a loop gate, so it must be mandatory'],
    [looping("      - agent: done\n        repeat_from: poll\n        max_rounds: 2"), "max_rounds does not go on a loop gate; max_cycles caps it"],
    [looping("      - script: test -f x\n        interval: 15m"), "interval goes on a loop gate only, with repeat_from"],
    [looping("      - script: test -f x\n        max_cycles: 3"), "max_cycles goes on a loop gate only, with repeat_from"],
    [looping("      - script: test -f x\n        repeat_from: poll\n        interval: soon"), "interval is a duration such as 15m, 2h or 1d"],
    [looping("      - script: test -f x\n        repeat_from: poll\n        max_cycles: 0"), "max_cycles must be a whole number, 1 or more"],
  ];
  for (const [yaml, message] of refusals) {
    const r = validateOut(yaml);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(message);
  }
});

test("validate refuses nested and overlapping loops, and a workflow gate inside a loop", () => {
  const steps = (respondGate: string, pollGate = "") => `version: 1
name: nested
steps:
  - id: open
    instruction: x
  - id: poll
    instruction: x${pollGate}
  - id: respond
    instruction: x
    gates:
${respondGate}
`;
  const nested = validateOut(
    steps("      - script: test -f a\n        repeat_from: open", "\n    gates:\n      - script: test -f b\n        repeat_from: poll"),
  );
  expect(nested.code).not.toBe(0);
  expect(nested.out).toContain('the loop at "respond" overlaps the loop at "poll"; loops may neither nest nor overlap');

  const overlapping = validateOut(
    steps("      - script: test -f a\n        repeat_from: poll", "\n    gates:\n      - script: test -f b\n        repeat_from: open"),
  );
  expect(overlapping.code).not.toBe(0);
  expect(overlapping.out).toContain('the loop at "respond" overlaps the loop at "poll"; loops may neither nest nor overlap');

  const delegating = validateOut(steps("      - script: test -f a\n        repeat_from: open", "\n    gates:\n      - workflow: other"));
  expect(delegating.code).not.toBe(0);
  expect(delegating.out).toContain('"poll" has a workflow gate inside the loop at "respond"; a loop cannot repeat a child workstream');
});

test("validate refuses another owner-action gate on a step that carries a loop gate", () => {
  const r = validateOut(looping("      - owner-action: approve the replies\n      - script: test -f x\n        repeat_from: poll"));
  expect(r.code).not.toBe(0);
  expect(r.out).toContain('"respond" carries a loop gate, so it has no other owner-action gate');
});

// ---------------------------------------------------------------- E2 script

test("a script loop gate that fails starts the next cycle at repeat_from; one that passes completes the step", () => {
  toRespond("feat", SCRIPT_LOOP);
  const out = repo.ok("continue", "feat");
  expect(out).toContain("respond: the loop gate did not pass, so cycle 2 of the loop at respond starts at poll");
  expect(out).toContain("STEP poll (2 of 4)");
  const ws = repo.state("feat");
  expect(ws.steps.poll.status).toBe("IN_PROGRESS");
  expect(ws.steps.respond.status).toBe("PENDING");
  expect(ws.steps.respond.cycle).toBe(2);
  expect(cycleLines("feat", "respond")).toHaveLength(1);
  expect(cycleLines("feat", "poll")).toHaveLength(1);
  // A cycle is not a send-back: what poll wrote keeps its status.
  expect(ws.steps.poll.artifacts).toEqual([{ artifact: "ledger", path: "ledger.md", status: "done" }]);
  expect(ws.steps.open.status).toBe("COMPLETED");

  repo.ok("continue", "feat");
  repo.write("done.flag");
  const done = repo.ok("continue", "feat");
  expect(done).toContain("respond: COMPLETED");
  expect(done).toContain("STEP report (4 of 4)");
  expect(repo.state("feat").steps.respond.cycle).toBe(2);
});

// ---------------------------------------------------------------- E3 agent

test("an agent loop gate needs a findings file of the current cycle; --again starts the next cycle, continue completes", () => {
  toRespond("feat", AGENT_LOOP);
  const block = repo.ok("start", "feat");
  expect(block).toContain("every pull request is merged or blocked");
  expect(block).toContain('fuse-flow continue feat --again "<why it does not hold yet>"');
  // The step's closing continue line says so too, so the two are read as one command.
  expect(block).toMatch(/\n {2}\d+\. Run `fuse-flow continue feat`, or with --again "<why it does not hold yet>" while the loop gate above does not hold\./);

  expect(repo.refused("continue", "feat", "--again", "PR2 is open")).toContain("there is no findings file");
  repo.reviewed("feat", "respond");
  const again = repo.ok("continue", "feat", "--again", "PR2 is open");
  expect(again).toContain("cycle 2 of the loop at respond starts at poll");
  expect(repo.state("feat").steps.respond.history.join("\n")).toContain("PR2 is open");

  repo.ok("continue", "feat");
  // The findings file of cycle 1 does not count for cycle 2.
  expect(repo.refused("continue", "feat")).toContain(".konductor/reviews/feat/respond-pass-2-round-<n>.json");
  repo.reviewed("feat", "respond-pass-2");
  expect(repo.ok("continue", "feat")).toContain("respond: COMPLETED");
});

test("--again at an agent loop gate takes the same work reports as a plain continue", () => {
  const yaml = looping("      - agent: every pull request is merged or blocked\n        repeat_from: poll").replace(
    "    instruction: Act on new feedback.\n",
    "    instruction: Act on new feedback.\n    updates:\n      - artifact: ledger-update\n        path: ledger.md\n",
  );
  toRespond("feat", yaml);
  repo.reviewed("feat", "respond");
  expect(repo.ok("continue", "feat", "--unchanged", "ledger-update", "nothing changed this cycle", "--again", "PR1 is open")).toContain(
    "cycle 2 of the loop at respond starts at poll",
  );
});

test("--again is refused on a step whose loop gate is not the agent's or the owner's to decide", () => {
  toRespond("feat", SCRIPT_LOOP);
  expect(repo.refused("continue", "feat", "--again", "x")).toContain("the loop gate of step respond is a script; its exit code decides");
  repo.start("plain", "version: 1\nname: plain\nsteps:\n  - id: only\n    instruction: x\n");
  expect(repo.refused("continue", "plain", "--again", "x")).toContain("step only has no loop gate");
});

test("an agent loop gate is reported by its cycles, not against a round cap it does not have", () => {
  toRespond("feat", AGENT_LOOP);
  repo.reviewed("feat", "respond");
  repo.ok("continue", "feat", "--again", "PR1 is open");
  repo.ok("continue", "feat");
  expect(repo.ok("status", "feat")).toMatch(/agent\(every pull request is merged or blocked\) \[loop gate; /);
  repo.reviewed("feat", "respond-pass-2");
  repo.ok("continue", "feat");
  const done = repo.ok("continue", "feat");
  expect(done).toContain("review (every pull request is merged or blocked): the loop ended in cycle 2");
  expect(done).not.toContain("review (every pull request is merged or blocked): <rounds used>");
  expect(repo.ok("status", "feat")).not.toMatch(/agent\(every pull request is merged or blocked\) \[cap/);
});

// ---------------------------------------------------------------- E4 owner

test("an owner-action loop gate: --again starts the next cycle with the owner's note; --owner-approved completes", () => {
  toRespond("feat", OWNER_LOOP);
  repo.ok("continue", "feat");
  expect(repo.status("feat", "respond")).toBe("AWAITING_OWNER");
  const again = repo.ok("continue", "feat", "--again", "check again after the next deploy");
  expect(again).toContain("cycle 2 of the loop at respond starts at poll");
  expect(again).toContain('OWNER SAID: "check again after the next deploy"');

  repo.ok("continue", "feat");
  repo.ok("continue", "feat");
  expect(repo.status("feat", "respond")).toBe("AWAITING_OWNER");
  expect(repo.ok("continue", "feat", "--owner-approved")).toContain("respond: owner approved; COMPLETED");
});

// ---------------------------------------------------------------- E5 cap

const CAPPED = looping("      - script: test -f done.flag\n        repeat_from: poll\n        max_cycles: 2");

function toCap(slug: string): void {
  toRespond(slug, CAPPED);
  repo.ok("continue", slug);
  repo.ok("continue", slug);
  const out = repo.ok("continue", slug);
  expect(out).toContain("respond: BLOCKED");
  expect(out).toContain("the loop at respond has run 2 cycles, its max_cycles");
  expect(repo.status(slug, "respond")).toBe("BLOCKED");
  expect(repo.state(slug).steps.respond.cycle).toBe(2);
}

test("at max_cycles the step is blocked, and only the owner moves it on", () => {
  toCap("feat");
  expect(repo.refused("continue", "feat")).toContain('step "respond" is BLOCKED; only the owner can move it on');
  const block = repo.ok("start", "feat");
  expect(block).toContain("--more-cycles <n>");
});

test("at max_cycles, --more-cycles starts the next cycle, --owner-approved ends the loop, --back-to sends the work back", () => {
  toCap("more");
  const more = repo.ok("continue", "more", "--more-cycles", "1");
  expect(more).toContain("cycle 3 of the loop at respond starts at poll");
  expect(repo.state("more").steps.respond.cycles_granted).toBe(1);

  toCap("ended");
  expect(repo.ok("continue", "ended", "--owner-approved")).toContain("respond: owner approved; COMPLETED");
  expect(repo.status("ended", "report")).toBe("IN_PROGRESS");

  toCap("back");
  repo.ok("continue", "back", "--back-to", "open");
  expect(repo.status("back", "open")).toBe("IN_PROGRESS");
  expect(repo.state("back").steps.respond.cycle).toBe(2);
});

test("--more-cycles goes only to a step blocked at its loop's cap", () => {
  toRespond("feat", CAPPED);
  expect(repo.refused("continue", "feat", "--more-cycles", "1")).toContain("--more-cycles goes to a step blocked at its loop's max_cycles");
});

// ---------------------------------------------------------------- E6 interval

test("interval is printed in the first step block of the second and later cycles only", () => {
  repo.start("feat", SCRIPT_LOOP);
  const first = repo.ok("continue", "feat");
  expect(first).toContain("STEP poll (2 of 4)");
  expect(first).not.toContain("wait about 15m");
  repo.write("ledger.md");
  const respond = repo.ok("continue", "feat");
  expect(respond).toContain("LOOP: cycle 1 of the loop at respond, which repeats from poll");
  expect(respond).not.toContain("wait about 15m");
  const second = repo.ok("continue", "feat");
  expect(second).toContain("LOOP: cycle 2 of the loop at respond, which repeats from poll");
  expect(second).toContain("WAIT: before this step's work, wait about 15m");
  expect(repo.ok("continue", "feat")).not.toContain("wait about 15m");
});

// ---------------------------------------------------------------- E7 jumps

test("an owner jump into the loop keeps the cycle count, and status shows the cycle", () => {
  toRespond("feat", SCRIPT_LOOP);
  repo.ok("continue", "feat");
  repo.ok("continue", "feat");
  repo.ok("continue", "feat", "--back-to", "poll", "--note", "poll again");
  const ws = repo.state("feat");
  expect(ws.steps.respond.cycle).toBe(2);
  expect(ws.steps.poll.status).toBe("IN_PROGRESS");
  expect(repo.ok("status", "feat")).toContain("cycle 2 of the loop at respond");
});

// ---------------------------------------------------------------- E8 agent gate wording

test("the agent gate is documented as what an agent judges; without a guide the default independent review applies", () => {
  const schema = readFileSync(join(FLOW_DIR, "workflows", "schemas", "gate.schema.json"), "utf8");
  expect(schema).toContain("What an agent judges.");
  repo.start("plain", "version: 1\nname: plain\nsteps:\n  - id: only\n    instruction: x\n    gates:\n      - agent: review the work\n");
  expect(repo.ok("start", "plain")).toContain("Have an independent agent review the work.");
});

// ---------------------------------------------------------------- E9 schema

test("the generated gate schema carries the loop fields", () => {
  const schema = JSON.parse(readFileSync(join(FLOW_DIR, "workflows", "schemas", "gate.schema.json"), "utf8"));
  const shapes = (schema.anyOf as any[]).filter((s) => s.type === "object");
  for (const kind of ["owner-action", "check", "script", "agent"]) {
    const shape = shapes.find((s) => s.properties?.[kind]);
    expect(Object.keys(shape.properties)).toEqual(expect.arrayContaining(["repeat_from", "interval", "max_cycles"]));
  }
  const workflow = shapes.find((s) => s.properties?.workflow);
  expect(Object.keys(workflow.properties)).not.toContain("repeat_from");
});

// ---------------------------------------------------------------- E10 repeat on the finished state

test("a replayed --again starts no further cycle", () => {
  repo.start("self", "version: 1\nname: self\nsteps:\n  - id: watch\n    instruction: Watch.\n    gates:\n      - agent: the job is done\n        repeat_from: watch\n");
  repo.reviewed("self", "watch");
  repo.ok("continue", "self", "--again", "still running");
  const before = repo.state("self").steps.watch;
  expect(before.cycle).toBe(2);
  expect(repo.refused("continue", "self", "--again", "still running")).toContain("there is no findings file");
  const after = repo.state("self").steps.watch;
  expect(after.cycle).toBe(2);
  expect(cycleLines("self", "watch")).toHaveLength(1);
});

test("a replayed owner --again, once the next cycle is handed out, starts no further cycle", () => {
  toRespond("feat", OWNER_LOOP);
  repo.ok("continue", "feat");
  repo.ok("continue", "feat", "--again", "not yet");
  expect(repo.refused("continue", "feat", "--again", "not yet")).toContain("--again");
  expect(repo.state("feat").steps.respond.cycle).toBe(2);
  expect(cycleLines("feat", "respond")).toHaveLength(1);
});

test("after the loop gate passed, a further continue starts no cycle", () => {
  repo.start("self", "version: 1\nname: self\nsteps:\n  - id: watch\n    instruction: Watch.\n    gates:\n      - script: test -f done.flag\n        repeat_from: watch\n");
  repo.write("done.flag");
  repo.ok("continue", "self");
  expect(repo.refused("continue", "self")).toContain("workflow complete; there is nothing to continue");
  expect(repo.refused("continue", "self", "--again", "x")).toContain("workflow complete");
  expect(repo.state("self").steps.watch.cycle).toBeUndefined();
  expect(cycleLines("self", "watch")).toHaveLength(0);
});

// ---------------------------------------------------------------- E11 failure paths to recovery

test("a script loop gate that fails, then passes, completes the step after one extra cycle", () => {
  toRespond("feat", SCRIPT_LOOP);
  repo.ok("continue", "feat");
  repo.ok("continue", "feat");
  repo.write("done.flag");
  expect(repo.ok("continue", "feat")).toContain("respond: COMPLETED");
  expect(repo.state("feat").steps.respond.cycle).toBe(2);
});

test("a step blocked at max_cycles resumes after --more-cycles 1 and completes when the gate then passes", () => {
  toCap("feat");
  repo.ok("continue", "feat", "--more-cycles", "1");
  repo.ok("continue", "feat");
  repo.write("done.flag");
  expect(repo.ok("continue", "feat")).toContain("respond: COMPLETED");
  expect(repo.state("feat").steps.respond.cycle).toBe(3);
});

test("an owner --back-to into the loop during a cycle resumes with the cycle count kept, and the loop goes on counting", () => {
  toRespond("feat", SCRIPT_LOOP);
  repo.ok("continue", "feat");
  repo.ok("continue", "feat", "--back-to", "poll");
  repo.ok("continue", "feat");
  expect(repo.state("feat").steps.respond.cycle).toBe(2);
  expect(repo.ok("continue", "feat")).toContain("cycle 3 of the loop at respond starts at poll");
});

// ---------------------------------------------------------------- E12 the working agent judges

const JUDGE = "---\njudged_by: working-agent\n---\n# Babysit exit\n\nJudge from the ledger.\n";
const REVIEW = "# Review\n\nReview it.\n";

test("a guide that hands the judgement to the working agent keeps its own guide and prints no reviewer launch text", () => {
  repo.write("guides/exit.md", JUDGE);
  repo.write("guides/review.md", REVIEW);
  repo.write(".konductor/policy-overrides.yml", `review:\n  guide: ${join(repo.root, "guides/policy-review.md")}\n`);
  repo.write("guides/policy-review.md", "# Team review\n");
  const wf = `version: 1
name: judged
steps:
  - id: fix
    instruction: Fix.
    gates:
      - agent: review the fixes
        guide: ${join(repo.root, "guides/review.md")}
  - id: respond
    instruction: Respond.
    gates:
      - agent: every pull request is merged or blocked
        guide: ${join(repo.root, "guides/exit.md")}
        repeat_from: fix
`;
  repo.start("feat", wf);
  const fix = repo.ok("start", "feat");
  // An ordinary review gate still gets the policy's guide and the reviewer launch text.
  // The step block names guides inside the repository by their path from its root.
  expect(fix).toContain("Follow the review guide guides/policy-review.md.");
  expect(fix).toContain("Start the reviewer");
  repo.reviewed("feat", "fix");
  const respond = repo.ok("continue", "feat");
  const step = respond.slice(respond.indexOf("STEP respond"));
  expect(step).toContain("guides/exit.md");
  expect(step).not.toContain("guides/policy-review.md");
  expect(step).not.toContain("Start the reviewer");
  expect(step).not.toContain("Have an independent agent");
  expect(step).toContain("Judge yourself whether every pull request is merged or blocked");
});

// ---------------------------------------------------------------- fixes from the implementation review

test("the cycle's wait goes to the first step handed out when the repeat_from step is skipped", () => {
  const yaml = `version: 1
name: skipped-start
steps:
  - id: prepare
    instruction: Prepare.
    condition:
      script: "false"
  - id: watch
    instruction: Watch.
    gates:
      - script: test -f done.flag
        repeat_from: prepare
        interval: 15m
`;
  repo.start("feat", yaml);
  const cycle2 = repo.ok("continue", "feat");
  expect(cycle2).toContain("cycle 2 of the loop at watch starts at prepare");
  expect(cycle2).toContain("STEP watch (2 of 2)");
  expect(cycle2).toContain("WAIT: before this step's work, wait about 15m");
});

test("a guide's judged_by is read as YAML, and a guide that is not a regular file hands nothing over", () => {
  repo.write("guides/quoted.md", '---\ntitle: Exit\njudged_by: "working-agent"   # the agent judges\n---\n# Exit\n');
  const wf = (guide: string) =>
    `version: 1\nname: judged\nsteps:\n  - id: watch\n    instruction: Watch.\n    gates:\n      - agent: the job is done\n        guide: ${guide}\n        repeat_from: watch\n`;
  repo.start("quoted", wf(join(repo.root, "guides/quoted.md")));
  expect(repo.ok("start", "quoted")).toContain("Judge yourself whether the job is done");
  // A device is not a guide: it is not read, so it hands nothing over.
  const r = repo.run(["validate", repo.write("flows/dev.yml", wf("/dev/zero"))]);
  expect(r.out).toContain("is not a file");
});

test("a working agent's judgements are not counted as reviewer launches", () => {
  repo.write("guides/exit.md", "---\njudged_by: working-agent\n---\n# Exit\n");
  repo.start(
    "self",
    `version: 1\nname: self\nsteps:\n  - id: watch\n    instruction: Watch.\n    gates:\n      - agent: the job is done\n        guide: ${join(repo.root, "guides/exit.md")}\n        repeat_from: watch\n`,
  );
  repo.reviewed("self", "watch");
  repo.ok("continue", "self", "--again", "still running");
  repo.reviewed("self", "watch-pass-2");
  const done = repo.ok("continue", "self");
  expect(done).not.toContain("reviewer launch");
  expect(repo.ok("status", "self")).not.toContain("reviewer launch");
});

test("a loop blocked at max_cycles is not reported as ended", () => {
  repo.start("self", "version: 1\nname: self\nsteps:\n  - id: watch\n    instruction: Watch.\n    gates:\n      - agent: the job is done\n        repeat_from: watch\n        max_cycles: 1\n");
  repo.reviewed("self", "watch");
  const blocked = repo.ok("continue", "self", "--again", "still running");
  expect(blocked).toContain("watch: BLOCKED");
  expect(blocked).not.toContain("the loop ended");
  expect(blocked).toContain("review (the job is done): the loop has not ended; cycle 1 did not pass");
});

test("a step blocked at its cycle cap keeps the work reports of its last cycle", () => {
  const yaml = `version: 1
name: capped
steps:
  - id: watch
    instruction: Watch.
    produces:
      - artifact: notes
        path: notes.md
    gates:
      - script: test -f done.flag
        repeat_from: watch
        max_cycles: 1
`;
  repo.start("feat", yaml);
  expect(repo.ok("continue", "feat", "--not-produced", "notes", "nothing to note")).toContain("watch: BLOCKED");
  expect(repo.state("feat").steps.watch.not_produced).toEqual({ notes: "nothing to note" });
});

test("a failing loop command's output is shown, so a broken command is told apart from an unmet condition", () => {
  toRespond("feat", looping("      - script: \"echo 'error: token expired' >&2; exit 3\"\n        repeat_from: poll\n        max_cycles: 2"));
  expect(repo.ok("continue", "feat")).toContain("error: token expired");
  repo.ok("continue", "feat");
  const blocked = repo.ok("continue", "feat");
  expect(blocked).toContain("respond: BLOCKED");
  expect(blocked).toContain("error: token expired");
});

test("a loop gate that has not run in this cycle is not reported as failed", () => {
  const yaml = looping("      - agent: review the fixes\n      - agent: every pull request is merged or blocked\n        repeat_from: poll");
  toRespond("feat", yaml);
  repo.ok("continue", "feat", "--blocked", "the review found more than the cap allows", "--gate", "1");
  const block = repo.ok("start", "feat");
  expect(block).toContain("review (every pull request is merged or blocked): the loop has not ended; its judgement has not run in cycle 1");
  expect(block).not.toContain("cycle 1 did not pass");
});

test("--waived goes with --again as it goes with a plain continue", () => {
  toRespond("feat", AGENT_LOOP);
  expect(repo.ok("continue", "feat", "--waived", "the owner waived this cycle's judgement", "--again", "PR1 is open")).toContain(
    "cycle 2 of the loop at respond starts at poll",
  );
});

test("a loop gate that exits 0 but reports failures in its output carries the warning", () => {
  toRespond("feat", looping("      - script: echo '3 failed'\n        repeat_from: poll"));
  const done = repo.ok("continue", "feat");
  expect(done).toContain("respond: COMPLETED");
  expect(done).toContain("exited 0, so fuse-flow took it as a pass, but its output reports failures");
});

test("the owner's --again records no work reports, so it refuses them instead of dropping them", () => {
  toRespond("feat", OWNER_LOOP);
  repo.ok("continue", "feat");
  const out = repo.refused("continue", "feat", "--again", "not yet", "--updated", "ledger.md");
  expect(out).toContain("--updated report the agent's work");
  expect(repo.status("feat", "respond")).toBe("AWAITING_OWNER");
  expect(repo.state("feat").steps.respond.cycle).toBeUndefined();
});

test("review rounds neither go to a loop gate nor release a block at its cycle cap", () => {
  // A step with an ordinary review and, last, an agent loop gate capped at one cycle.
  const yaml = looping("      - agent: review the fixes\n      - agent: every pull request is merged or blocked\n        repeat_from: poll\n        max_cycles: 1");
  toRespond("feat", yaml);
  repo.reviewed("feat", "respond-gate1");
  repo.reviewed("feat", "respond-gate2");
  expect(repo.ok("continue", "feat", "--again", "PR1 is open")).toContain("respond: BLOCKED");
  expect(repo.refused("continue", "feat", "--more-rounds", "1")).toContain("blocked at its loop's max_cycles");
  expect(repo.status("feat", "respond")).toBe("BLOCKED");
  // The loop gate is no review with a round cap, so it is not offered one.
  expect(repo.refused("continue", "feat", "--more-rounds", "1", "--gate", "2")).toContain("is not a review");
  // The supported way on still works.
  expect(repo.ok("continue", "feat", "--more-cycles", "1")).toContain("cycle 2 of the loop at respond starts at poll");
});

test("a step whose only agent gate is a loop gate is offered cycles, not review rounds", () => {
  toRespond("feat", AGENT_LOOP);
  expect(repo.refused("continue", "feat", "--more-rounds", "1")).toContain("--more-cycles");
});
