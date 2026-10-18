// SPDX-License-Identifier: Apache-2.0
// Attended and unattended steps: the MODE line every step block carries, and
// the DECISIONS line that points the owner to the decisions the agent made on
// its own, from this workstream and from the workstreams it delegated to.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { DECISION_GUIDE, modeLine, Repo } from "./helpers";

let repo: Repo;
beforeEach(() => (repo = new Repo()));
afterEach(() => repo.cleanup());

const MODES = `version: 1
name: modes
steps:
  - id: plain
    instruction: Do the plain step.
  - id: watched
    mode: attended
    instruction: Do the watched step.
  - id: alone
    mode: unattended
    instruction: Do the alone step.
    gates:
      - owner-action: approve the work
  - id: last
    instruction: Finish.
    gates:
      - owner-action: approve the end
`;

const decisionsLine = (out: string) => out.split("\n").filter((l) => l.startsWith("DECISIONS:"));

describe("the MODE line", () => {
  test("validate accepts attended, unattended and no mode, and refuses any other value", () => {
    expect(repo.ok("validate", repo.write("modes.yml", MODES))).toContain("1 workflow valid");
    const bad = repo.refused("validate", repo.write("bad.yml", MODES.replace("mode: attended", "mode: sometimes")));
    expect(bad).toContain('steps.1.mode: Invalid option: expected one of "attended"|"unattended"');
  });

  test("an unmarked step is attended, and its block is the block of the same step marked attended", () => {
    const unmarked = repo.start("feat", MODES);
    expect(unmarked).toContain(`STEP plain (1 of 4): Do the plain step.\n${modeLine("feat")}\n`);

    const marked = new Repo();
    try {
      const out = marked.start("feat", MODES.replace("  - id: plain\n", "  - id: plain\n    mode: attended\n"));
      const block = (s: string, root: string) => s.slice(s.indexOf("STEP plain")).replaceAll(root, "<root>");
      expect(block(out, marked.root)).toBe(block(unmarked, repo.root));
    } finally {
      marked.cleanup();
    }
  });

  test("an attended step tells the agent to ask often and the owner to stay; an unattended one, to decide alone", () => {
    repo.start("feat", MODES);
    const watched = repo.ok("continue", "feat");
    expect(watched).toContain(`STEP watched (2 of 4): Do the watched step.\n${modeLine("feat")}\n`);
    const alone = repo.ok("continue", "feat");
    expect(alone).toContain(`STEP alone (3 of 4): Do the alone step.\n${modeLine("feat", "unattended")}\n`);
    expect(modeLine("feat", "unattended")).toContain("The owner can leave until the next owner gate.");
    expect(modeLine("feat")).toContain("The owner stays with the session during this step.");
  });

  test("the MODE line follows any CONDITION line", () => {
    const conditional = MODES.replace("  - id: plain\n", "  - id: plain\n    condition: { agent: there is something plain to do }\n");
    const out = repo.start("feat", conditional);
    expect(out).toContain(
      "CONDITION: Do this step only if there is something plain to do. Otherwise run `fuse-flow continue feat --skip " +
        `"<why it does not apply>"\`.\n${modeLine("feat")}\n`,
    );
  });

  test("the engine creates the decisions folder, private to the checkout, and never needs the file", () => {
    repo.start("feat", MODES);
    expect(repo.read(".konductor/decisions/.gitignore")).toBe("*\n");
    expect(existsSync(`${repo.root}/.konductor/decisions/feat.md`)).toBe(false);
    for (let i = 0; i < 3; i++) repo.ok("continue", "feat");
    expect(repo.ok("continue", "feat", "--owner-approved")).toContain("STEP last (4 of 4)");
  });
});

describe("the DECISIONS line", () => {
  // Run plain and watched, and finish alone's work, so it waits at its gate.
  const toGate = () => {
    repo.start("feat", MODES);
    repo.ok("continue", "feat");
    repo.ok("continue", "feat");
    return repo.ok("continue", "feat");
  };

  test("an owner's turn names the file and the four responses, and that a change goes back to its step", () => {
    const out = toGate();
    expect(decisionsLine(out)).toEqual([
      "DECISIONS: <how many decisions are open, or none recorded>, in .konductor/decisions/feat.md. The owner can " +
        "accept them as they are, comment inline in the file, ask for changes here, or have you walk through them one by one. " +
        "A change goes back to the step whose work it changes, or to the step that delegated that work, so its checks and reviews run again.",
    ]);
    // The line ends the block for the owner; the agent's part is as it was, with its send-back command.
    expect(out).toContain("one by one. A change goes back to the step whose work it changes, or to the step that delegated that work, so its checks and reviews run again.\n\nFOR YOU, NOT FOR THE OWNER:");
    const agentPart = out.slice(out.indexOf("FOR YOU, NOT FOR THE OWNER:"));
    expect(agentPart).toContain('run `fuse-flow continue feat --back-to <step> --note "<the owner\'s decision>"`');
    expect(agentPart).not.toContain("Decisions");
    // The guide the MODE line names says how to carry the response out.
    expect(readFileSync(DECISION_GUIDE, "utf8")).toContain("--back-to <step>");
  });

  test("a blocked step's owner's turn carries the line too", () => {
    repo.start("feat", MODES);
    const out = repo.ok("continue", "feat", "--blocked", "the plain thing is missing");
    expect(out).toContain("STATUS: blocked.");
    expect(decisionsLine(out)).toHaveLength(1);
  });

  test("the agent's mid-step block never carries it, including an owner-action condition's question", () => {
    const asked = MODES.replace("  - id: watched\n", "  - id: watched\n    condition: { owner-action: confirm the watched step is wanted }\n");
    repo.start("feat", asked);
    const step = repo.ok("continue", "feat");
    expect(step).toContain("CONDITION: Before you start, ask the owner to confirm the watched step is wanted");
    expect(decisionsLine(step)).toEqual([]);
  });

  test("after a send-back from an owner's turn, the next owner's turn carries the line again", () => {
    toGate();
    const back = repo.ok("continue", "feat", "--back-to", "alone", "--note", "redo it");
    expect(decisionsLine(back)).toEqual([]);
    expect(decisionsLine(repo.ok("continue", "feat"))).toHaveLength(1);
  });

  test("the completion block has none right after the owner approved the final gate", () => {
    toGate();
    repo.ok("continue", "feat", "--owner-approved");
    repo.ok("continue", "feat");
    const done = repo.ok("continue", "feat", "--owner-approved");
    expect(done).toContain("STATUS: workflow complete");
    expect(decisionsLine(done)).toEqual([]);
  });

  test("the completion block after a step without an owner gate offers a new workstream, not a send-back", () => {
    const done = repo.start("feat", "version: 1\nname: short\nsteps:\n  - id: only\n    mode: unattended\n    instruction: Do it.\n");
    expect(done).toContain("STEP only");
    const out = repo.ok("continue", "feat");
    expect(out).toContain("STATUS: workflow complete");
    expect(decisionsLine(out)).toEqual([
      "DECISIONS: <how many decisions are open, or none recorded>, in .konductor/decisions/feat.md. The owner can " +
        "accept them as they are, comment inline in the file, ask for changes here, or have you walk through them " +
        "one by one. A change is made in a new workstream that follows on from this one.",
    ]);
    // No agent part is added: the completion block of a workflow with no hand-offs has none.
    expect(out).not.toContain("FOR YOU, NOT FOR THE OWNER:");
    expect(readFileSync(DECISION_GUIDE, "utf8")).toContain("--after <slug>");
  });
});

describe("decisions of delegated workstreams", () => {
  const install = (name: string, yaml: string) => repo.write(`.konductor/workflows/${name}.yml`, yaml);
  const PARENT = `version: 1
name: parent
steps:
  - id: delegate
    instruction: Have it done.
    gates:
      - workflow: middle
      - agent: review what the delegated work returned
      - owner-action: approve the result
`;
  const MIDDLE = `version: 1
name: middle
steps:
  - id: inner
    instruction: Delegate further.
    gates:
      - workflow: leaf
`;
  const LEAF = `version: 1
name: leaf
steps:
  - id: work
    mode: unattended
    instruction: Do it.
`;

  let middle: string;
  let leaf: string;
  beforeEach(() => {
    install("parent", PARENT);
    install("middle", MIDDLE);
    install("leaf", LEAF);
    repo.ok("start", "top", "--workflow", "parent");
    middle = repo.state("top").steps.delegate.children[0].slug;
    repo.ok("start", middle);
    leaf = repo.state(middle).steps.inner.children[0].slug;
    repo.ok("start", leaf);
    repo.ok("continue", leaf);
    repo.ok("continue", middle);
    repo.reviewed("top", "delegate");
  });

  test("the parent's line names every finished descendant's file with the step that delegated it", () => {
    // Rounds granted ahead of time are no review, so they hide nothing.
    repo.ok("continue", "top", "--more-rounds", "1", "--note", "in case");
    const out = repo.ok("continue", "top");
    expect(out).toContain("STATUS: awaiting owner action.");
    const [line] = decisionsLine(out);
    expect(line).toContain(".konductor/decisions/top.md");
    expect(line).toContain(`.konductor/decisions/${middle}.md (workstream ${middle}, delegated by step delegate)`);
    expect(line).toContain(`.konductor/decisions/${leaf}.md (workstream ${leaf}, delegated by step delegate)`);
  });

  test("the owner's review in the parent closes the descendants' windows until they record new work", () => {
    repo.ok("continue", "top");
    const back = repo.ok("continue", "top", "--back-to", "delegate", "--note", "again");
    // The new pass waits for a fresh child; the earlier descendants were reviewed.
    expect(back).toContain("DELEGATE:");
    const fresh = repo.state("top").steps.delegate.children[1].slug;
    repo.ok("start", fresh);
    const freshLeaf = repo.state(fresh).steps.inner.children[0].slug;
    repo.ok("start", freshLeaf);
    repo.ok("continue", freshLeaf);
    repo.ok("continue", fresh);
    repo.reviewed("top", "delegate-pass-2");
    const [line] = decisionsLine(repo.ok("continue", "top"));
    expect(line).toContain(`${fresh}.md`);
    expect(line).toContain(`${freshLeaf}.md`);
    expect(line).not.toContain(`/${middle}.md`);
    expect(line).not.toContain(`/${leaf}.md`);
  });

  test("a review in the middle workstream closes the windows of the workstreams below it", () => {
    // The middle workstream's own step reached an owner's turn, which the owner reviewed.
    install("middle", MIDDLE.replace("      - workflow: leaf\n", "      - workflow: leaf\n      - owner-action: approve the inner work\n"));
    const other = "top-2";
    repo.ok("start", other, "--workflow", "parent");
    const mid = repo.state(other).steps.delegate.children[0].slug;
    repo.ok("start", mid);
    const low = repo.state(mid).steps.inner.children[0].slug;
    repo.ok("start", low);
    repo.ok("continue", low);
    repo.ok("continue", mid);
    repo.ok("continue", mid, "--owner-approved");
    repo.reviewed(other, "delegate");
    const [line] = decisionsLine(repo.ok("continue", other));
    expect(line).toContain(`/${other}.md`);
    expect(line).not.toContain(`/${mid}.md`);
    expect(line).not.toContain(`/${low}.md`);
  });

  test("a line opened only by a descendant's work still names this workstream's file first", () => {
    install("solo", "version: 1\nname: solo\nsteps:\n  - id: hand-off\n    instruction: Have it done.\n    gates:\n      - workflow: leaf\n");
    repo.ok("start", "s1", "--workflow", "solo");
    const child = repo.state("s1").steps["hand-off"].children[0].slug;
    repo.ok("start", child);
    repo.ok("continue", child);
    // The owner skips the parent's step while it is in progress: no review, and no work of its own.
    const done = repo.ok("continue", "s1", "--skip", "not needed after all");
    expect(done).toContain("STATUS: workflow complete");
    const [line] = decisionsLine(done);
    expect(line).toContain(`in .konductor/decisions/s1.md, and .konductor/decisions/${child}.md (workstream ${child}, delegated by step hand-off).`);
  });

  test("an owner's skip of a blocked conditional step is a review too", () => {
    install("parent", PARENT.replace("  - id: delegate\n", "  - id: delegate\n    condition: { agent: the work needs delegating }\n"));
    const other = "top-3";
    repo.ok("start", other, "--workflow", "parent");
    const mid = repo.state(other).steps.delegate.children[0].slug;
    repo.ok("start", mid);
    const low = repo.state(mid).steps.inner.children[0].slug;
    repo.ok("start", low);
    repo.ok("continue", low);
    repo.ok("continue", mid);
    const blocked = repo.ok("continue", other, "--blocked", "the result is unclear");
    expect(decisionsLine(blocked)[0]).toContain(`/${low}.md`);
    const done = repo.ok("continue", other, "--skip", "not needed after all");
    expect(done).toContain("STATUS: workflow complete");
    expect(decisionsLine(done)).toEqual([]);
  });
});
