# Design interview and pattern selection

How to gather what a design document needs and choose its architectural patterns: a structured
interview that collects the business context, requirements and constraints, challenges the
assumptions behind each choice, and recommends proven patterns. `guide.md` next to this file says
how the design document itself is written, and `review.md` how it is reviewed.

The questions assume an AWS-based solution built with CDK or CloudFormation that customers deploy
in their own AWS accounts. Use this interview when the system targets AWS, or when the owner
chooses it for another system; for any other system the design guide does without it.

A step that only checks a design against these questions, for example while reviewing it, needs
only the "Design checklist" section at the end.

## Approach

- **Start high-level, then go deep.** Begin with the system overview and an architecture outline,
  then explore each component.
- **Challenge assumptions.** Question each design decision and explore alternatives.
- **Give opinionated guidance.** Recommend AWS best practices and architectural patterns.
- **Put security first.** Make sure IAM policies, authentication and authorization follow AWS
  standards.
- **Keep cost in view** throughout the design.

### Where the answers come from

Each question below is one the design must answer. Take the answer from the step's inputs first:
the requirements, the existing code and design documents, and earlier answers. Ask the owner only
for what the inputs do not settle, unless the step or its inputs already say. In an unattended step,
record what no input settles as an open question in the design instead of guessing.

### Depth

Run the comprehensive interview (20 or more questions across all phases) unless the step or the
owner asks for a focused one (5 to 10 questions on the core components).

## Phase 1: System overview (5 to 7 questions)

1. **Purpose:** what problem does the system solve, and what are its core capabilities?
2. **Use case:** is it a new system or a refactoring of an existing one?
3. **Scale:** expected traffic patterns, data volume, concurrent users?
4. **Deployment model:** single-tenant per customer account? Multi-region support?
5. **Integration points:** which external systems or AWS services must it integrate with?
6. **Compliance:** which regulatory or security standards apply, such as HIPAA, PCI-DSS or SOC 2?
7. **Success criteria:** how will you measure that the system works correctly?

After this phase, write a high-level architecture outline with the major components. Ask the owner
whether it captures their intent and whether components are missing or unnecessary, unless the
step or its inputs already confirm the components.

## Phase 2: Architecture preferences (3 to 5 questions)

1. **Compute model:** serverless (Lambda, Step Functions), containers (ECS, Fargate) or a hybrid?
   Challenge: "Why this choice? Have you considered [alternative] for [specific use case]?"
2. **Event processing:** synchronous (API Gateway and Lambda), asynchronous (EventBridge, SQS, SNS)
   or stream processing (Kinesis)? Challenge: "What happens if processing takes longer than
   expected?"
3. **Data storage:** DynamoDB, RDS or Aurora, S3, or a combination? Challenge: "What are your query
   patterns? How will you handle data growth?"
4. **State management:** stateless, Step Functions for orchestration, or DynamoDB for state?
   Challenge: "How will you handle failures and retries?"
5. **API design:** REST through API Gateway, GraphQL through AppSync, or gRPC? Challenge: "Who are
   the API consumers? What are their latency requirements?"

## Phase 3: Component deep dive

For each major component from Phase 2, establish:

1. **Responsibility:** its single responsibility.
2. **Inputs and outputs:** the data it receives and produces.
3. **Dependencies:** the components and AWS services it depends on.
4. **Failure modes:** what happens when it fails.
5. **Scaling:** how it scales under load.
6. **Cost drivers:** its primary cost factors.

Branch on the choices made:

- Lambda: cold starts, memory allocation, timeout handling.
- DynamoDB: partition key design, secondary index strategy, capacity mode.
- Step Functions: long-running workflows, error handling, human approval steps.
- API Gateway: throttling, caching, authorization strategy.

## Phase 4: Cross-cutting concerns (8 to 10 questions)

1. **Authentication and authorization:** how do customers authenticate (IAM roles, Cognito, an
   external identity provider)? Which authorization model (role-based, attribute-based,
   resource-based policies)? Challenge: "How will you prevent privilege escalation? How do you
   audit access?"
2. **Security and compliance:** which IAM permissions does the solution need in customer accounts,
   and how does it follow least privilege? What encryption at rest and in transit? Challenge:
   "Have you considered your organization's security standards? How will you manage secrets?"
3. **Observability:** which metrics matter for system health? How will customers troubleshoot?
   CloudWatch, X-Ray, custom dashboards? Challenge: "What is your alerting strategy? How do you
   detect silent failures?"
4. **Error handling and resilience:** retry strategies for transient failures, circuit breakers
   for downstream dependencies, dead-letter queues for failed messages. Challenge: "What is your
   disaster recovery plan? What are the recovery time and recovery point objectives?"
5. **Cost:** the primary cost drivers, how customers control costs, reserved capacity or on-demand.
   Challenge: "Have you estimated cost at 10x scale? What is the cost per transaction?"
6. **Deployment and updates:** blue/green deployments, canary releases, rollback strategy.
   Challenge: "How do you handle schema migrations and backward compatibility?"
7. **Testing:** unit tests for business logic, integration tests for AWS service interactions,
   load testing. Challenge: "How do you test IAM policies? How do you validate security
   controls?"
8. **Documentation and support:** what documentation customers need, how they report issues, the
   upgrade path for new versions.

## Phase 5: Data design preparation

When the system uses DynamoDB or needs an API design, establish:

1. **Access patterns:** every way the data will be queried.
2. **Data relationships:** the entities and how they relate.
3. **Read and write ratio:** the expected distribution.
4. **Consistency:** whether strong consistency is needed or eventual consistency is acceptable.
5. **Data lifecycle:** retention and archiving.

These answers are the input for the API model and the data model. For the API, see the `api-model`
guide in the fuse library (`fuse/flow/library/artifacts/api-model/guide.md` in the fuse-konductor
clone). For the data model, see the `dynamodb-design` and `dynamodb-validation` skills.

## Interview practice

### Challenging assumptions

When a design choice is made, probe it:

- "Why [choice] over [alternative]?"
- "What happens if [edge case]?"
- "Have you considered [AWS service] for this use case?"
- "How does this scale to 10x your expected load?"
- "What is the failure mode here?"

### Recommending patterns

Suggest proven patterns where they fit:

- **Event-driven:** for loose coupling, EventBridge instead of direct Lambda invocations.
- **Serverless first:** Lambda and DynamoDB can often do the job with less operational overhead
  than ECS.
- **Cost:** S3 Intelligent-Tiering for infrequently accessed data.
- **Security:** IAM roles for service-to-service authentication instead of API keys.

### Recognizing gaps

When something critical has not come up, raise it and say why it matters before moving on. Summarize
what has been established at the end of each phase.

## Outputs

The interview supplies the content of the design document, and can supply three companion
documents: a threat model input, an architecture diagram description and a design review handoff.
Write a companion document only when the step declares it or the owner asks for it, to the path the
step gives it, or next to the design document when the interview is used on its own. Otherwise put
what the design needs from it into the design document, and leave out the rest.

### 1. The design document

Write it as `guide.md` next to this file says. The outline below is the content the interview must
supply, not a second document structure.

```markdown
# [System Name] - System Design

## Executive Summary

[Two or three paragraphs on the system]

## Architecture Overview

[High-level architecture]

### Architecture Diagram Description

[Components and data flow, detailed enough to draw from]

## Components

### [Component Name]

- **Purpose**: [Single responsibility]
- **Technology**: [AWS services used]
- **Inputs**: [Data received]
- **Outputs**: [Data produced]
- **Scaling**: [How it scales]
- **Cost Factors**: [Primary cost drivers]
- **Failure Modes**: [What happens when it fails]

[Repeat for each component]

## Cross-Cutting Concerns

### Security & IAM

- **Customer IAM Requirements**: [Permissions needed]
- **Authentication**: [How users and services authenticate]
- **Authorization**: [Access control model]
- **Encryption**: [At rest and in transit]
- **Secrets Management**: [How secrets are handled]

### Observability

- **Key Metrics**: [What to monitor]
- **Logging Strategy**: [What gets logged]
- **Tracing**: [Distributed tracing approach]
- **Alerting**: [Alert conditions and thresholds]

### Error Handling

- **Retry Strategy**: [How retries work]
- **Circuit Breakers**: [When to stop trying]
- **Dead Letter Queues**: [Failed message handling]
- **Disaster Recovery**: [Recovery objectives and backup strategy]

### Cost Optimization

- **Primary Cost Drivers**: [What costs the most]
- **Cost Control Mechanisms**: [How customers control costs]
- **Estimated Cost**: [Cost per transaction or monthly estimate]

## Data Design

### Access Patterns

1. [Pattern]

### Data Entities

- **[Entity Name]**: [Description and key attributes]

### Query Patterns

[How data will be queried; input for the data model]

## API Design Overview

[High-level API structure; input for the API model]

## Deployment Strategy

- **Deployment Model**: [How customers deploy]
- **Update Strategy**: [How updates are rolled out]
- **Rollback Plan**: [How to revert changes]

## Testing Strategy

- **Unit Testing**: [What gets unit tested]
- **Integration Testing**: [How AWS services are tested]
- **Load Testing**: [Performance validation approach]
- **Security Testing**: [IAM and security validation]

## Open Questions

[Unresolved design decisions]

## Next Steps

1. [Immediate next actions and follow-up artifacts]
```

### 2. Threat model input

This is the input for the `threat-model` guide in the fuse library
(`fuse/flow/library/artifacts/threat-model/guide.md` in the fuse-konductor clone).

```markdown
# [System Name] - Threat Model Input

## Trust Boundaries

[Where data crosses security boundaries]

## Assets

[What needs protection]

## Threat Scenarios

1. **[Threat Name]**: [Description]
   - **Impact**: [What happens if exploited]
   - **Mitigation**: [How the design addresses it]

## IAM Policy Review Points

[IAM policies that need security review]

## Security Standards Compliance

[How the design meets the organization's security standards]
```

### 3. Architecture diagram description

This is the input for the `architecture-diagram-generation` skill.

```markdown
# [System Name] - Architecture Diagram

## Component Layout

[How the components are arranged in the diagram]

## Data Flow

1. [Step-by-step data flow through the system]

## AWS Services Used

- [Service]: [Purpose]

## Integration Points

[External systems and how they connect]

## Diagram Tool Instructions

[Instructions for the diagram tool in use]
```

### 4. Design review handoff

```markdown
# [System Name] - Design Review Handoff

## Design Review Agenda

1. **Architecture overview** (10 min): high-level architecture, component responsibilities
2. **Security review** (15 min): IAM policies and least privilege, authentication and
   authorization, security standards compliance
3. **Cost analysis** (10 min): primary cost drivers, estimated costs at scale, cost controls
4. **Technical deep dive** (20 min): component walkthrough, data flow and integration points,
   error handling and resilience
5. **Open questions** (10 min): unresolved decisions, areas needing research
6. **Next steps** (5 min): action items and owners, implementation timeline

## Key Decisions Made

[Major architectural decisions and their rationale]

## Risks & Mitigations

[Identified risks and how they are addressed]

## Success Criteria

[How we will know the implementation is successful]

## Follow-up Artifacts

- API model: the `api-model` guide in the fuse library (if applicable)
- Data model: the `dynamodb-design` and `dynamodb-validation` skills (if applicable)
- Threat model: the `threat-model` guide in the fuse library
```

## Design checklist

A design produced by this interview, or one under review, must answer the component questions in
Phase 3 for every component and the cross-cutting concerns in Phase 4. Then apply this gate.

**CRITICAL (must fix):**

- No non-functional requirements documented: performance targets, availability, scale.
- Security requirements missing.
- No architecture diagram description.
- Technical constraints not captured.

**IMPORTANT (should fix):**

- Vague performance targets ("fast") instead of specific ones ("<500ms p99").
- Scale requirements not separated between demo and production.
- Integration points with existing AWS services not identified.

**SUGGESTION:**

- Explicit data flow descriptions for each component.
- Cost optimization opportunities in the architecture.

Present findings in the order CRITICAL, IMPORTANT, SUGGESTION. When you produced the design, fix
what the gate finds before handing it over. When you apply the gate to someone else's design,
report all findings and leave fixing to the caller.
