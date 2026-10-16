# Writing an end-to-end test strategy

An end-to-end test strategy decides which user journeys get end-to-end tests, in what priority,
and how those tests run: with what test data, in which environments, in what order and with
which controls against flakiness. It is a plan, not test code. It is written from a test gap
analysis or a discovery report, the user stories and the system design, and it classifies every
candidate test as P0 (critical path, must not fail), P1 (core features, high business value), P2
(edge cases, important but not blocking) or P3 (nice to have, low risk if deferred). Writing the
tests themselves is a separate job; for Playwright specs, the `playwright-test-implementation`
skill covers it.

## Inputs

If a calling workflow supplied paths for any artifact below, or for the output file, you MUST use
those values and skip the corresponding question. Ask the owner only for what the caller did not
supply, in a single message, and ask nothing when everything was supplied: a delegated run may
have no person present to answer. Where a caller supplies none of the optional context, treat the
feature plan as absent, the change type as `enhancement` and the release type as `minor` rather
than blocking.

- **Output file.** The step's artifact path. Used on its own, ask the owner, unless the request
  says; propose `e2e-test-strategy.md` next to the gap analysis.
- **Test gap analysis**, written with the `test-coverage` guide in the fuse library
  (`fuse/flow/library/artifacts/test-coverage/guide.md` in the fuse-konductor clone): the testing
  model, the test distribution, the coverage per acceptance criterion and the gaps. A **discovery
  report**, written with the `discovery-report` guide in the fuse library
  (`fuse/flow/library/artifacts/discovery-report/guide.md`), may stand in for it when the strategy
  is planned for a live web app before tests exist; then the pages, flows and forms it lists are
  the starting point for the journeys.
- **User stories** with acceptance criteria, when given: the journeys and their business value.
- **System design**, when given: the components, the integration points and the data flows.
- **Feature plan**, when given: the implementation approach and the code structure.
- **Change type:** `enhancement`, `bug` or `security`.
- **Release type:** `major`, `minor` or `patch`.
- **Code location**, optional: helps to read the code structure, not required for the plan.

Check that each supplied path exists and that the change and release types are among the values
above. When a path does not exist, search the workspace for the likely file first; ask the owner
only when the search finds nothing, and in an unattended step report the input as missing.

## 1. Read the starting point

From a **gap analysis**, take:

- the architecture type, the testing model (pyramid, trophy, hybrid, microservices), and the
  expected and current share of end-to-end tests;
- the existing end-to-end tests: their files and locations, the journeys they cover and whether
  they pass;
- the gaps an end-to-end test would close: critical gaps, warnings, and manual tests that could be
  automated;
- which features have end-to-end coverage and which do not.

Count test cases from the test runner's output (for example `npm test` or `pytest
--collect-only`), never from the file system: one file often holds ten to fifty tests, and 123
files can be 1,236 cases. Report both numbers. Definitions of "integration test" differ, so say
which classification you used.

From a **discovery report**, take each page, its interactive elements, its forms with their
validation rules, and the flows between pages. Each page or flow is a candidate journey; each
form's validation rules are candidate negative cases. A form whose validation trigger is
`unknown` submits only with the owner's confirmation; mark every test that submits it.

## 2. Map the user journeys

A user journey is a sequence of user actions that accomplishes a goal. Look for:

- **Multi-step workflows:** log in, open the dashboard, act, see the confirmation; search, filter,
  select, open the details, act; create, edit, submit, review, approve.
- **Critical business flows:** registration and onboarding, authentication and authorization,
  core transactions such as purchase, booking or submission, creating and changing data, payment
  and checkout.
- **Cross-feature interactions:** workflows that span features, need several user roles, or
  depend on external systems.

Record for each journey an identifier (`UJ-001`), a name, the steps, the user stories and
acceptance criteria it covers, the persona, the expected outcome and the business criticality
(critical, high, medium, low). Classify its complexity: **simple** (three to five steps, one
feature, no external dependency, deterministic), **moderate** (six to ten steps, several features,
some state or conditional logic) or **complex** (eleven or more steps, several roles, external
integration or branching).

```
UJ-001 User Login and Task Creation (critical, moderate, persona: Task Manager)
Steps: open login page, enter credentials, submit, land on dashboard, click "Create Task",
  fill the form, submit, see the success confirmation
Covers: US-3.1, US-1.1; AC-3.1.1, AC-3.1.2, AC-1.1.1, AC-1.1.2
Expected outcome: the user is signed in and the task exists
```

## 3. Map the integration points to the journeys

From the system design, list the integration points each journey exercises: front end to API,
API to database, calls to external services (payment, email, identity) and cloud services, and
event-driven flows. An end-to-end test is needed where the user sees the result of the whole
chain: user interface to API to database and back, authentication through the identity service,
payment through the gateway, data written and read back, and external services such as email or
SMS. Internal service-to-service calls, query tuning, caching and background jobs are covered by
integration tests. For example, login and task creation exercises the front end through API
Gateway and a Lambda authorizer to Cognito, the front end through API Gateway and Lambda to
DynamoDB, and Lambda to CloudWatch Logs for the audit log.

## 4. Assess the change impact

- **Enhancement:** new journeys need new end-to-end tests; changed features need regression tests.
- **Bug fix:** a bug in a user-facing workflow needs an end-to-end regression test; a bug in back-end
  logic may need only an integration test.
- **Security fix:** a fix in authentication, authorization or data handling needs an end-to-end test
  that the control works.
- **Major release:** breaking changes need the full end-to-end regression suite plus tests for every
  new journey.
- **Minor release:** new journeys plus targeted regression of the critical existing ones.
- **Patch release:** the affected journeys plus smoke tests.

```
Change Impact Score = (Change Type Weight × 0.6) + (Release Type Weight × 0.4)

Change type weights: security 10, bug in a critical journey 8, enhancement of a critical
feature 7, other bug 5, other enhancement 4.
Release type weights: major 10, minor 6, patch 3.

Critical (8-10): full end-to-end regression plus new tests
High (6-7.9): targeted regression plus new tests
Medium (4-5.9): affected journeys plus smoke tests
Low (below 4): smoke tests only
```

## 5. Select the candidates

**Include:**

1. Critical user journeys: authentication and authorization, core transactions, creating and
   changing data, payment and checkout, registration and onboarding.
2. High-risk integration points: external services, the identity service, cross-system data flows.
3. Regulatory and compliance flows: audit logging, encryption, access control, data residency.
4. High business impact, as a should-have: revenue-generating, customer-facing and frequently used
   workflows.

**Exclude**, because a cheaper test covers them:

1. Single-step create, read, update or delete with no business logic or external dependency:
   integration tests.
2. Internal service calls, database queries, caching: integration tests.
3. User-interface-only behavior with no API call, such as client-side form validation or local
   state: component tests.
4. Scheduled jobs, batch and asynchronous processing without a user-visible outcome: integration
   tests.

For each candidate record an identifier (`E2E-001`), the journey or integration point, the test
objective, why it needs an end-to-end test, the stories, criteria and integration points it
covers, its complexity and an effort estimate in hours.

## 6. Prioritise

```
Priority Score = (Business Impact × 0.4) + (Technical Risk × 0.3) + (Change Type Weight × 0.3)

Business impact: critical journey (authentication, payment, core transaction) 10; high-value
feature (revenue-generating, customer-facing) 7; standard feature 4; edge case or rarely used 1.
Technical risk: security (authentication, authorization, encryption) 10; data integrity (create,
update, delete) 8; external service integration 6; user-interface-only 3.
Change type weight: security fix 10; bug fix in a critical journey 7; enhancement of a critical
feature 5; other enhancement 2.

P0 (Critical): 8.0-10.0, must be implemented before release
P1 (High): 6.0-7.9, should be implemented before release
P2 (Medium): 4.0-5.9, implemented if time permits
P3 (Low): below 4.0, deferred to a later release
```

Example: login and task creation has business impact 10, technical risk 10 (authentication and
persistence) and change type weight 5 (enhancement): 4.0 + 3.0 + 1.5 = 8.5, so P0.

## 7. Plan the execution

**Order.** P0 first, authentication and authorization before the core transactions, so a broken
system fails fast; then P1, the high-value features and external integrations; then P2.

**Approach.** Run tests **sequentially** when they depend on each other (registration, then login,
then an action): predictable and easy to debug, but slow. Run them in **parallel** when they are
independent with isolated data: fast, but only as reliable as the data isolation. Use a
**hybrid** when both kinds exist, for example authentication sequentially and then the features in
parallel. As a default: fewer than 10 tests sequential, 10 to 30 hybrid, more than 30 parallel in
groups.

**When to run.**

| Moment                        | Tests          | Time budget   |
| ----------------------------- | -------------- | ------------- |
| Before merge (code review)    | P0 smoke tests | < 5 minutes   |
| After merge (pipeline)        | P0 and P1      | 15-30 minutes |
| Before deployment (staging)   | P0, P1 and P2  | 30-60 minutes |
| After deployment (production) | P0 smoke tests | < 5 minutes   |
| Nightly or weekly             | Full suite     | 1-2 hours     |

## 8. Plan the test data and the environments

**Test data.** **Static** data seeded before the run (user accounts, a product catalog) is fast
and predictable but goes stale and collides between parallel tests; use it for read-heavy tests.
**Dynamic** data created by each test is isolated but slower and needs cleanup; use it for
write-heavy tests. A **hybrid** uses static data for reads and dynamic data for writes.

- Create test data through the API, not by writing to the database directly, using factories or
  builders for consistency.
- Give every run and every test unique identifiers (a run identifier, a timestamp or a UUID), so
  runs do not collide.
- Clean up after each test in the framework's hooks (`afterEach`, `afterAll`), so data does not
  accumulate; consider soft deletes where an audit trail matters.
- Keep a separate test database per environment, and never share data between tests.
- Never put a real password into the strategy; show credentials as placeholders.

**Environments.**

- **Dedicated end-to-end environment:** stable and free of interference, at extra cost and
  maintenance; suits a large suite run often, and serverless systems, where it is cheap.
- **Shared staging:** cheaper and production-like, but manual testing can interfere; suits a small
  suite run rarely, and traditional server-based systems.
- **Ephemeral environment per run:** complete isolation and a clean state, at the cost of setup time
  and money; suits containerized and microservice systems.

Name what the environment needs: a test database separate from production, test accounts with the
right roles, test modes or mocks of external services such as payment and email, feature flags,
and logging and tracing to diagnose failures.

## 9. Control flakiness

A flaky test is one that passes and fails on the same code. The usual causes are shared state,
timing and the network. Plan these controls:

- Isolate the data as section 8 says, so parallel tests never touch each other's records, and
  make no test depend on another's leftovers or on execution order unless the plan runs them
  sequentially on purpose.
- Wait for a condition (an element, a response, a URL), never for a fixed time.
- Use test modes or mocks for external services the journey does not need to exercise for real.
- Define a retry strategy for network-dependent tests, and report a test that passes only on retry
  as flaky rather than as passing.
- Use stable selectors; the `playwright-test-implementation` skill gives the selector order for
  Playwright.
- Set targets and watch them: a pass rate above 95%, flakiness below 5%, the P0 and P1 run under 30
  minutes, and test maintenance below 10% of development time.

## 10. Recommend a framework

Recommend a framework from the architecture and the team's existing tests, and say why:
Playwright for web front ends (fast, several browsers, good debugging), with the
`playwright-test-implementation` skill for writing the specs; Cypress where the project already
uses it; an API test tool such as Postman with Newman, REST Assured or Supertest for API-only
journeys, matched to the project's language; and for serverless systems, tests against the real
deployed endpoints, with a local emulation such as LocalStack only for development. A project
that already has an end-to-end framework keeps it unless the strategy gives a reason to change.

## The report

```markdown
# End-to-end test strategy: <application or feature>

**Date:** <date> | **Change type:** <type> | **Release type:** <type>

## Summary

Candidates: <N> | P0: <N> (<h> h) | P1: <N> (<h> h) | P2: <N> (<h> h) | P3: <N> (<h> h)
Total effort: <h> hours
Change impact: <score>, <level>, because <reason>
Execution: <sequential, parallel or hybrid> | Test data: <static, dynamic or hybrid>
Environment: <dedicated, shared or ephemeral> | Framework: <framework>

## Testing model alignment

Architecture <type>, model <model>: end-to-end share expected <X>%, current <Y>%, <aligned or
misaligned>, with a sentence on why.

## Prioritization matrix

| Priority | Test ID | Journey | Business impact | Technical risk | Change weight | Score | Effort | Stories |
| -------- | ------- | ------- | --------------- | -------------- | ------------- | ----- | ------ | ------- |

## Journeys

### UJ-001: <name> (P0, E2E-001)

Steps, stories and acceptance criteria covered, integration points exercised, complexity, effort,
and how the test approaches the journey.

## Integration points

| Integration point | Source | Target | Protocol | End-to-end test | Status |
| ----------------- | ------ | ------ | -------- | --------------- | ------ |

Totals: covered by end-to-end tests, covered by integration tests, gaps.

## Execution

Order by priority with time estimates, the approach and its reason, and when each set runs.

## Test data and environment

The data approach and its reason; creation, cleanup and isolation; an example record per entity,
with unique-identifier placeholders and no real credentials. The environment type, its reason and
the components it needs.

## Flakiness controls and framework

The controls from section 9 that apply, with the targets; the framework and its reason.

## Implementation order and risks

P0 tests first, then P1, then P2, each with its effort, plus the environment and pipeline work
they need. What goes untested if the P0, P1 or P2 tests are not written, and the mitigation: P0
before release, extra manual testing or monitoring for what stays open, P2 and P3 deferred.

## Test specifications

For each P0 and P1 test: objective, prerequisites, steps with the expected result of each,
assertions, test data, cleanup, complexity, effort, and dependencies on other tests. Mark every
test that submits a form whose validation trigger is unknown.

## Test counting

Test files and test cases counted, cases per file, and the runner command used.

## Quality check findings

The findings of the checks below that are still open.
```

When the step asks for the strategy as a section of another report, such as the test coverage
report, write the same content under one heading there: at least the prioritization matrix, the
execution approach and the P0 and P1 specifications.

At the end, tell the owner where the strategy is, the number of P0 and P1 tests with their effort,
and the recommended execution approach.

## Quality checks

**CRITICAL (must fix):**

- No P0 tests defined for the critical user journeys.
- No execution approach (sequential, parallel or hybrid) documented.
- The test environment requirements not specified.

**IMPORTANT (should fix):**

- No test data strategy: how data is seeded and cleaned up.
- No plan for running the tests in the pipeline.
- The framework choice not justified against the team's experience.

**SUGGESTION:**

- Visual regression tests for flows heavy on user interface.
- A retry strategy for network-dependent tests.

List the findings in the order CRITICAL, IMPORTANT, SUGGESTION in the strategy's Quality check
findings section. Ask the owner whether to fix them, unless the step or its inputs already say;
when the owner authorized the planning in advance, list them and leave the fixing to them,
without asking.
