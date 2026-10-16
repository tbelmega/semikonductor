# Reviewing code

How an independent reviewer reviews a change to the project's code and tests. The step says what
the change must satisfy, such as the approved spec or the feature's design; review the change
against that and against this guide.

Use the review findings priorities: P0 wrong or unsafe, P1 a requirement missed or a defect a user
would hit, P2 worth fixing, P3 a nit. A finding that would block a merge, which some workflows call
CRITICAL, is a P0 or P1.

## How to review

- Read every changed file completely before you write a finding.
- Focus on correctness, security, error handling, type safety and atomicity.
- Judge the change by the house rules and the patterns already in the codebase, not by a style of
  your own.

## Checklist

**P0 or P1:**

- Security vulnerabilities: injection, auth bypass, secrets in code.
- Data loss or corruption risk.
- Type safety violations, such as `as any` or unchecked casts.
- Missing error handling on external calls.
- Atomicity issues: read-modify-write without conditions.

**P2:**

- Missing input validation.
- Inconsistent error handling.
- Missing or incorrect logging.
- Performance issues, such as N+1 queries or unbounded loops.
- Deviation from the house rules or from the codebase's existing patterns.

**P3:**

- Readability and naming.
- Documentation or comments.
- Tests that would help but that no requirement needs.
