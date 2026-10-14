# Splitting a design into features

Split the user stories and the system design into independent features, each scoped so that one
engineer can build it with little overlap or coordination with the others. One design fans out into
several feature tracks, and each track then gets its own spec.

Produce this format, not a layer-by-layer technical breakdown (data model, then backend, then API,
then frontend), even when the request only says "break down", "split" or "decompose" the work.

## Splitting criteria

Each feature should:

1. **Be independently implementable:** one engineer can complete it without blocking on others.
2. **Have clear boundaries:** well-defined inputs, outputs and interfaces.
3. **Map to user stories:** traceable back to one or more user stories.
4. **Be testable in isolation:** it can be verified without other features being complete.
5. **Minimize shared state:** avoid features that read or write the same data concurrently.

## Format

```markdown
# Feature Split: [Project Name]

## Feature 1: [Feature Name]

- **Slug**: [unique kebab-case slug]
- **Scope**: [What this feature covers]
- **User Stories**: [US-1, US-3, US-7]
- **Key Components**: [API endpoints, data models, services involved]
- **Dependencies**: [External dependencies or shared interfaces]
- **Engineer**: [Assigned or TBD]

## Feature 2: [Feature Name]

...

## Shared Interfaces

- [Interface 1]: Used by Feature 1 and Feature 2. Define it first.
- [Interface 2]: Used by Feature 2 and Feature 3. Define it first.
```

## Procedure

1. Read the user stories and the system design.
2. Find natural feature boundaries: by domain, by API surface, or by data ownership.
3. Check for overlap. If two features touch the same data model or API, merge them or define a
   shared interface.
4. Write the split with each feature's slug, scope, user story mapping and dependencies.
5. Check it against the criteria below and fix what you find before handing it over.

## Self-check

**Must fix:**

- Features have circular dependencies.
- A feature requires another feature to be complete before it can start (tight coupling).
- A user story is missing from the split; every story maps to a feature.

**Should fix:**

- More than two features share the same data model; consider a shared-interfaces feature.
- A feature is too large: more than two weeks of work for one engineer.
- A feature is too small: less than two days of work; consider merging it.

**Worth considering:**

- A "foundation" feature that defines the shared interfaces first.
- An effort estimate per feature.
- An implementation order based on the dependencies.
