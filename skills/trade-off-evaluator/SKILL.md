---
name: trade-off-evaluator
description: 'Use when a design decision has options to weigh: a quick architecture recommendation, opinion or sanity check ("should I use X or Y?", "does this approach make sense?"), or an in-depth comparison ("evaluate the trade-offs between X and Y", "score these options", "which is better: SQS or EventBridge for this use case", "compare these alternatives"), or when the k-design-doc-creation SOP reaches its trade-off step. Answers a quick question concisely with trade-offs; for a full comparison, scores cost, latency, complexity, scalability, and operability in a matrix with a recommendation.'
version: 1.1.0
tags: [skill, design, trade-offs, evaluation, decision, architecture, advisor, recommendations]
---

# Trade-Off Evaluator

Two modes:

- **Quick opinion:** the user wants a recommendation or a sanity check, not a design document. Give
  one clear answer with its trade-offs, an action plan and an effort estimate. See
  [Quick opinion](#quick-opinion).
- **Scored comparison:** produces a scored comparison matrix for design decisions with multiple
  options. Each option is scored 1–5 across five dimensions. Outputs a recommendation with
  rationale and per-option risks. The rest of this file, from When to Use, describes it.

Use the quick mode for a question, and the scored mode when the user asks to compare or score
options, when an ADR needs scored alternatives, or when the decision is costly to reverse.

## Quick opinion

Do not use it when the user wants a full system design (use `system-design-patterns`), API specs
(`smithy-modeling`), a data model (`dynamodb-design`) or a threat model (`threat-modeling`).

### Decision framework

1. **Bias toward simplicity**: Least complex solution that fulfills requirements
2. **Use existing**: Favor modifications over new components
3. **Developer experience**: Optimize for readability and maintainability
4. **One clear path**: Single primary recommendation. Don't hedge
5. **Match depth to complexity**: Quick questions get quick answers

### Response structure

**Essential (always include):**

- **Bottom line**: 2-3 sentences capturing the recommendation
- **Action plan**: Numbered steps for implementation
- **Effort estimate**: Quick(<1h), Short(1-4h), Medium(1-2d), Large(3d+)

**Expanded (include when trade-offs are involved):**

- **Why this approach**: Brief reasoning behind the recommendation
- **Trade-offs considered**: Alternatives evaluated and why they were rejected
- **Watch out for**: Specific risks, pitfalls, or edge cases
- **Mitigation strategies**: How to handle identified risks

**Edge cases (include for scalability or architecture decisions):**

- **Escalation triggers**: Conditions under which to abandon the simple approach
- **Alternative sketch**: High-level outline of the more complex path
- **When to reconsider**: Signals that the advanced approach is needed

| Question complexity   | Include                           |
| --------------------- | --------------------------------- |
| Simple, clear answer  | Essential only                    |
| Trade-offs involved   | Essential + Expanded              |
| Scalability concerns  | Essential + Expanded + Edge cases |
| Architecture decision | Essential + Expanded + Edge cases |

### Examples

> "Should I use useState or useReducer for this form?"

**Bottom line**: Use useState. This form has 3 fields with no complex interdependencies.

**Action plan**:

1. Create state for each field
2. Add onChange handlers
3. Validate on submit

**Effort estimate**: Quick (<1h)

> "Should we migrate from REST to GraphQL?"

**Bottom line**: Not yet. Your current API surface is small and REST is working. GraphQL adds complexity you don't need.

**Action plan**:

1. Document current pain points with REST
2. Evaluate if BFF pattern solves issues more simply
3. Revisit GraphQL when you have 10+ interconnected resources

**Effort estimate**: N/A (recommending against)

**Why this approach**: GraphQL works well with complex, interconnected data graphs. Your current 5 endpoints don't justify the tooling overhead.

**Trade-offs considered**: GraphQL would give better client flexibility, but at the cost of server complexity, caching challenges, and team learning curve.

**Watch out for**: N+1 query problems if you do migrate later. Plan resolver batching from day one.

**Escalation triggers**: Reconsider if you're building 5+ new clients, or if over-fetching becomes a measurable performance issue.

**Alternative sketch**: If migrating, start with a GraphQL gateway over existing REST, then incrementally move resolvers.

### Quick opinion quality gate

**CRITICAL (must fix):**

- No clear recommendation (hedging with "it depends" without a primary path)
- Missing effort estimate
- Recommendation contradicts constraints the user stated

**IMPORTANT (should fix):**

- No trade-off analysis for decisions with multiple viable options
- Missing risks or watch-out-for items
- Action plan steps are vague

**SUGGESTION:**

- Could add escalation triggers for when to revisit the decision
- Could reference specific AWS documentation or best practices

## When to Use

- The quality gates step of the `k-design-doc-creation-sop` workflow, for each significant decision
- Standalone: engineer asks to compare options for a specific decision
- When an ADR's Alternatives table needs scored backing

## Scoring Rubric

Score each option 1–5 per dimension. Higher is better.

| Dimension       | 1 (Poor)                                       | 3 (Acceptable)                               | 5 (Excellent)                                       |
| --------------- | ---------------------------------------------- | -------------------------------------------- | --------------------------------------------------- |
| **Cost**        | Significantly more expensive than alternatives | Comparable cost to alternatives              | Lowest cost or best cost/value ratio                |
| **Latency**     | Adds >100ms or introduces synchronous blocking | Adds <50ms or acceptable async delay         | Minimal latency impact; sub-10ms or fully async     |
| **Complexity**  | Requires new expertise, significant new infra  | Familiar patterns, moderate operational load | Simple, uses existing patterns and tooling          |
| **Scalability** | Hard ceiling or requires manual intervention   | Scales with effort (e.g., shard management)  | Auto-scales to 10× current load without changes     |
| **Operability** | New failure modes, no existing runbooks        | Manageable with runbook updates              | Existing monitoring, runbooks, and on-call coverage |

## Steps

### Step 1: Identify Decision and Options

Extract from context:

- **Decision context.** What problem is being solved, what constraints apply
- **Options.** At least 2, at most 5; each with a name and brief description
- **Dimensions.** Default to all five; omit a dimension only if it is genuinely not applicable (state why)

### Step 2: Score Each Option

For each option × dimension pair:

1. Reason about the score based on the decision context and known service characteristics
2. Assign a score 1–5
3. Write a one-line justification

Do not assign scores from memory alone for AWS service characteristics. Cross-reference with `aws-service-validator` findings. When `aws-service-validator` is not used, you MUST note the assumption explicitly.

### Step 3: Produce Comparison Table

```markdown
## Trade-Off Analysis: <Decision Title>

| Option   | Cost | Latency | Complexity | Scalability | Operability | Total |
| -------- | ---- | ------- | ---------- | ----------- | ----------- | ----- |
| Option A | 4    | 3       | 5          | 4           | 4           | 20    |
| Option B | 3    | 5       | 3          | 5           | 3           | 19    |
| Option C | 5    | 2       | 2          | 3           | 2           | 14    |

**Scores:** 1 = poor, 5 = excellent. Higher total = better overall fit.
```

### Step 4: Recommendation and Risks

After the table, provide:

```markdown
**Recommendation:** Option A — highest operability and complexity scores align with the team's
existing Lambda + DynamoDB expertise. Latency score of 3 is acceptable given the async processing
requirement.

**Risks per option:**

- **Option A:** Cost increases at >10k events/min; monitor with CloudWatch billing alarms.
- **Option B:** Latency advantage disappears under fan-out scenarios; test at 5× peak load.
- **Option C:** Complexity score of 2 reflects no existing team expertise; budget 2-week ramp-up.
```

### Step 5: Write Report

Write the full trade-off report to `docs/design/<name>-tradeoffs.md`. If a calling workflow asks for it, embed the table in the relevant ADR's Alternatives section.

## Pitfalls

- **Do not score from memory for AWS service characteristics.** Use `aws-service-validator` or note the assumption explicitly.
- **Do not omit a dimension without stating why**: "not applicable" must be justified.
- **Do not recommend the option with the highest total if context overrides it.** A hard constraint (e.g., "must be synchronous") can disqualify an option regardless of score.
- **Avoid straw-manning.** Every option must be scored fairly; a score of 1 requires a specific justification.

## Verification

After producing the report, confirm:

- Every option has a score for every applicable dimension
- Every score has a one-line justification (inline or in a notes section)
- The recommendation references the scores explicitly
- Risks are specific, not generic ("may be slower" is not a risk; "adds ~80ms per hop under fan-out" is)

## Quality Gate

The trade-off evaluation passes when:

- At least 2 options are scored
- All five dimensions are addressed (or explicitly excluded with justification)
- The recommendation names the chosen option and references at least 2 dimension scores
- The report is written to `docs/design/<name>-tradeoffs.md` or embedded in the ADR
