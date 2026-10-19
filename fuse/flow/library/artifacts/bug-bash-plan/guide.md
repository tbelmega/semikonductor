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
7. **Test tooling:** what exists, the gaps that would hinder this run, and whether the owner has
   the missing tooling built first.
8. **Owner channel:** how the owner is notified of questions during the run, if at all.
9. **Records:** the folder that holds the run's records, including the cost ledger. It is ignored
   by git and inside the repository, never only in the harness's scratch space, which a restart
   can delete.
10. **Catalogue** and **lenses**, written by the catalogue step.

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

## Test tooling

Intake lists each test tool, harness and quality tool, how to run it, and whether continuous
integration runs it. Usually that is enough for a bug bash. A gap matters when it would hinder
this run: fixes in an area no test can reach, such as a user interface without browser tests,
can only be checked by agents by hand, and races and wiring bugs there are exactly what such
checks miss. For each such gap, say what it costs the run and what tooling would close it, and
recommend at the intake gate whether to build it first. When the owner agrees, the test-tooling
step builds it as a feature workstream; the bug bash continues once it has landed.

## Catalogue

Run every existing check once, from a clean clone, and record the result. A check that exists but
never runs is a finding. List the documented claims that a lens can verify: commands, flags, exit
codes, printed output, file locations, precedence rules. Note the environment problems the
baseline shows, such as a broken personal link that crashes a test run, and work around them in
clones rather than changing the owner's files.

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
  calling turn, such as a user service with a time limit.
- **Watchdog.** Check every running agent, reviewers and subagents included, at least every 15
  minutes: a run whose log or transcript has not changed for 15 minutes is stopped and restarted,
  and the restart is recorded in the cost ledger.
- **Cost ledger.** Keep one file in the records folder with a line per agent: its task, model and
  harness, its cost in the unit the harness reports, its wall time, and the findings it found or
  fixed. Where a harness reports no cost, record its token counts and say that the cost is
  unknown; never leave a line out. The report's method section and the next bug bash's choice of
  lenses are built from it.
- **Credentials expire.** Note when the credentials of each model provider expire and renew them
  before they do.
- **Validate every result file on receipt**, and rerun or repair it before triage.
- **Turn budgets.** Give fix agents enough turns for their set: prose sweeps need more than
  engine fixes. A fix agent that runs out of turns is continued by a fresh agent pointed at its
  clone.
- **Verify what agents report.** Rerun the checks yourself on the integrated result; a passing
  report from an agent is not evidence.

## Fixing rules

- **Disjoint ownership.** Each fix agent owns a set of files no other running agent changes. A file
  that several sets of findings change, such as a README or a large component, is the usual
  conflict: give it one owner per round, and have the other agents list the changes they need in
  it, as integration work.
- **The owner's git identity.** Before an agent's first commit, set `user.name` and `user.email`
  in its clone to the owner's, from the owner's checkout. An agent with a scratch home directory
  has no identity of its own and invents one.
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

## Owner channel

The owner may answer questions while the run goes on, but the run never waits for them unless it
must. When an unattended step meets a question only the owner can answer:

- Write it to the workstream's decisions file as an open question: the question, the default you
  go ahead with, what changes if the owner chooses otherwise, and how to revert the default.
  Notify the owner through the channel the plan names; with none, the file is enough.
- Go on with the default. Work that has no safe default, because it would be wasted or harmful if
  the owner decided otherwise, waits; the rest of the run continues.
- Read the decisions file for answers after every landing and before every new round or step.
  Apply each answer, reverting the default where the owner chose otherwise, and record that you
  did.
- Questions still open at the end go first in the report's decisions for the owner.

## History

Fix agents commit in small steps, and reviews add fix commits on top, so a fixing run's history
is long and the same files come back many times. When the house rules set no other commit shape,
rewrite it before the owner lands it, into one commit per behaviour in its final form: group the
commits by the behaviour they change, not by round or agent, and fold each review fix into the
commit it fixes. Use the date of the last commit in each group. Rewrite only commits nobody else
has. Check that the final tree is byte-identical to the head before the rewrite and that the
default check passes on every new commit. Where a group depends on code a later group adds, move
the commit it needs or merge the two groups, and record each such move in the decisions file.

## When the bug bash is done

A fixing run is done when a confirmation wave finds no new confirmed finding at or above the
threshold and every series' last review is clean or has only optional findings, or when the limits
are reached. The report says which.

The limits are there to stop runaway cost, and reaching them is a normal end. Plan the end of the
time limit so that the run still finishes well: start no new fix round once the time left would
not cover the whole-change review, the history rewrite and the report. The report then shows the
owner what the run found and fixed for its cost and what is still open, and makes the case for a
second pass where findings at or above the threshold remain. The owner starts it by sending the
work back to the fix step with new limits.
