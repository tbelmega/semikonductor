# Maker-checker pass on a new design draft

The review for the `draft` step of `k-design-doc-creation-sop`, and the rules the
`adversarial-review` and `final-output` steps check the document against again. It ports the
"maker-checker pass" of the former k-design-doc-creation SOP: the draft is checked against the
design guide's checklist, and it does not move on while a CRITICAL finding is open.

## The reviewer

Use a fresh agent that has none of this session's context, preferably from another model family
than the author's. Give it the draft, the requirements summary (or the owner's request when
elicitation was skipped), the design guide (`fuse/flow/library/artifacts/design/guide.md` in the
fuse-konductor clone), the decision-writing skill, read access to the repository and the path of
its findings file. It writes its findings there as JSON, following the review findings schema the
step names, and changes no other file. Do not tell it what you expect it to find. If the harness
cannot start another agent and no launch command is set, check the draft yourself in a separate
pass and say so in the hand-over.

## What it checks

1. **The design guide's checklist,** item by item. An item fails when the draft as a whole does
   not meet it. A single long sentence or one stray filler phrase is a MINOR finding, not a failed
   item.
2. **The outside-in structure,** in this order: Problem, Requirements, Solution Overview, Decision
   Requested, How It Works, Implementation Details, Implementation Plan. No layer mixes in detail
   that belongs to a later one.
3. **Diagrams.** Every How It Works subsection opens with a Mermaid diagram, with no exception.
   Every other section that describes a multi-component interaction, a data flow or a sequence of
   steps has a Mermaid diagram before its prose, or says why it has none. A diagram follows the
   guide's Diagrams and Diagram Accuracy sections.
4. **Decision records.** Every significant decision, as decision-writing's ADR mode defines it,
   has an ADR: inline under `## Architecture Decision Records`, or in the project's own
   decision-record location and linked from the draft. Each ADR has Context, Decision,
   Alternatives Considered as a table, and Consequences, and passes decision-writing's quality
   gate. Missing trade-off scores are not a finding here; a later step adds them.

## Severity

Write each finding with the SOP's class at the start of its title, and with the priority the
findings schema asks for:

- **CRITICAL (P0):** a failed checklist item; a missing or out-of-order outside-in section; a How
  It Works subsection without a diagram; a section that needs a diagram and has neither one nor a
  stated reason; a significant decision with no ADR; an ADR finding that decision-writing's quality
  gate rates CRITICAL. An ADR with decision-writing's `<TBD — flagged for review>` alternatives row
  is not CRITICAL here; the adversarial review must settle it.
- **IMPORTANT (P1):** an ADR finding that decision-writing rates IMPORTANT, and any other problem
  that would make a reviewer misread the design.
- **MINOR (P3):** style and clarity issues that do not fail a checklist item.

The reviewer says for each finding whether it is a single instance or a broken pattern.

## A round

A reviewer is not an authority: it can be wrong, and it lacks context you have, such as a
decision the owner already made. Check every finding against the draft and the requirements, and
accept or reject it with the reason. A CRITICAL finding you accept is a required fix. For a broken
pattern, find every other occurrence in the draft and fix them in the same pass. Fix IMPORTANT and
MINOR findings when the fix is cheap, and list the rest in the hand-over.

A round passes when no CRITICAL finding stays open. After a round with a required fix, start the
next round with a fresh reviewer on the whole draft, told how each earlier finding was handled.
When the round cap is reached with a CRITICAL finding open, stop and report the step as blocked
with the open findings; the owner decides.
