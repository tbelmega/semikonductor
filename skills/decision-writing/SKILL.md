---
name: decision-writing
description: Use when a decision needs to be researched, recorded or reviewed. Covers an architecture decision record (ADR) for a significant design choice ("document this as an ADR", "record why we chose X over Y"), product and UX decision records (PDR, UXDR), and program-level decision documents that compare options for stakeholders (go/no-go, resourcing, timeline). Follows the project's existing decision-record convention when it has one, gathers evidence and real alternatives before deciding, and sets the bar for context, alternatives and consequences. To score options against each other, use trade-off-evaluator; to check a document's factual claims, use doc-accuracy-analyzer.
---

# Decision Writing

## Overview

Decision records are permanent artifacts. Six months from now, someone will read your record to understand why a choice was made. Write for that future reader.

This skill has four modes. Each starts with the project's convention (next section).

| Mode                          | Use when                                                                                   | Sections                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Research                      | A decision is coming and the evidence, prior decisions or alternatives are not gathered yet | Research Before Deciding                             |
| Record                        | A decision was made, or is proposed, and needs an ADR, PDR or UXDR                         | Writing the Record, ADR Mode, PDR and UXDR Tips      |
| Program decision document     | Program stakeholders must choose between options: go/no-go, resources, scope, timeline     | Writing the Record, Program Decision Document Mode   |
| Review                        | An existing record needs checking for structure, tone and completeness                     | Writing the Record, Quality Gate                     |

## Follow the Project's Convention First

Before writing or reviewing any record, find out how this project already keeps its decisions. A second, parallel set of records with its own numbering is worse than either set alone.

1. **Look for an existing convention.** Check:
   - folders such as `docs/adr/`, `docs/decisions/`, `doc/architecture/decisions/` or `adr/`;
   - configuration of ADR tools, such as adr-tools' `.adr-dir` file or a log4brains configuration;
   - numbered record files, such as `0001-use-postgresql.md`;
   - a decision log file, such as `decision-log.md` or `DECISIONS.md`;
   - decision sections inside existing design documents;
   - any mention of decision records in `AGENTS.md`, `CONTRIBUTING.md` or the README.
2. **If the project has a convention, follow it.** Use its location, file naming, numbering, template, status words, and the way it marks a record as superseded. The quality rules in this skill still apply inside that template: the one-sentence decision, real alternatives and specific consequences. If the template has no place for something this skill asks for, put it in the closest existing section; do not add sections of your own. A design document then links to the new record instead of repeating it inline.
3. **Never rewrite existing records.** Do not renumber or reformat them. When a new decision reverses an old one, mark the old record as superseded in the project's way and leave its content as it is.
4. **If there is no convention, use this skill's defaults:** ADRs inline in the design document (see ADR Mode), program decision documents as their own file next to the program's other documents. Do not create a `docs/adr/` folder unless asked; that would set a convention for the project on the owner's behalf.
5. **If the evidence conflicts,** for example two different patterns or a decision folder that was abandoned: ask the user when one is present to answer. In an unattended workflow step, follow the most recently used pattern and say in your output which one you followed and why.

## Research Before Deciding

Every decision record needs an evidence base. Gather it before drafting, so that the alternatives are found rather than remembered.

### 1. Understand the current state

- Search the codebase for existing implementations, configuration, infrastructure definitions and API contracts related to the decision.
- Read tests that reveal current behavior and assumptions.
- Look for TODO comments, tech debt markers and earlier attempts.

### 2. Find prior decisions and discussions

- Search the project's decision records (found in the convention step) for the topic. A decision that was already made, superseded or rejected changes what this one has to argue.
- When the user points you at discussions, such as chat threads, tickets or review comments, read them in full and resolve people's handles to names. Extract the core question, each participant's position with their reasoning, constraints mentioned, consensus points, unresolved tensions, shared links, and when the discussion happened.

| Discussion element    | Goes into                                   |
| --------------------- | ------------------------------------------- |
| Participants          | Deciders and stakeholders                   |
| Positions taken       | Alternatives, with the arguments as evidence |
| Consensus points      | Proposed recommendation                     |
| Unresolved tensions   | Key trade-offs to address                   |
| Constraints mentioned | Constraints                                 |
| Links shared          | Sources                                     |

- Search public sources for comparable decisions and published ADRs on the topic.

### 3. Discover alternatives

- **Technology decisions:** official documentation and best-practice guides, patterns already in use in available repositories, public evaluations and comparisons.
- **Architecture decisions:** public design patterns and reference architectures, similar systems in available repositories, the engineering tenets that apply.
- **Product decisions:** customer data, usage metrics and research; similar decisions in adjacent teams; the product strategy that applies.

Document at least three alternatives before evaluating any of them.

### 4. Gather evidence for the trade-offs

For each alternative, collect evidence on strengths and weaknesses: benchmarks with their method and conditions, adoption (who uses it, since when), operational data (incidents, on-call burden), cost (infrastructure, licensing, ramp-up) and maturity (version history, community, support model). Always include the source, distinguish measured data from estimates, give sample sizes and time periods, and say where data is missing.

### 5. Identify constraints

- **Technical:** existing stack, performance targets, security and compliance, integration with existing systems.
- **Organizational:** team expertise and ramp-up, delivery commitments, budget, mandated standards.
- **Operational:** on-call model, deployment pipeline, monitoring, disaster recovery.

### Biases to guard against

1. **Confirmation bias:** searching only for evidence that supports the preferred option. Search for weaknesses of the leading option and strengths of the others.
2. **Recency bias:** favoring something because it is new. Check how long it has been in production use.
3. **Anchoring:** letting the first option found dominate. List three alternatives before evaluating any.
4. **Authority bias:** "team X uses it, so it must be good". Ask why they chose it and whether their context matches yours.
5. **Missing data:** presenting incomplete data as complete. Say what you could not find and what you assumed.

### Research output

```markdown
## Research: [Topic]

### Current State

[What exists today, how it works, relevant metrics]

### Prior Decisions

- [ID]: [Title] — [Status] — [Relevance to this decision]

### Alternatives

#### Option A: [Name]

- **Description**: [What it is]
- **Evidence for**: [Data-backed strengths]
- **Evidence against**: [Data-backed weaknesses]
- **Adoption**: [Who uses it, since when]
- **Source**: [Links]

### Constraints

- [Constraint]: [Source or rationale]

### Gaps

- [What we could not find that would strengthen the decision]

### Sources

1. [URL]: [What it contains]
```

## Writing the Record

### The One-Sentence Test

Every decision record must contain one sentence that states the decision. If you cannot state the decision in one sentence, you have not decided yet.

Good: "We will use PostgreSQL as the primary datastore for the order service."
Bad: "We discussed several database options and decided to go with a relational approach."

### Context Section

The context sets the stage. A reader unfamiliar with the topic should understand the situation after reading this section.

Include:

- What system or process is affected
- What problem exists (be specific: "API latency exceeds p99 SLA of 200ms" not "API is slow")
- Why this needs to be addressed now
- Constraints: timeline, budget, team size, technical limitations

Exclude:

- Judgment about which option is better (save for the decision)
- Implementation details (save for after the decision)
- Vague problem statements without data

### Alternatives Section

Present at least 2-3 genuine alternatives. The hallmark of a weak decision record is alternatives that are obviously inferior (straw men).

For each alternative:

1. **Describe it fairly**: someone who advocates for this option should recognize it
2. **State its strengths**: every viable alternative has genuine strengths
3. **State its weaknesses**: be specific, with data where possible
4. **Explain why it was not chosen**: the rationale must be evidence-based

Bad: "Option 2: Use MongoDB. MongoDB is a NoSQL database that lacks ACID transactions and would be inappropriate for financial data."

Good: "Option 2: Use MongoDB. Document model aligns well with our varied order schemas and would reduce ORM complexity. However, our team has no MongoDB operational experience (0 of 6 engineers), and our data access patterns require multi-document transactions that MongoDB added in v4.0 but are still less mature than PostgreSQL's implementation (see [benchmark link])."

### Consequences Section

Consequences describe what changes as a result of the decision. Organize into Good, Bad, and Neutral.

Be specific and measurable:

Bad: "This will improve performance."
Good: "Expected to reduce p99 API latency from 450ms to under 200ms based on load testing of the prototype (see appendix)."

Bad: "Team needs to learn new technology."
Good: "3 of 6 engineers need PostgreSQL training (~2 weeks ramp-up based on prior TypeScript migration timeline)."

Neutral consequences are process and tooling changes that are neither good nor bad:

- "CI/CD pipeline needs a new PostgreSQL test stage"
- "On-call runbook needs updating for new failure modes"
- "Monitoring dashboards need new database metrics"

### Data and Evidence

Every quantitative claim needs a source. Every qualitative claim needs supporting reasoning.

Bad: "We increased throughput significantly."
Good: "Throughput increased from 1,200 to 3,400 requests/second under identical load conditions (see load test report [link])."

Always include baselines:

Bad: "Latency improved by 40%."
Good: "Latency improved by 40%, from 450ms p99 to 270ms p99 (measured over 7 days in the staging environment, [dashboard link])."

Every link you include should actually resolve (check before including), support the specific claim you are making, and be described so the reader knows what they will find.

### Language Guidelines

Use active voice:

Bad: "It was decided that PostgreSQL would be used."
Good: "We will use PostgreSQL."

Replace vague quantifiers with data, or remove them:

| Vague                   | Better                        |
| ----------------------- | ----------------------------- |
| many teams              | 12 teams (per [source])       |
| significant improvement | 40% improvement (from X to Y) |
| recently                | in Q3 2025                    |
| often                   | in 7 of 10 observed cases     |
| some concerns           | 3 specific concerns: [list]   |

Be direct:

Bad: "After careful consideration of the various options available, we have determined that it would be most beneficial to proceed with Option A."
Good: "We chose Option A because [reason]."

## ADR Mode

Write an Architecture Decision Record for every significant design decision. A decision is significant if it:

- chooses between two or more viable architectural options;
- has non-trivial cost, latency, complexity, scalability or operability implications;
- will be difficult or expensive to reverse.

Do not write an ADR for implementation details, such as a variable name or a pinned library version.

### 1. Gather the decision context

From the conversation and the documents, collect the problem and its constraints, the chosen option and its main reason, at least two alternatives with pros and cons (use `trade-off-evaluator` scores when they exist), and the status.

If the alternatives are not documented yet:

- **Interactive use:** record the alternatives the conversation already discussed. If none were explored, suggest one or two plausible ones and discuss them with the user before writing. Do not silently invent alternatives the user never considered.
- **Unattended workflow step:** do not ask. Infer at least one viable alternative from the decision context and any trade-off data. If no credible alternative can be inferred, add the placeholder row `| <TBD — flagged for review> | — | — | — |` and flag the ADR for the review that follows, so the table always has at least two rows.

### 2. Write the ADR

Use the project's template when it has one. Otherwise use this format:

```markdown
### ADR-N: <Title>

**Status:** Accepted | Proposed | Deprecated | Superseded by ADR-M

#### Context

What situation or problem triggered this decision. What constraints apply.
One paragraph. Specific — include data where available (latency targets, team size, timeline).

#### Decision

We will use X because Y. (One sentence. Active voice. State the concrete technical reason for acceptance — crisp, specific, fact-checked.)

#### Alternatives Considered

| Option            | Pros | Cons | Why Not Chosen (crisp, specific, fact-checked — 1–3 sentences)   |
| ----------------- | ---- | ---- | ---------------------------------------------------------------- |
| Option A (chosen) | ...  | ...  | — (chosen; acceptance rationale in Decision above)               |
| Option B          | ...  | ...  | <concrete technical reason: limit / latency / cost / ops burden> |

_Scored trade-off matrix: see `<name>-tradeoffs.md` or inline table above._

#### Consequences

**Good:**

- <specific, measurable positive outcome>

**Bad:**

- <specific cost, risk, or constraint introduced>

**Neutral:**

- <process or tooling change — neither good nor bad>
```

**Rationale quality bar.** Applies to every `Decision` (why accepted) and every `Why Not Chosen` cell (why rejected):

- **Crisp and simple:** one to three sentences per option, no filler or hedging.
- **Technically accurate and specific:** cite the concrete reason, such as limits, latency, cost, consistency model, throughput or operational burden, not vague generalities.
- **Fact-checked:** verify a claim before you rest a decision on it, with `doc-accuracy-analyzer` for claims about the code or the system and `aws-service-validator` for AWS service and feature claims. Never assert an unverified capability as the basis for a decision.

> Weak: "DynamoDB scales better." Strong: "DynamoDB sustains our projected 50k writes/s at p99 <5ms without table-level locking; RDS Aurora peaks at ~10k writes/s on db.r6g.2xlarge under the same load test (verified via `aws-service-validator`)."

Set the status: `Accepted` for decisions made while writing the design, `Proposed` when the user has not confirmed the choice. Include an architecture diagram (Mermaid) when the decision changes the topology, describe the integration points with other systems, and consider the operational impact: monitoring, on-call and deployment.

### 3. Number and place it

- **With a project convention:** use the project's next number and location, and link the record from the design document where the decision first comes up.
- **Without one (the default):** number ADRs sequentially within the design document: find the highest ADR number in its `## Architecture Decision Records` section and add one, or start at ADR-1. Insert the ADR in that section; if it does not exist, create it after the Implementation Plan section. Cross-reference it where the decision is first mentioned, for example in the Solution Overview: `_(See ADR-N)_`.

Inline numbers are scoped to one document; ADR-3 in two design documents are unrelated decisions. When you refer to an inline ADR from another document, name its document: "see ADR-3 in payments-design.md". Reference related ADRs by ID when decisions depend on each other.

## Program Decision Document Mode

A program decision document helps stakeholders choose between options before the decision is made, and records the outcome afterwards.

### Decision context

State what decision is needed, why now (the trigger and its urgency), who the stakeholders are, which constraints apply (budget, timeline, compliance), and what happens if no decision is made.

### Options analysis

Analyze two to five options. Always include "do nothing" as the baseline. For each option give a description, pros, cons, an effort estimate (T-shirt size), a risk level (high, medium, low) and how well it fits the program's goals.

### Weighted evaluation matrix

Define the criteria, such as cost, time to market, scalability, risk and team capability. Give each a weight; the weights sum to 100%. Score each option per criterion from 1 to 5 and compute the weighted total. The highest total is the recommendation unless an overriding factor exists, and then you state it.

### Decision record

Once the decision is made, record the date, the decision maker, the selected option, the rationale over the alternatives, any dissenting opinions, the conditions that would trigger reconsideration, and a date to review it regardless.

### Output format

1. **Title and status:** Draft, Under Review, Decided or Superseded
2. **Context:** background, trigger, constraints, default outcome
3. **Stakeholders:** driver, approver, contributors and informed (DACI)
4. **Options table:** option, description, pros, cons, effort, risk
5. **Evaluation matrix:** criteria, weight, a score column per option, weighted totals
6. **Recommendation:** the recommended option with its rationale, in two or three sentences
7. **Decision record:** date, decision maker, selected option, dissent, revisit conditions

## PDR and UXDR Tips

PDR (product decision record):

- Lead with customer impact
- Include success metrics with targets
- Address pricing and cost implications
- Reference the competitive landscape with sources

UXDR (user experience decision record):

- Include mockups or wireframe references
- Address accessibility (WCAG compliance)
- Reference user research findings with participant counts
- Consider responsive and cross-platform implications

## Quality Gate

Check the record against the gate for its type, and present findings in the order CRITICAL, IMPORTANT, SUGGESTION. When the user is present, offer to fix them. When a workflow step or another skill invoked this one, report all findings and leave fixing to the caller.

When the record follows a project template, the section names and table shapes below describe this skill's default format. Check that the same information is present in the project's structure instead, and do not report a finding only because the project names or shapes it differently.

**Every record:**

- CRITICAL: no one-sentence decision; fewer than two genuine alternatives (a straw man does not count); a record that does not follow the project's existing convention, or that renumbers or rewrites an existing record. An ADR written in an unattended step with the `<TBD — flagged for review>` placeholder row (see ADR Mode) passes the alternatives check until that review, which must replace the placeholder with a genuine alternative or confirm that none exists.
- IMPORTANT: vague consequences ("will improve performance" without a metric); a quantitative claim without a source; a claim the decision rests on that was not verified.

**ADR:**

- CRITICAL: a missing section (Context, Decision, Status, Alternatives Considered, Consequences); fewer than two rows in the alternatives table, counting the chosen option; status not set.
- IMPORTANT: consequences not split into Good, Bad and Neutral with at least one entry each; a number that is not unique where the record lives; no cross-reference from the place in the design document where the decision comes up; a `Decision` or `Why Not Chosen` cell that misses the rationale quality bar. Rows flagged `<TBD — flagged for review>` are exempt until that review.

**Program decision document:**

- CRITICAL: no "do nothing" baseline; criteria weights that do not sum to 100%; a decision record without decision maker or date; a recommendation that contradicts the matrix without a stated reason.
- IMPORTANT: pros or cons missing for an option; no revisit conditions; stakeholders not identified.
- SUGGESTION: a cost comparison for options with budget impact; links to the program milestones the decision affects.
