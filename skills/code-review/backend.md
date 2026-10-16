# Backend lens

The standards for TypeScript backend code: Lambda handlers, service layers and DynamoDB
operations. Review a backend change against them with a critical eye, and give a direct, unbiased
assessment that calls out over-engineering, KISS, YAGNI and DRY violations and unnecessary
complexity. The same standards apply when you write backend code.

## Core Concepts

### Architectural Layers

Handlers (entry point, delegates to facade) → Business Facade (orchestrates service calls) → Services (created via factory, contain business logic) → Repositories (data access through interfaces). No layer should bypass the one below it.

### KISS/YAGNI/DRY

Prefer simple, minimal solutions. Only add abstractions that solve a real, existing problem, not hypothetical future needs. Only introduce patterns (Strategy, Observer) when they solve a real, existing problem. Call out over-engineering directly.

## Standards

### Architectural Patterns

- [ ] Handlers delegate to a business facade: no direct business logic in handlers
- [ ] Services created via factory: no direct instantiation
- [ ] Data access through repository interfaces: no direct database calls
- [ ] Proper layer separation maintained
- [ ] Return values from store operations used to avoid extra queries

### Dead Code

- [ ] Deleted or replaced functions have no remaining callers
- [ ] No exports left unused after refactoring
- [ ] No unused imports after refactoring
- [ ] Documentation referencing deleted code is updated

### Type Safety

- [ ] No `any` types in production code (test mocks are the only exception)
- [ ] TypeScript utility types used correctly (`Partial<T>`, `Pick<T, K>`, `Omit<T, K>`)
- [ ] Null checks present before non-null assertions (`!`)
- [ ] `??` used for null/undefined checks, not `||`

### DynamoDB Operations

- [ ] Multi-item updates use transactions (atomic)
- [ ] Conditional writes used to prevent race conditions
- [ ] No extra queries: write return values used where available
- [ ] Key design follows single-table patterns (PK/SK)

### Error Handling

- [ ] Specific error types, not generic `Error`
- [ ] Specific error catching, not catch-all handlers
- [ ] Proper error propagation
- [ ] Structured logging with context and correlation IDs
- [ ] Logged diffs use structured fields showing before/after state

### Testing

- [ ] Shared fixture factories for test data, not inline objects
- [ ] Order-independent assertions (`toContainEqual`)
- [ ] New code has tests before it is marked complete
- [ ] Edge cases covered: null values, empty arrays, boundary conditions

## When writing code in this stack, follow these standards

Read the complete file before changing it. Make only the minimal change that fixes the specific
issue, follow the patterns already established in the codebase, and keep backward compatibility.
Follow every item in Standards above.

The change is not done while TypeScript compilation fails, a test fails, a breaking change has no
migration path, or the change has anything the review gate below classes CRITICAL. Fix what it
classes IMPORTANT as well. Then review the change with this lens, preferably in a separate pass
that did not write the code.

When you report the change, give for each one the file path, the issue with its line numbers, the
exact code change, how to verify the fix, and what else it might affect.

## Reviewing with this lens

Check the change against every item in Standards, then classify findings with this gate.

### Quality Gate

**CRITICAL (blocks approval):**

- Race condition risk (non-atomic multi-item update without transaction)
- Direct database connection bypassing repository layer
- Missing null check before non-null assertion that will throw at runtime
- Test passes only due to test order dependency

**IMPORTANT (should fix):**

- `any` type in production code
- Extra query when write return value could be used
- Catch-all error handler masking specific errors
- Inline test data instead of fixture factory
- Over-engineered solution for a simple problem (call this out directly)

**SUGGESTION:**

- Could add structured log fields for better observability
- Could strengthen test assertions to check actual values not just existence
- Could extract repeated logic into shared utility

Present findings as: CRITICAL → IMPORTANT → SUGGESTION. When the calling workflow has already
confirmed the scope (`scope_confirmed` is true), report all the findings and leave fixing to the
calling workflow, without asking. Otherwise ask: "Fix these issues? [y/n]"
