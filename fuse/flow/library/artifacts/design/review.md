# Reviewing a design document

The final quality gate before a design goes to implementation. The review has two parts: the
document's writing quality and structure, then the design's production readiness. Do both, in
that order, unless the step asks for only one. `guide.md` next to this file says how a good design
document is written.

Use the review findings priorities: P0 wrong or unsafe, P1 a requirement missed or a defect a user
would hit, P2 worth fixing, P3 a nit. Present every finding before any fix; do not ask clarifying
questions during the review.

## Part 1: writing quality and structure

Report the document's section count and approximate word count first.

### Structural completeness

Check that the document has these sections:

- Problem or Background
- Requirements, or a reference to the approved requirements
- Solution Overview
- How It Works, with at least one diagram
- Implementation Details or Plan, unless the step leaves the plan to a later artifact
- Decision records: at least one, inline or linked, if decisions were made

Each missing section is a `missing_section` finding.

### Slop and reasoning

Scan every paragraph for these issue types:

| Type                    | Examples                                                                                                   | Priority |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| `filler_phrases`        | "it is worth noting", "needless to say", "as mentioned above", "in order to", "it should be noted that"    | P3       |
| `hedge_words`           | "might", "could potentially", "may or may not", "somewhat", "fairly" (when used to avoid commitment)       | P3       |
| `unsupported_claims`    | Performance, latency or cost assertions with no evidence link or measurement                               | P2       |
| `passive_voice_overuse` | More than 30% passive constructions in a section                                                           | P3       |
| `circular_reasoning`    | Justification restates the claim without adding evidence (e.g., "we chose X because X is the best choice") | P2       |
| `yagni_violation`       | Features, abstractions, or extensibility points not required by stated requirements                        | P2       |
| `missing_section`       | Required section absent                                                                                    | P2       |

For each decision or design choice, check whether the simplest option was chosen or the complexity
is justified by a stated requirement, and whether there are abstractions with no current use case.
Flag unjustified complexity as `yagni_violation`.

### Pitfalls

- Do not flag technical hedging that is accurate (e.g., "Lambda cold starts typically add 100–500ms" is not a hedge; it is a range).
- Do not flag passive voice in formal definitions or standards references.
- Do not penalize brevity. A short, complete doc scores higher than a verbose, incomplete one.
- `unsupported_claims` applies only to quantitative assertions (latency, cost, throughput). Qualitative design rationale does not require evidence links.

### Quality score

Score the document from 1 to 5. Count P2 findings as "important" and P3 findings as "minor":

| Score | Meaning                                                      | Gate                        |
| ----- | ------------------------------------------------------------ | --------------------------- |
| 5     | No issues                                                    | Review-ready                |
| 4     | Only minor issues (3 or fewer)                               | Review-ready with notes     |
| 3     | More than 3 minor issues, or 1–2 important issues            | Advance with revision notes |
| 2     | 3 or more important issues, no missing required sections     | Significant revision needed |
| 1     | 3 or more important issues plus one or more missing sections | Rewrite required            |

The score reflects the worst issue type present: one important issue cannot yield a 5. A score
below 3 blocks the design from advancing to adversarial review and is itself a P1 finding. Every
important issue gets a concrete suggestion for resolving it, and a missing required section is
flagged even when the document is otherwise well written.

## Part 2: production readiness

Evaluate the complete design package: the system design, and the threat model, API specs, data
models, diagrams and access policies where they exist. Tailor the depth to the project's scope:

- **Small (1-2 services):** prioritize simplicity, maintainability, and avoiding over-engineering.
- **Medium (3-10 services):** balance scalability, security, and performance while ensuring
  modularity, and look at cross-service interactions.
- **Large (10+ services):** focus on high-scale optimizations, distributed system reliability,
  failure resilience, and operational maturity.

Use design templates as references, not strict requirements. Evaluate only the sections relevant
to this design; if a section is not applicable, say so and whether the omission is reasonable. If
a template suggests a feature this project does not need, say why, and when it might be needed
later.

Score each of the ten dimensions from 1 to 5, and say which ones do not apply:

1. **Template adherence.** Does the design follow the relevant sections of the templates? Name the
   deviations and whether they are acceptable for the scope. Raise a missing section only if the
   project needs it.
2. **High-level assessment.** The design's strengths and weaknesses, and its overall technical
   soundness.
3. **Scalability.** Can the system handle high traffic and future growth? Name the bottlenecks and
   the patterns that would remove them, such as load balancing, caching or sharding.
4. **Performance.** Latency issues, inefficient queries and resource constraints, with
   optimizations such as indexing, caching strategies or asynchronous processing.
5. **Security.** Vulnerabilities in, for example, API security and data protection, with the
   practices that address them, such as authentication, encryption and rate limiting.
6. **Maintainability and extensibility.** How easy the system is to update and extend: modularity,
   separation of concerns, the SOLID principles.
7. **Failure handling and resilience.** Fault tolerance, redundancy and recovery, and what would
   improve availability and disaster recovery.
8. **Code and implementation quality.** Architectural anti-patterns and inefficiencies.
9. **Testability and automation readiness.** How easy unit, integration and end-to-end testing
   are; obstacles to mocking, stubbing and fault injection; readiness for continuous integration
   and delivery, structured logging and monitoring.
10. **Actionable recommendations.** Detailed, practical steps to improve the design, with
    architecture patterns and concrete examples.

Be rigorous and constructive, and push for a best-in-class design.

### What blocks implementation

These are P0 findings:

- The security design has unmitigated high-severity threats.
- There is no failure handling strategy for external dependencies.
- The data model cannot support every documented access pattern.
- The API design risks breaking changes and has no versioning strategy.

These are P1 findings, to address before implementation:

- No observability strategy: metrics, logs and traces are not defined.
- No runbook or operational playbook is referenced.
- Cost estimates are not checked against the architecture.

Worth suggesting as P3:

- Chaos engineering scenarios to validate resilience.
- Service level objectives and error budgets.

## The summary

Give the quality score, the ten dimension scores and their average, then the findings, most
severe first.
