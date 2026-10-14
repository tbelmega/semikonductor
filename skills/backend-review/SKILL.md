---
name: backend-review
description: 'Use when implementing, fixing or reviewing backend code (Lambda handlers, service layers, DynamoDB operations). Implement mode makes minimal, surgical changes following KISS, YAGNI and DRY: code quality fixes, new features, performance work. Review mode checks changes before code review for architectural pattern compliance, type safety, DynamoDB correctness and test quality, with CRITICAL, IMPORTANT and SUGGESTION findings. For frontend code, use frontend-review.'
version: 1.1.0
tags: [skill, backend, code-review, lambda, dynamodb, typescript, nodejs, implementation, checker]
---

# Backend Development and Review

## Overview

One set of backend standards, used in two modes:

- **Implement mode:** make a backend change with surgical precision, only the specific issue, nothing more. Covers Lambda handler patterns, service layer architecture, DynamoDB operations, type safety, error handling, and test improvements.
- **Review mode:** review backend code with a critical eye against the same standards. Provide a direct, unbiased assessment, and call out over-engineering, KISS/YAGNI/DRY violations, and unnecessary complexity.

When you implement a change, review it afterwards in review mode, preferably in a separate pass that did not write the code.

## Usage

Use implement mode when:

- Fixing code quality issues from code review feedback
- Implementing new Lambda handlers or service methods
- Optimizing DynamoDB operations (atomicity, efficiency)
- Improving type safety (removing `any`, adding null checks)
- Adding or improving test coverage

Use review mode when:

- Reviewing backend changes before submitting a code review
- Validating that a fix follows established architectural patterns
- Checking DynamoDB operations for atomicity and efficiency
- Assessing test coverage and quality

## Core Concepts

### Architectural Layers

Handlers (entry point, delegates to facade) → Business Facade (orchestrates service calls) → Services (created via factory, contain business logic) → Repositories (data access through interfaces). No layer should bypass the one below it.

### KISS/YAGNI/DRY

Prefer simple, minimal solutions. Only add abstractions that solve a real, existing problem, not hypothetical future needs. Only introduce patterns (Strategy, Observer) when they solve a real, existing problem. Call out over-engineering directly.

## Standards

Implement mode follows these; review mode checks each one.

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

## Implement Mode

**Always read the complete file before making changes.** Make only minimal changes that fix the specific issue. Follow established patterns in the codebase. Maintain backward compatibility.

### Output Format

For each change, provide:

1. File path
2. Issue (with line numbers)
3. Exact code changes
4. How to verify the fix
5. What else might be affected

### Done Gate

**CRITICAL (must fix before done):**

- TypeScript compilation fails
- Tests fail
- Breaking change introduced without migration path
- Direct database connection bypassing repository layer
- Race condition introduced (non-atomic multi-item update)

**IMPORTANT (should fix):**

- `any` type used in production code
- Missing null check before non-null assertion
- Extra query when return value from write operation could be used
- Catch-all error handler masking specific errors
- Test data constructed inline instead of using fixture factory

**SUGGESTION:**

- Could extract repeated logic into shared utility
- Could add structured log fields for better observability
- Could strengthen test assertions to check actual values

## Review Mode

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

In either mode, present findings as: CRITICAL → IMPORTANT → SUGGESTION. Ask: "Fix these issues? [y/n]", unless `scope_confirmed` is true, in which case report all the findings and leave fixing to the caller, without asking.
