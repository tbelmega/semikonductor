# Reviewing a Smithy API model

How to review a Smithy model before it goes to implementation: structure, naming, documentation,
type safety, operation design, error handling, pagination, security, code generation readiness,
performance and file organization, with a breaking change analysis when an existing model
changed. `guide.md` next to this file says how the model is designed, and `smithy-reference.md`
holds its patterns and an example review.

Review the model the step names; when the step writes several files, the Smithy model files and
`smithy-build.json` are what you review. Present every finding before any fix. Point to the exact
location, say why the issue matters, and give a concrete fix with example code. Consider the
project's constraints and requirements, and name what is done well.

## Classes and priorities

Classify each finding as CRITICAL (must fix), IMPORTANT (should fix) or SUGGESTION (consider). In
an agent gate, write the findings to the findings file that follows the review findings schema,
with the class at the start of each title and this priority:

| Class      | Priority |
| ---------- | -------- |
| CRITICAL   | P0       |
| IMPORTANT  | P1       |
| SUGGESTION | P3       |

Always CRITICAL:

- An operation that requires authentication has no `@auth` trait.
- Sensitive data, such as personal data or credentials, is not marked `@sensitive`.
- A breaking change to an existing operation.
- Invalid Smithy syntax that blocks code generation.

Always at least IMPORTANT:

- Naming conventions are inconsistent across shapes.
- Errors are not documented.
- A list operation has no pagination.

Typical SUGGESTIONS are deprecation notices for planned removals and stronger input validation
constraints.

## Process

1. **Validate.** Run `smithy validate` on the model directory, such as `smithy validate model/`.
   An ERROR is a must fix, a WARNING a should fix, and a NOTE a suggestion to consider.
2. **Review the structure.** Check the service definition is complete, and look at how the
   operations are organized, the shape hierarchy and relationships, and the namespace.
3. **Check the categories below.**
4. **Test code generation.** Generate code for the target languages, check it compiles, check the
   type safety of the generated code, and test serialization and deserialization.
5. **Analyze breaking changes**, when the review covers changes to an existing model:

   ```bash
   smithy diff --old previous-model/ --new current-model/
   ```

   Record the breaking changes that need a version bump, the backward-compatible additions, and
   the deprecations that need a migration path.

## Categories

### 1. Structure

Check for valid Smithy syntax, `$version: "2"`, a correct namespace declaration, shape definitions
and references that resolve, and valid trait use. Flag a missing or incorrect namespace, undefined
shape references, invalid trait syntax and mismatched input or output types.

### 2. Naming

Services, operations and shapes use PascalCase, operations with a verb prefix; members use
camelCase. Flag snake_case (`database_id`), generic names (`GenericRequest`, `Data`, `Info`),
unclear abbreviations (`usr`, `tmp`, `cfg`) and inconsistent patterns.

### 3. Documentation

Every public shape is documented, explaining its purpose and usage, its constraints and
validation rules, its business logic and edge cases, and the units of numeric values, with
examples where they help. Flag missing documentation, vague descriptions, undocumented
constraints and missing units.

### 4. Type safety and constraints

Check that shape types fit (not everything is a String), mandatory fields are `@required`, numbers
have `@range`, strings and collections have `@length`, formats have `@pattern`, passwords, tokens
and personal data are `@sensitive`, and fixed value sets are enums. Flag each gap, and overly
generic types such as `Document` everywhere.

### 5. Operation design

Operations are focused and single-purpose, with clear input and output structures and every error
case covered. HTTP traits (`@http`, `@readonly`, `@idempotent`) are applied, the HTTP method
matches the effect, and URI patterns follow REST conventions. Flag operations that do several
things, missing HTTP traits, inconsistent URI patterns, GET for a mutation and incomplete error
definitions.

### 6. Error handling

Errors are specific, not a `GenericError`: `@error("client")` for 4xx and `@error("server")` for
5xx, `@httpError` with the right status code, and context fields that help the caller. Every
failure scenario is covered. Flag vague error types, operations without error definitions, wrong
status codes, missing context fields and inconsistent handling across operations.

### 7. Pagination

List operations carry `@paginated` with `inputToken`, `outputToken` and `pageSize`, with a
reasonable default and maximum page size and properly defined pagination structures. Flag list
operations without pagination, missing tokens, unreasonable page size limits and inconsistent
patterns.

### 8. Security

Sensitive data is `@sensitive`, authentication traits are applied, authorization patterns are
documented, input validation prevents injection, and rate limiting is considered. Flag unmarked
sensitive data, missing authentication requirements, insufficient input validation, error
structures that leak information, and undocumented security implications.

### 9. Code generation readiness

The model validates without errors, works with the target generators, generates code that
compiles and serializes correctly, and carries version information. Flag validation errors or
warnings, generator incompatibilities, and breaking changes without a version.

### 10. Performance and scalability

Look for efficient data structures and collection types, pagination for large result sets,
streaming for large payloads, and caching through traits. Flag unbounded result sets, inefficient
structures, missing streaming for large data and a lack of caching considerations.

### 11. File organization

A single file fits a small model, with fewer than 10 operations and under 500 lines; a larger
model is split into files with a clear organization, related shapes grouped, shared types
separated for reuse, and `smithy-build.json` pointing at the right source directories. Flag a
single file over 500 lines, files with only one or two shapes, unrelated concerns mixed in one
file, inconsistent file names, duplicate shape definitions, different namespaces within one
model, circular dependencies between files, and no clear separation between domains. For a model
with 10 or more operations or several domains, recommend one of the layouts in
`smithy-reference.md`.

Also flag these code smells wherever they appear: repeated shape definitions that should be
reusable, deeply nested structures, unused shapes or operations, and exposed implementation
details.

## The report

Without a gate, report in this order: critical issues, warnings (the IMPORTANT findings),
suggestions, then positive findings. `smithy-reference.md` ends with an example review.

```text
[Category] [Location]
Issue: [Description]
Impact: [Why this matters]
Fix: [Specific recommendation]
Example: [Code showing the fix]
```

For a warning, give a recommendation instead of a fix; for a suggestion, the observation, its
benefit and an alternative approach. A positive finding names the category and the good practice.
In an agent gate, the finding's `evidence` holds the issue as you saw it and the suggested fix,
its `impact` says why it matters, and the positive findings go in the summary.

## Passing

The model passes when it has no CRITICAL finding, every IMPORTANT finding is fixed or recorded as
accepted, it validates without errors, it generates working code, and it follows the practices
above consistently. Before approving, confirm:

- [ ] `smithy validate` passes without errors.
- [ ] Every public shape is documented.
- [ ] Every operation defines its errors.
- [ ] Constraints are applied: `@required`, `@range`, `@length`, `@pattern`.
- [ ] Sensitive data is marked `@sensitive`.
- [ ] List operations support pagination.
- [ ] Naming conventions are followed consistently.
- [ ] The generated code compiles.
- [ ] There are no breaking changes, or they are properly versioned.
- [ ] Security considerations are addressed.
- [ ] The file organization fits the model's size, with related shapes grouped.
- [ ] Performance implications are considered.
