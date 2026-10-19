# Adversarial review before principal engineer submission

The review for the `adversarial-review` step of `k-sop-principal-engineer-design-review`. It
ports Step 3, the adversarial review loop, of the former k-principal-engineer-design-review SOP:
every design decision, trade-off and architectural choice is challenged, for at most 5 rounds,
before a principal engineer sees the document.

## The reviewer

Use a fresh agent that has none of this session's context, preferably from another model family
than the author's. Give it the design document, the claim and decision lists from the `load`
step, the sections the `principles-gate` step flagged for adversarial focus, the
adversarial review guide (`fuse/flow/library/artifacts/design/adversarial-review.md` in the
fuse-konductor clone) with the argumentation reference beside it, read
access to the repository, the path of its findings file, and the value of `consent_confirmed`
settled before the first round. Pass the same value in every round. With
`consent_confirmed=true` it may use the panel path through the deliberation-panel skill;
otherwise it runs the guide's single-voice path, and it does not ask the owner. It writes its
findings as JSON, following the review findings schema the step names, and changes no other file.
Do not tell it what you expect it to find. If the harness cannot start another agent and no launch
command is set, run the review yourself in a separate pass and say so in the hand-over.

## What it looks at

Of the files the step block names for review, the reviewer challenges the design document only,
at the path the `load` step recorded. The adversarial review file is the author's record of the
rounds; the reviewer does not challenge it.

The reviewer applies the design adversarial review guide to every design decision, trade-off and
architectural choice, and runs fallacy checking with the argumentation reference on every decision
justification. It looks hardest at the flagged sections.

## Severity

Classify every finding with this taxonomy, and write the class at the start of its title:

| Class                    | What it covers                                                                     | Findings schema priority |
| ------------------------ | ---------------------------------------------------------------------------------- | ------------------------ |
| CRITICAL (architectural) | Wrong architecture choice, missing security boundary, fundamental scalability flaw | P0                       |
| CRITICAL (factual)       | Incorrect technical claim, wrong service behavior                                  | P0                       |
| IMPORTANT                | Weak justification, missing alternative, incomplete trade-off                      | P1                       |
| MINOR                    | Style, clarity, minor omission                                                     | P3                       |

The reviewer says for each finding whether it is a single instance or a broken pattern.

## A round

A reviewer is not an authority. Check every finding against the document and its sources, and
accept or reject it with the reason; record each rejected finding in the round history. For a
broken pattern, fix every occurrence in the same pass.

1. **Escalation rule, checked before any correction.** If an accepted CRITICAL (architectural)
   finding is present in round 2 or any later round, stop the loop at once. Do not continue it.
   Write the round history, then the review report at the step's optional report path, in the
   `output` step's structure, with the verdict FUNDAMENTAL REDESIGN REQUIRED. Give the owner the
   report's path, present the finding, state that a fundamental redesign is needed, and report
   the step as blocked. The owner's approval as is lets the `output` step finish the report.
2. **Corrections.** Otherwise apply the corrections to the document, then apply Part 1 of the
   design review guide again and confirm the quality score is still 3 or more.
3. **Exit condition.** A round passes when it has 0 CRITICAL and 0 IMPORTANT findings, and fewer
   than 3 MINOR findings. A round with any CRITICAL or IMPORTANT finding, or with 3 or more MINOR
   findings, ends with required fixes, and the next round starts with a fresh reviewer on the
   whole document, told how each earlier finding was handled.
4. **Loop cap.** When the exit condition is not met after the printed number of rounds, stop.
   Write the round history, then the review report at the step's optional report path, in the
   `output` step's structure, with the verdict its rules give for the remaining findings. Give
   the owner the report's path, present the remaining findings for manual resolution, and report
   the step as blocked. The owner's approval as is sends the current state on to the `output`
   step.

Track each round: its number, the finding counts by class, and the corrections applied.
