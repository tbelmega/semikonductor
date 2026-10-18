# Frontend lens

The standards for React and TypeScript frontend code on the AWS Cloudscape Design System. Review a
frontend change against them with a critical eye, and give a direct, unbiased assessment that calls
out pattern violations, unnecessary complexity and missing test coverage. The same standards apply
when you write frontend code.

These standards are written for a project that uses React and TypeScript with Cloudscape, React
Hook Form and Zod. Apply an item that names a library only where the project uses that library, as
its dependencies, its code or its house rules show. Where the project uses another library for the
same job, check the change against the project's own established pattern instead, and never report
that a library the project does not use is missing. The library-specific items of the Quality Gate
block approval only in a project that uses that library.

## Core Concepts

### Form Architecture

React Hook Form manages form state (not `useState`). Zod handles validation (not manual checks). Sub-components access form via `useFormContext` (no prop drilling). Wizard pages wrap in `FormProvider`.

### Cloudscape-Only Rule

No native HTML elements in UI code. Use `Box` instead of `<div>`/`<span>`, `Input` instead of `<input>`, `Button` instead of `<button>`, `Link` instead of `<a>`, `SpaceBetween` instead of margin/padding.

## Standards

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

## When writing code in this stack, follow these standards

Read the complete file before changing it. Make only the minimal change that fixes the specific
issue, follow the patterns already established in the codebase, and keep backward compatibility.
Use Cloudscape components only, never native HTML, in a project on Cloudscape, and follow every
item in Standards above that applies to the project.

The change is not done while TypeScript compilation fails, a test fails, or the change has
anything the review gate below classes CRITICAL. Fix what it classes IMPORTANT as well. Then review
the change with this lens, preferably in a separate pass that did not write the code.

When you report the change, give for each one the file path, the issue with its line numbers, the
exact code change, how to verify the fix, and what else it might affect.

## Reviewing with this lens

Check the change against every item in Standards, then classify findings with this gate.

### Quality Gate

**CRITICAL (blocks approval):**

- Native HTML element used instead of Cloudscape component, in a project on Cloudscape
- Inline style used (`style={{}}`), in a project on Cloudscape
- Form state managed with `useState` instead of React Hook Form, in a project on React Hook Form
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

Present findings as: CRITICAL → IMPORTANT → SUGGESTION. When the calling workflow has already
confirmed the scope (`scope_confirmed` is true), report all the findings and leave fixing to the
calling workflow, without asking. Otherwise ask: "Fix these issues? [y/n]"
