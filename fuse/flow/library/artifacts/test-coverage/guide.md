# Analyzing test coverage

Compare what was implemented against its tests and find the missing test scenarios: acceptance
criteria, non-functional requirements and integration points without a test that would fail
without them. Close the gaps the step asks you to close, and record the rest with a reason each.

## Inputs

Use the paths the step or its consumed artifacts give you; search only for what they do not name.

- The acceptance criteria, from the user stories or the spec.
- The non-functional requirements and the system design, for quality attributes and integration
  points.
- The test plan or test strategy, when there is one.
- The source and test directories.

## 1. Choose the test levels

When the house rules set a testing model or test levels for the project, judge the tests against
them. Otherwise use the test levels of the `testing-strategy` skill
(`skills/testing-strategy/SKILL.md` in the fuse-konductor clone): type check, unit, component,
external-system and end-to-end, each defined by what runs for real. Good coverage does not mean a
share of tests per level: it means each behavior is shown by a test at the lowest level that can
show it, and no test replaces the project's own code with a test double.

## 2. Count and classify the tests

Take the counts from the test runner: from the output of an existing run of the revision under
review when there is one, otherwise from a command that lists the tests without running them,
such as `pytest --collect-only` or `playwright test --list`. Test files are not test cases: a file
often holds ten to fifty tests, and counting files instead of cases misstates the distribution by
an order of magnitude.

To see which tests pass, you may run the local unit and component tests. Run tests that call a
deployed system, such as a deployed app, a cloud account or live endpoints, only with the owner's
authorization for that target: such a run can create records, send messages or start workflows.
A calling workflow says whether it has that authorization; used on its own, ask the owner. Record
every test that did not run as not run, never as passing.

Classify each test by the level it runs at, and check it against the lowest level that can show
its behavior:

- **At the lowest level:** no lower level could show the behavior.
- **Too high:** a lower level could show the same behavior, such as an end-to-end test of a rule
  that a unit test of a pure function would show.
- **Test double of own code:** the test replaces part of the project's own code with a mock,
  stub, spy or fake. It shows that the replaced code was called, not that the behavior works.

A contract test, which checks one service's API or message schema against what its consumers
expect, counts at the level it runs at.

## 3. Map tests to acceptance criteria and test plans

For each acceptance criterion, find the tests that cover it: an explicit reference in the test
(`// Tests: AC-1.1.1`), a test name that matches the criterion, a test file that matches the feature,
or assertions that check the expected behavior. When there is a test plan or strategy, map each
planned test to the test that implements it in the same way; a planned scenario counts on its own,
even when a simpler test already covers its criterion. Mark each criterion and planned test:

- ✅ **Covered:** an automated test exists and passes.
- ⚠️ **Partial:** a test exists but is incomplete or failing.
- ❌ **Missing:** no automated test.
- 🔍 **Manual:** needs manual testing, such as complex interactions or third-party services.

When the test for an item exists but did not run, mark the item by what the test asserts and add
"not run".

## 4. Map tests to non-functional requirements

Each non-functional requirement needs a test of the matching kind:

| Category        | Test kind                                                         |
| --------------- | ----------------------------------------------------------------- |
| Performance     | Latency, load and profiling tests                                 |
| Security        | Encryption, authentication, authorization and audit logging tests |
| Reliability     | Failure injection, retry, recovery and error scenario tests       |
| Scalability     | Concurrency, scaling and stress tests                             |
| Usability       | Interaction, accessibility and error display tests                |
| Maintainability | Log format and metrics emission tests                             |
| Compliance      | Data residency and regulatory validation tests                    |

A requirement tested only with the wrong kind, such as a unit test for a latency target, is not
covered; classify it as **wrong kind**, not as missing.

## 5. Check the integration points

List every integration point in the system design: source, target, mechanism, synchronous or
asynchronous, and how critical it is. Include the implicit ones, such as logging, metrics, tracing
and authentication. Each integration point needs tests that cover its failure path as well as
its success path: a component test with the other system faked shows this project's side, and an
external-system test shows the integration itself. Mark an integration point **mocked** when its
only tests replace the real service with a mock: such a test checks the component's side of the
boundary, not the integration itself.

In a system of several services, also map each inter-service API and each message or event schema
to the contract tests that cover it.

## 6. Classify the gaps

**Critical (must fix):**

- An acceptance criterion with no test, or a core user journey without a happy-path test.
- A planned test with no implementation.
- Core functionality untested: authentication, data persistence, critical workflows.
- A security requirement or a security-sensitive operation without tests.
- A non-functional requirement with no test at all.
- A critical integration point without a test.
- In a system of several services, an inter-service API or message schema without a contract test.
- Error handling paths or error scenarios without negative tests.

**Warning (should fix):**

- An acceptance criterion with partial coverage, or a planned test only partly implemented.
- Edge cases and boundary conditions untested.
- Tests of an integration point that cover only the success path, integration points that are
  only mocked, or secondary integrations, such as logging, monitoring or asynchronous messaging,
  without tests.
- A non-functional requirement tested only with the wrong kind of test, or an operation with a
  service-level target and no performance test.

**Manual testing required:** complex interactions such as drag-and-drop, third-party services
such as payment providers, browser compatibility, assistive technology, and user experience.

Also note low-value tests and test anti-patterns where they distort the picture: tests that
replace the project's own code with a test double, tests above the level they need, tests of
implementation details, flaky tests that depend on timing, tests that depend on execution order
or share state, setup without matching cleanup, tests without assertions or with assertions too
vague to fail, commented-out tests, and tests of the wrong type for their scenario.

For each gap record the feature, the criterion or requirement, the file and function or component,
the current test status, the recommended test type and why, its category (positive flow, negative
case, error scenario, edge case, non-functional, integration) and the priority.

## Report

```markdown
# Test coverage: <feature or project>

## Summary

**Test levels:** <the house rules' model, or the testing-strategy levels>
**Acceptance criteria covered:** <M>/<N>
**Critical gaps:** <N> | **Warnings:** <N> | **Manual tests:** <N>

| Level           | Tests | Too high | Test double of own code |
| --------------- | ----- | -------- | ----------------------- |
| Unit            | <N>   | <N>      | <N>                     |
| Component       | <N>   | <N>      | <N>                     |
| External-system | <N>   | <N>      | <N>                     |
| End-to-end      | <N>   | <N>      | <N>                     |

Tests run: <N> passed, <N> failed, <N> not run, with the reason the rest did not run.

## Coverage by feature

### <Feature>

- ✅ AC-1.1.1: <criterion>. Tests: `test/unit/auth.test.ts::should authenticate user`
- ❌ AC-1.1.2: <criterion>. Impact: <who is hurt>. Recommended: <test type and what it asserts>
- 🔍 AC-1.1.3: <criterion>. Reason: <why manual>. Procedure: <numbered steps and expected outcomes>
- ⚠️ TP-2: <planned test>. Implemented by: <test>, missing: <scenario>

## Non-functional requirements and integration points

| Item    | Requirement or integration | Test kind needed | Status            |
| ------- | -------------------------- | ---------------- | ----------------- |
| NFR-P1  | <requirement>              | Load test        | ❌ or wrong kind  |
| INT-001 | <source> → <target>        | External-system  | ⚠️ mocked         |

## Gaps

### Critical

1. <feature>: <gap>. Impact: <impact>. Closed by: <test added, with its path>, or open: <reason>

### Warnings

1. <feature>: <gap>. Closed by: <test>, or open: <reason>

## Remaining gaps

Every gap still open, with the reason it stays open and who decides.
```

## Further sections

A step can ask for more sections in the same report. Each has its own guide next to this one, in
the same folder:

- **Security tests:** follow `security-tests.md`. Count its critical gaps among this report's
  critical gaps.
- **User-facing text:** follow `ui-text.md`.

Add each section before Remaining gaps, under a heading of its own, and list its open gaps under
Remaining gaps too.
