# Writing the spec index

The spec index lists one spec directory per feature of the feature split, so that the owner can
approve all specs at once and the implementation can find each feature's tasks.

## Writing the specs

For each feature in the feature split, in order, write its spec directory, by default
`.kiro/specs/<feature>/`, with three files:

1. `requirements.md`, following `../kiro-requirements/guide.md`, from the feature's user stories
   and acceptance criteria;
2. `design.md`, following `../kiro-design/guide.md`, from the requirements and the part of the
   overall design that the feature covers;
3. `tasks.md`, following `../kiro-tasks/guide.md`, from the requirements and the design.

The paths are relative to this guide's folder in the fuse library. Write all three files into the
feature's spec directory.

## The index

The index is a short Markdown file with one row per feature:

| Feature | Spec directory | Stories covered | Status |
|---|---|---|---|
| `checkout-form` | `.kiro/specs/checkout-form/` | US-1.1, US-1.2 | complete |

Before you report the step done, check each row:

- all three files exist in the spec directory;
- every requirement traces to a user story, every task to a requirement, and every user story
  assigned to the feature to at least one requirement;
- the status is `complete`, or names what is missing and why.

Put any feature whose spec is incomplete, and any story that no feature covers, at the top of the
index, so the owner sees them before approving.
