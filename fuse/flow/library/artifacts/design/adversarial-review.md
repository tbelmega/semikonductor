# Adversarial review of a design document

A review guide that challenges the decisions, trade-offs and architecture choices of a design
document, instead of its writing. The reviewer takes the opposing side of every major decision
and looks for the reasons it fails. `review.md` next to this file covers writing quality and
production readiness; `guide.md` says how the document is written. Use
`argumentation-reference.md` next to this file to find logical fallacies in decision
justifications.

## What it challenges

The reviewer challenges the design document that the step names. When the step writes or updates
several files, such as validation reports, trade-off reports or a review summary, those are inputs
or the author's records; read them for context, but raise findings only against the design
document. Without a step, review the design document you were given.

## Classification

**CRITICAL (architectural):**

- The architecture is wrong for the stated requirements, for example a synchronous design for a
  stated asynchronous requirement.
- A security boundary is missing, such as no authentication, or no encryption at rest or in
  transit where personal data is involved.
- A fundamental scalability flaw: the design cannot meet the stated non-functional requirements at
  the stated load.
- A single point of failure with no stated mitigation.

**CRITICAL (factual):**

- An incorrect technical claim about a service or technology, such as a wrong service limit or a
  feature that does not exist.
- Contradictory requirements: two requirements that cannot both be met.

**IMPORTANT:**

- A significant decision with a weak or missing justification: no alternatives considered, no
  trade-off.
- A decision that has obvious alternatives but names none of them.
- An incomplete trade-off, with dimensions such as cost, latency, complexity, scalability or
  operability missing.
- A logical fallacy in a decision justification.
- An unstated assumption that materially affects the design.

**MINOR:**

- A style or clarity issue in a decision section.
- A minor omission, such as a missing consequence in a decision record.
- A weak acknowledgment of a rebuttal.

## Fallacy checking

For each decision justification, apply the Toulmin model from `argumentation-reference.md` and
check:

- Is the warrant explicit? Does the evidence actually support the claim?
- Is there a false dichotomy, with only two options presented when more exist?
- Is there circular reasoning, where the justification restates the claim?
- Is there an appeal to authority without evidence?

Flag each fallacy found as IMPORTANT, with the fallacy's name and the affected section.

## Checklist

Architecture choices:

- [ ] Each major choice considers at least two alternatives.
- [ ] The chosen option is justified against stated requirements, not preference.
- [ ] Security boundaries are explicit: authentication, encryption, network isolation.
- [ ] A scalability path is stated for ten times the current load.

Trade-offs:

- [ ] Each decision weighs at least three dimensions.
- [ ] Cost implications are addressed.
- [ ] Operational complexity is addressed.

Assumptions:

- [ ] Every load and traffic assumption is stated and sourced.
- [ ] Every assumption about an external dependency is stated.
- [ ] Failure modes are identified for each external dependency.

Logical soundness:

- [ ] No circular reasoning in justifications.
- [ ] No false dichotomies in option selection.
- [ ] No unsupported quantitative claims.

## Steps

1. **Parse the sections.** Find every design decision section, decision record, trade-off table
   and paragraph that makes an architecture choice.
2. **Challenge each decision.** Apply the checklist, the fallacy checking and the classification
   to each decision from step 1, and evaluate each justification against the Toulmin model. This
   is the single-voice review, and it is the default.
3. **Use the deliberation panel only with the owner's consent.** The panel costs roughly 2 to 3
   minutes and several agent calls per review round, scaling with the number of axes it derives
   (typically 3 to 6). The calling workflow asks the owner and passes the answer as
   `consent_confirmed`. Use the panel only when that value is `true`; when it is `false`, missing
   or unclear, stay with the single-voice review, and a reviewer started by a calling workflow
   does not ask the owner itself. Used on its own, ask the owner once before the first round,
   with that cost, whether to convene the panel, and use it only after an explicit yes. Never set
   `consent_confirmed=true` on your own judgment. With consent, invoke the `deliberation-panel`
   skill once per review round, with `decision_domain=design`, `stance=adversarial` and
   `consent_confirmed=true`, and with every decision from step 1 and its trade-offs together as
   the subject. The panel derives three to six axes from the document's decisions, has each axis
   argue why the currently favored option fails on it, cross-examines the arguments anonymously,
   and returns an axis-weighted confidence. In the adversarial stance, axes converging means they
   agree the favored option fails. Map the panel's result to a class:
   - a HIGH-confidence architectural flaw is CRITICAL (architectural);
   - a HIGH-confidence error in a factual claim is CRITICAL (factual);
   - a MEDIUM-confidence architectural or factual flaw is IMPORTANT, because it is not corroborated
     enough for CRITICAL but is too load-bearing to leave out;
   - a HIGH or MEDIUM-confidence justification gap or logical fallacy is IMPORTANT;
   - a LOW-confidence or stylistic observation is MINOR.
4. **Stress-test the architecture.** For the design as a whole: does it meet every stated
   non-functional requirement at the stated load? Are all security boundaries present? Is there a
   single point of failure without mitigation?
5. **Write the findings**, as the next section says.

## Findings

Order the findings CRITICAL (architectural), CRITICAL (factual), IMPORTANT, then MINOR. Each
finding names the section by its heading, states the challenge, and says what the author must
address to answer it, with the fallacy's name where there is one. Say where the finding came from:
the derived axis or axes for a panel finding, or "single-voice". Give a confidence, which is the
strength of the corroboration and not a severity gate: MEDIUM for a clear Toulmin warrant, LOW for
a weak or speculative one. HIGH requires corroboration across several panel axes, so a
single-voice finding is never HIGH.

In an agent gate, write the findings to the findings file that follows the review findings schema.
Put the class at the start of each finding's title, the challenge, source, confidence, rebuttal
needed and any fallacy in its `evidence`, and map the class to the schema's priority:

| Class                    | Priority |
| ------------------------ | -------- |
| CRITICAL (architectural) | P0       |
| CRITICAL (factual)       | P0       |
| IMPORTANT                | P1       |
| MINOR                    | P3       |

Without a gate, write each finding in this form:

```text
[SEVERITY] Section: {heading}
Challenge: {the adversarial challenge}
Source: {the derived axis or axes, or "single-voice"}
Confidence: HIGH | MEDIUM | LOW
Rebuttal needed: {what the author must address}
Fallacy: {name from argumentation-reference.md, if any}
```

End with a summary: the number of CRITICAL (architectural), CRITICAL (factual), IMPORTANT and
MINOR findings, and the source of every CRITICAL finding.

## Passing

A document with any CRITICAL finding does not advance. A round passes with 0 CRITICAL and 0
IMPORTANT findings and fewer than 3 MINOR findings.
