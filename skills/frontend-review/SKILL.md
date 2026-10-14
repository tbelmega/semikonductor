---
name: frontend-review
description: 'Use when implementing, fixing or reviewing React/TypeScript frontend code on the AWS Cloudscape Design System. Implement mode makes minimal changes: type safety fixes, form patterns, component extraction, new UI features, Cloudscape components only and never native HTML. Review mode checks changes before code review for Cloudscape compliance, React Hook Form patterns, TypeScript type safety and test quality, with CRITICAL, IMPORTANT and SUGGESTION findings. For backend code, use backend-review.'
version: 1.1.0
tags: [skill, frontend, code-review, react, typescript, cloudscape, forms, implementation, checker]
---

# Frontend Development and Review

## Overview

One set of frontend standards, used in two modes:

- **Implement mode:** make a frontend change with precision: only the specific issue, nothing more. Covers React Hook Form + Zod validation patterns, Cloudscape component compliance, TypeScript type safety, component extraction, and test improvements.
- **Review mode:** review frontend code with a critical eye against the same standards. Provide a direct, unbiased assessment: call out pattern violations, unnecessary complexity, and missing test coverage.

When you implement a change, review it afterwards in review mode, preferably in a separate pass that did not write the code.

## Usage

Use implement mode when:

- Fixing type safety issues (removing `any`, adding explicit types)
- Implementing or fixing form validation patterns
- Extracting reusable components
- Ensuring Cloudscape-only component usage (no native HTML)
- Adding or improving test coverage

Use review mode when:

- Reviewing frontend changes before submitting a code review
- Validating Cloudscape component compliance
- Checking React Hook Form + Zod pattern adherence
- Assessing TypeScript type safety and test coverage

## Core Concepts

### Form Architecture

React Hook Form manages form state (not `useState`). Zod handles validation (not manual checks). Sub-components access form via `useFormContext` (no prop drilling). Wizard pages wrap in `FormProvider`.

### Cloudscape-Only Rule

No native HTML elements in UI code. Use `Box` instead of `<div>`/`<span>`, `Input` instead of `<input>`, `Button` instead of `<button>`, `Link` instead of `<a>`, `SpaceBetween` instead of margin/padding.

## Standards

Implement mode follows these; review mode checks each one.

### Form Patterns

- [ ] React Hook Form used, not custom state hooks for form management
- [ ] Zod used for validation, not manual validation logic
- [ ] Form sub-components use `useFormContext`, no prop drilling
- [ ] Wizard pages wrapped in `FormProvider`
- [ ] `.refine()` used for cross-field validation, not `.transform()`
- [ ] Constraint constants used for validation messages, not hardcoded strings

### Cloudscape Compliance

- [ ] No native HTML elements (`<div>`, `<span>`, `<input>`, `<button>`, `<a>`)
- [ ] No inline styles (`style={{}}`)
- [ ] `Box` used instead of `<div>` or `<span>`
- [ ] `SpaceBetween` for spacing, not margin/padding
- [ ] `KeyValuePairs` for label-value display
- [ ] `FormField` wraps all form inputs with labels
- [ ] Fixed column counts in `ColumnLayout`, no dynamic column counts

### Type Safety

- [ ] No `any` types in production code
- [ ] Explicit types on `useForm<FormType>()` calls
- [ ] TypeScript utility types used correctly (`Pick<T, K>`, `Omit<T, K>`, `Partial<T>`)
- [ ] No redundant type assertions

### Component Quality

- [ ] No unused code or imports
- [ ] No unnecessary wrapper components
- [ ] Event handlers memoized with `useCallback`
- [ ] Defensive checks for array index access
- [ ] Imperative array building for 3+ conditional items (not ternary chains)
- [ ] Stable layouts (fixed column counts)

### Testing

- [ ] Helper functions have unit tests (100% coverage target)
- [ ] Form components have component tests (80%+ coverage target)
- [ ] Test assertions check actual values, not just existence
- [ ] Error states tested
- [ ] Edge cases covered

## Implement Mode

**Always read the complete file before making changes.** Make minimal changes: only fix the specific issue. Follow established patterns. Maintain backward compatibility.

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
- Native HTML element used instead of Cloudscape component
- Inline style used (`style={{}}`)
- Form state managed with `useState` instead of React Hook Form
- `any` type in production code

**IMPORTANT (should fix):**

- Missing explicit type on `useForm` call
- Hardcoded validation message instead of constraint constant
- Event handler not memoized with `useCallback` (causes unnecessary re-renders)
- Dynamic column count in `ColumnLayout`

**SUGGESTION:**

- Could extract repeated form field pattern into reusable RHF wrapper component
- Could strengthen test assertions to check actual error messages
- Could add missing edge case tests

## Review Mode

Check the change against every item in Standards, then classify findings with this gate.

### Quality Gate

**CRITICAL (blocks approval):**

- Native HTML element used instead of Cloudscape component
- Inline style used (`style={{}}`)
- Form state managed with `useState` instead of React Hook Form
- `any` type in production code
- Test passes only due to implementation detail coupling

**IMPORTANT (should fix):**

- Missing explicit type on `useForm` call
- Hardcoded validation message instead of constraint constant
- Event handler not memoized (causes unnecessary re-renders)
- Dynamic column count in `ColumnLayout` (causes layout shift)
- Test assertions check existence but not actual values

**SUGGESTION:**

- Could extract repeated form field pattern into reusable component
- Could add missing edge case tests
- Could strengthen error state test coverage

In either mode, present findings as: CRITICAL → IMPORTANT → SUGGESTION. Ask: "Fix these issues? [y/n]", unless `scope_confirmed` is true, in which case report all the findings and leave fixing to the caller, without asking.
