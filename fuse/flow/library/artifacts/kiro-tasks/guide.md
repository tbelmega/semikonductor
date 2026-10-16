# Writing a Kiro task list

A Kiro task list, `tasks.md`, is the last of the three files of a Kiro IDE spec for one feature. It
is the implementation plan: a numbered checkbox list of coding tasks, each small enough for a
code-generation model to carry out in one pass, each referring back to the requirements it serves.

It follows the `kiro-design` guide in the fuse library
(`fuse/flow/library/artifacts/kiro-design/guide.md` in the fuse-konductor clone), and is written
from that guide's `design.md` and the `requirements.md` before it.

## Where the file goes

Read `requirements.md` and `design.md` from the feature's spec directory and write `tasks.md` into
it. The step's artifact path decides the spec directory: it is the folder of that path. When the
step or its caller names a spec directory instead (some callers call it `spec_dir`), read and
write there. Only when neither is given, use the Kiro IDE default, `.kiro/specs/<feature>/`.

## Format

```markdown
# Implementation Plan

- [ ] 1. Set up project structure and core interfaces
  - Create directory structure for models, services, and API components
  - Define interfaces that establish system boundaries
  - _Requirements: 1.1_

- [ ] 2. Implement core data models
  - [ ] 2.1 Create data model interfaces and types
    - Write TypeScript interfaces for all data models
    - Implement validation functions
    - _Requirements: 2.1, 3.3_
  - [ ] 2.2 Implement User model with validation
    - Write User class with validation methods
    - Create unit tests for validation
    - _Requirements: 1.2_
```

- A numbered checkbox list: `- [ ] N.` for a top-level task, `- [ ] N.M` for a sub-task.
- Sub-tasks are indented two spaces under their parent.
- At most two levels: top-level tasks and one level of sub-tasks.
- Each task has a clear objective, sub-bullets with the details, and its requirement references
  in italics, `_Requirements: X.Y_`, pointing to the numbered criteria in `requirements.md`.
- Tasks are coding tasks only: no deployment, documentation or user testing.
- Each task builds on the ones before it.

## Ordering

1. **Foundation:** project structure, interfaces, shared utilities.
2. **Core:** the main feature: data models, services, API.
3. **Polish:** error handling, edge cases, validation.

## Method

1. Read `requirements.md` and `design.md` from the spec directory.
2. Map each requirement to the implementation tasks that satisfy it.
3. Order the tasks by dependency: foundation, then core, then polish.
4. Write `tasks.md` into the spec directory.
5. Check it against the checks below. The step's gate decides approval; used on its own, present
   `tasks.md` to the owner for approval, and when they ask for changes, revise it and present it
   again, for at most two cycles.

## Quality checks

**CRITICAL (must fix):**

- Circular dependencies between tasks.
- A task without a requirement reference: every task links to at least one requirement.
- Tasks with non-coding work: deployment, documentation, user testing.
- `tasks.md` written anywhere other than the feature's spec directory.

**IMPORTANT (should fix):**

- A task too large for a code-generation model to complete in one pass.
- No clear ordering: foundation tasks come before core tasks.
- Sub-tasks at the same indentation as their parent instead of two spaces in.

**SUGGESTION:**

- Mark the tasks that can run in parallel.
- Add an effort estimate per task.
- Group the tasks into phases with headings.

Report the findings in the order CRITICAL, IMPORTANT, SUGGESTION. Fix every CRITICAL finding
before you present the task list, and present the rest with it, unless the step says how to
handle them.
