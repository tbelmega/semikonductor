# Adversarial review of a new design document

The review for the `adversarial-review` step of `k-design-doc-creation-sop`. It ports Phase 4,
the adversarial review loop, of the former k-design-doc-creation SOP: every major design decision
is challenged before the owner sees the document.

## The reviewer

Use a fresh agent that has none of this session's context, preferably from another model family
than the author's. Give it the design document, the requirements summary (or the owner's
request), the AWS validation and trade-off reports, the adversarial-design-review skill with its
argumentation reference, read access to the repository, the path of its findings file, and the
value of `consent_confirmed` that the owner gave before the first round. With
`consent_confirmed=true` it runs the skill's panel path through the deliberation-panel skill;
otherwise it runs the skill's single-voice path. It writes its findings as JSON, following the
review findings schema the step names, and changes no other file. Do not tell it what you expect
it to find. If the harness cannot start another agent and no launch command is set, run the
review yourself in a separate pass and say so in the hand-over.

## What it looks at

Of the files the step block names for review, the reviewer challenges the design document only.
The adversarial review summary is the author's record of the rounds, and is not reviewed.

The reviewer applies the adversarial-design-review skill to every major architectural decision,
trade-off and AWS service choice: its review checklist, its fallacy checking against the
argumentation reference, and its architecture stress test. An ADR that still carries
decision-writing's `<TBD — flagged for review>` alternatives row is an IMPORTANT finding until the
row is replaced by a genuine alternative, or the review confirms that none exists.

## Severity

Use the skill's classification, and write the class at the start of each finding's title:

| Class                    | Findings schema priority |
| ------------------------ | ------------------------ |
| CRITICAL (architectural) | P0                       |
| CRITICAL (factual)       | P0                       |
| IMPORTANT                | P1                       |
| MINOR                    | P3                       |

The reviewer says for each finding whether it is a single instance or a broken pattern.

## A round

A reviewer is not an authority. Check every finding against the document and the requirements,
and accept or reject it with the reason. Do not drop a finding silently: a finding you reject is
recorded in the adversarial review summary with your reason, marked for the owner to confirm as an
engineer override. For a broken pattern, fix every occurrence in the same pass.

1. **Stop for the owner first.** In round 2 or any later round, if an accepted finding is CRITICAL
   (architectural), stop the loop at once, before applying corrections. Present the finding to the
   owner, ask whether to redesign or override it, and report the step as blocked. Redesign is the
   owner's decision to send the work back to the `draft` step; an override is the owner's approval
   as is, with the finding recorded as an engineer override.
2. **Otherwise correct.** Apply the corrections for every accepted finding. Then check the
   document against the maker-checker rules in `k-design-doc-creation-sop-checklist-review.md`
   next to this guide, and fix every CRITICAL finding, before the next round.
3. **Exit condition.** A round passes when it has 0 CRITICAL and 0 IMPORTANT findings, and fewer
   than 3 MINOR findings. A round with any CRITICAL or IMPORTANT finding, or with 3 or more MINOR
   findings, ends with required fixes, and the next round starts with a fresh reviewer on the
   whole document, told how each earlier finding was handled.
4. **At the cap.** When the exit condition is not met after the printed number of rounds, stop,
   present the remaining issues to the owner for manual resolution, and report the step as
   blocked.

Record each round in the adversarial review summary: its findings by class, the corrections
applied, and the findings marked for engineer override.
