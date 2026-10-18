# Planning and running a bug bash

A bug bash finds the problems worth fixing in an existing codebase within a time box, by many
independent agents that look at it in different ways. This guide holds the plan's structure and
the method: the quality bar, the catalogue of existing checks, the lens catalogue, and the rules
for running agents and fixes. The house rules win where they say otherwise.

## The plan, in this order

1. **For the owner:** the decisions they must make or check, each with your recommendation.
2. **Scope:** the parts of the codebase in and out, by path.
3. **Mode:** report only, or fixing; in a fixing run, the severity threshold for what is fixed
   (by default P1 and above) and whether the owner triages the findings first.
4. **Quality bar:** the severities below, adapted to the project with an example of each.
5. **Limits:** wall-clock time and spend, per phase where it matters, and which live or costly
   runs are allowed.
6. **Reviewers:** the model and harness for the author agents and for the independent reviewers.
   An independent reviewer is a different model family from the author's where one is available.
7. **Records:** the folder that holds the run's records. It is ignored by git and inside the
   repository, never only in the harness's scratch space, which a restart can delete.
8. **Catalogue** and **lenses**, written by the catalogue step.

## Quality bar

- **P0:** wrong or unsafe: the system loses or corrupts data, crashes, prints a wrong next step
  that a user follows, or a core path cannot be completed.
- **P1:** a user or an agent following the documentation would plausibly do the wrong thing, or a
  requirement is missed: a broken path, a contradictory instruction, a missing step, docs that
  contradict behaviour.
- **P2:** real but low impact: confusing wording, an edge case no realistic use reaches.
- **P3:** style or taste. Not reported.

Rate by impact on a realistic user, not by how clever the finding is. A finding that only matters
under conditions the owner has ruled out, such as concurrent use of a single-user tool, is not a
finding; say so when you reject it.

## Catalogue

Run every existing check once, from a clean clone, and record the result. List each test tool and
harness, how to run it, and whether continuous integration runs it. A check that exists but never
runs is a finding. List the documented claims that a lens can verify: commands, flags, exit codes,
printed output, file locations, precedence rules. Note the environment problems the baseline
shows, such as a broken personal link that crashes a test run, and work around them in clones
rather than changing the owner's files.

## Lens catalogue

Choose the lenses that fit the project. Each lens is one agent, with one area, a model, and either
read-only access or a clone to experiment in.

- **Logic and state:** read the code in full and compare pairs of code paths that answer the same
  question; every disagreement is a lead. The most productive reading lens.
- **Adversarial input:** repeated and out-of-range flags, malformed files, edits to the system's
  own inputs while it runs, history rewrites, paths from unusual working directories.
- **Instructions an agent or user follows:** walk each documented flow with the real tool in a
  throwaway project, and compare what it prints with what the instructions promise. Finds what
  reading alone does not.
- **Documentation against behaviour:** extract every checkable claim and check it; run the
  documentation's own examples verbatim.
- **Conventions that belong to the project:** guides or templates that hardcode a commit shape, a
  branch strategy, a diagram tool, a test discipline or a document location.
- **Test quality and coverage:** tests that fit the code instead of the requirement, behaviours
  without a test that would fail, harness tests that never run.
- **Execution of snippets:** run the code blocks that guides tell agents to run.
- **Facts against the source:** claims about third-party services and tools, checked against their
  current documentation.
- **Operational readiness**, where the project runs as a service: logging, monitoring, limits.
- **User experience**, where it has a user interface: exploratory runs in a browser.
- **Live end-to-end runs:** real agents or users driving the system through its main flows. The
  most expensive lens and the only one that measures behaviour, not text. Run one short run first
  to check the harness itself.

Use two model families on the highest-risk areas: findings both find are the most reliable, and
each finds things the other misses.

### Confirmation lenses

After fixes land, use lenses discovery did not: state written by the previous release continued by
the new code; the whole change reviewed as one change, for what no single series could see; a
second documentation pass; a short live run.

## Orchestration rules

- **Shared context file.** Write one file every agent reads first: where the source is and that it
  is read-only, how to clone and run it, the quality bar, the findings format, the house rules that
  matter, and the pitfalls paid for so far. Update it as the run learns.
- **One clone per agent.** No agent changes the owner's checkout. Fix agents export patches; you
  apply them.
- **Records in the repository.** Briefs, raw findings, patches, reports and runner scripts go in
  the plan's records folder.
- **Merging is a source of defects.** When you resolve a conflict between two series by hand,
  have the next review look at the merged lines specifically: in the first run, a hand-merged
  route lost one series' safety check.
- **Background processes survive the harness.** A reviewer started from a shell may be killed by
  the harness's process cleanup after a few minutes. Start long runs in a way that outlives the
  calling turn, such as a user service with a time limit, and check them with a watchdog: a run
  whose log has not changed for 15 minutes is restarted.
- **Credentials expire.** Note when the credentials of each model provider expire and renew them
  before they do.
- **Validate every result file on receipt**, and rerun or repair it before triage.
- **Turn budgets.** Give fix agents enough turns for their set: prose sweeps need more than
  engine fixes. A fix agent that runs out of turns is continued by a fresh agent pointed at its
  clone.
- **Verify what agents report.** Rerun the checks yourself on the integrated result; a passing
  report from an agent is not evidence.

## Fixing rules

- **Disjoint ownership.** Each fix agent owns a set of files no other running agent changes. Shared
  documentation, such as a README, is the usual conflict: give it one owner per round, or have each
  agent put its documentation changes in one final commit.
- **Fix agents verify first.** Each re-establishes the finding with a reproduction or a quote, and
  records it rejected, with the reason, when it does not hold. With more than a dozen P0 and P1
  findings this is how they are verified; checking them all yourself first costs more than the
  fixes. A finding two model families found independently needs the least checking.
- **Integration work is owned too.** A fix agent that needs a change in a file it does not own
  lists it in its report; collect those lists after each round and give them to the next round's
  owner of that file, or they are lost. Expect them most where server and client meet.
- **Bug fixes start with a failing test.** Never weaken a test to get to green; a test that encodes
  the wrong behaviour is changed in a step that says why.
- **Full checks after every landing.** Interactions between series only show on the integrated
  result.
- **Every series gets an independent review**, and its findings go to a fresh fix agent. Expect the
  first review of a change to core logic to find serious problems in the fixes themselves.
- **Three rounds in one area means redesign.** When the same area produces findings in three review
  rounds in a row, stop adding special cases: replace them with one simple rule, or record the
  area for the owner.
- **Decisions the owner should see** go to the workstream's decisions file, with the default you
  built and how to revert it.

## When the bug bash is done

A fixing run is done when a confirmation wave finds no new confirmed finding at or above the
threshold and every series' last review is clean or has only optional findings, or when the limits
are reached. The report says which.
