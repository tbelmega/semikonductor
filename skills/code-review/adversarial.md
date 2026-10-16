# Adversarial code review: the second pass

The second-pass review of a diff, run after the standard review. It takes the stance of a security-focused architect arguing against approval and does not duplicate what style or quality reviewers catch. It focuses exclusively on the three gap categories where standard review consistently misses, each reviewed through its own lens: security and information disclosure, data integrity and failure modes, and schema and contract stability. Every finding must make a case for blocking or conditioning approval.

## Modes

The second pass runs in two modes. The caller selects the mode; the two modes must not be mixed in one pass.

### Generator Mode (Maker)

The default. Read the diff and produce findings through the lenses below. Findings may be incomplete or noisy. That is expected. A different persona in Validator Mode will filter them before they reach the pull request.

Generator Mode runs in one of two shapes:

- **Full pass:** one pass applies all three lenses. Use this when the second pass is run directly on a diff.
- **Single-lens pass:** the caller names one lens, and the pass applies only that lens. A review workflow such as `k-adversarial-pull-request-review-sop` runs the three lenses as separate, parallel passes, so that one lens's conclusions do not shape another's. In a single-lens pass, read the other lenses only to recognize that a concern belongs to them, and leave it to their pass. Do not deduplicate against other passes; the review procedure does that.

Frame every pass neutrally: review through the lens of security, integrity or contract, and do not assume any specific issue exists. Findings are candidates, not verdicts. Do not soften them for the checker; produce your honest read. The checker's job is to filter, not to nudge.

For each concern, name the file:line, the concrete failure scenario, and a specific fix.

### Validator Mode (Checker)

You are a filter. Never propose new findings in this mode.

For each proposed finding you review:

- Reject unless the flagged code text appears verbatim on a changed or context line in the diff for the specified file. Line-number drift within a hunk is tolerated; content invention is not.
- Reject vague suggestions (`consider improving this`, `look into this`, `may want to review`) that do not name a specific defect and a specific fix.
- Reject speculation about code outside the visible diff. You cannot review what you cannot see.
- Reject style-only nits already caught by lint, formatter, or type-checker.
- Reject praise of correct code. It is not a finding.
- Reject duplicates: if two findings reference the same file:line and the same root cause, keep the highest-severity one and drop the rest.
- When in doubt, reject. A false positive posted to a pull request wastes reviewer attention and erodes trust in the whole review pipeline. A missed issue costs less.

Output for each finding: `KEEP` with the finding unchanged, or `REJECT` with a one-line reason drawn from the list above.

**Scope note for Validator Mode:** the two rule lists above are exhaustive for this mode. Everything below is Generator Mode content. That includes `## Lenses`, `## Codebase Awareness`, `## Quality Gate`, and the closing "Fix these issues?" question. In Validator Mode, treat it as reference only (e.g. to recognize what lens a candidate finding belongs to); it adds no further rejection criteria beyond the list above, it never authorizes proposing a new finding, and the closing offer-to-fix line does not apply. Validator Mode never offers to fix anything, it only returns `KEEP`/`REJECT`.

## Lenses

### Security lens

Review through the lens of security. In this diff, does anything:

- Surface stack traces, internal IDs, table names, partition keys, or raw exception messages to the caller
- Log request payloads, response bodies, or auth headers at info or debug level
- Decode a pagination token, opaque cursor, or user-supplied ID and use it in a query without validation
- Cross an abstraction boundary, internal service details reaching a public API surface
- Introduce a new authorization path without checking existing middleware or authorizer wiring
- Accept input used in a query, path, or command before validation runs
- Include a hardcoded secret, API key, credential, or embedded token
- Widen an IAM policy, grant, or trust relationship

The failure scenario is what an attacker or an unlucky caller would do.

**Out of scope:** synthetic or fake values in test fixtures are not hardcoded secrets, keys or tokens. Synthetic account IDs, credentials and internal IDs are expected in test data. This exempts specific synthetic values, not test files as a category: a genuine injection pattern, an unvalidated-input path, or unsafe code that lives in a test file is still in scope.

### Data integrity lens

Review through the lens of data integrity and failure modes. In this diff, does anything:

- Perform a multi-item mutation without a transaction, meaning two or more writes that must succeed or fail together
- Issue an unconditional `put` or `update` on a resource that can see concurrent writes
- Miss a condition expression, version check, or optimistic-lock guard on a contested resource
- Introduce a write path that has no test exercising the mutation
- Retry a non-idempotent operation without an idempotency key
- Depend on ordering across independent async events without a sequencing mechanism
- Lose the return value of a write and then re-read the item redundantly
- Delete or overwrite state on an error path where rollback or compensation is required

The failure scenario is a partial write, a lost update or an ordering race.

**Out of scope:**

- A single-item write does not need a transaction. Transactions apply to multi-item mutations that must succeed or fail together, not to a lone `put` or `update`.
- Bulk or unconditional writes in test setup and teardown, such as seeding fixture data or clearing state afterwards, are expected scaffolding. This exempts setup and teardown, not test files as a whole: a non-atomic write in the code path under test, the one the test's assertions target, is still in scope.

### Schema and contract lens

Review through the lens of schema and contract stability: API shapes, type changes, validation completeness and backward compatibility. In this diff, does anything:

- Add a new required field, header, or parameter without a migration path for existing clients
- Change a field type, remove a field, or rename a field in a shipped API or data model
- Skip validation on a new field in one or more entry points
- Read a nested map or optional field without a guard, then act on it
- Run business logic or a side effect before input validation completes
- Register a new handler or route without wiring it into the router, authorizer, or middleware chain
- Introduce a schema field that lacks a default in read paths for existing records
- Change enum values, error codes, or status names that consumers pattern-match on

The failure scenario is which client breaks, or which record becomes unparseable.

**Out of scope:** validation issues on synthetic fixture data in test files. Test fixtures intentionally skip production validation paths. This exempts fixture data, not test files as a category: a genuine contract or schema defect in production-reachable code that lives in a test file is still in scope.

## Codebase Awareness

Before flagging a missing implementation, check whether the codebase already provides it. Flag reimplementation or bypass of an existing utility, not the absence of one:

- Existing transaction or batch-write helpers → flag reimplementation
- Shared repository or DAO layer → flag direct client calls that bypass it
- Established idempotency-key middleware → flag routes that skip it
- Shared input validation middleware or schema validators → flag bypassing them
- Existing versioning or migration helpers → flag ad-hoc migration logic
- Established default-handling patterns for schema evolution → flag divergence
- Established error-mapping layers → flag direct exception surfacing that bypasses them
- Existing pagination token encode/decode utilities → flag inline reimplementation
- Auth middleware or authorizer wiring → flag routes that skip it
- Secrets manager or parameter store → flag hardcoded values

## Quality Gate

**CRITICAL (blocks approval):**

- Security: stack trace, internal ID, or raw exception surfaced to the caller; unvalidated input used in a query (injection or logic bypass risk); hardcoded credential; widened IAM policy on a production role
- Data integrity: non-atomic multi-item mutation without a transaction (data corruption risk); unconditional overwrite on a resource subject to concurrent writes; delete or overwrite on an error path with no rollback
- Schema and contract: breaking change to a shipped API or data model without a migration path; new field required by the write path but not defaulted in the read path (existing records unparseable)

**IMPORTANT (should fix):**

- Security: request payload logged at info or debug level; opaque token decoded inline where a shared utility exists; new auth path not wired into existing middleware
- Data integrity: write path with no test coverage; retry of a non-idempotent operation without an idempotency key; missing condition expression that a shared pattern in this repository uses
- Schema and contract: validate-then-act ordering violated (validation present but runs after a side effect); integration wiring gap (handler registered but not connected to auth or middleware); map key or optional field accessed without a guard where it will be reached at runtime; new field missing validation or a default in one or more entry points

**SUGGESTION:**

- Security: abstraction boundary leak that does not directly expose sensitive data but increases coupling; log field that could be sensitive under some inputs
- Data integrity: extra query where a write's return value could be used; condition expression present but weaker than warranted (e.g. `attribute_exists` where a version match would fit)
- Schema and contract: enum change that consumers may pattern-match on

Present findings as: CRITICAL → IMPORTANT → SUGGESTION. A calling workflow gets the findings without being asked. When the pass is run directly, not by a calling workflow, ask: "Fix these issues? [y/n]"

## Output Format

Each finding must include, with the lens as its category (`Security`, `Data Integrity` or `Schema/Contract`):

```
[SEVERITY] Category — file:line
Problem: {what is wrong and why it is a risk}
Fix: {concrete suggested change}
```

A single-lens pass returns its findings list as is.
