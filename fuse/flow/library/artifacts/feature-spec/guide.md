# Writing a feature spec

A feature spec says what one feature does and how it will be shown to work, short enough for the
owner to read and approve in a few minutes. It is the authority the implementation and the review
are checked against.

## What it holds, in this order

1. **For the owner:** the decisions you need from them and any open question, each with your
   recommendation. Title each one with what it decides, such as "Matching rule: which free slot a
   booking request gets", and give enough context that the owner can decide without reading the
   rest of the spec first. Leave the section out when there is nothing to decide.
2. **Assumptions and decisions:** what you decided yourself, with the reason, most important
   first, so the owner can object before reading on.
3. **What and for whom:** the request in one or two sentences, and the outcome the owner wants.
4. **Scope:** what the feature includes, and what it does not.
5. **How it fits the code:** the files, modules or interfaces it changes or adds, found by reading
   the code, with paths.
6. **Acceptance tests:** one per behavior the feature must have, each written so that a test can
   check it, from the request and not from an implementation you have in mind. Give each test's
   level, the lowest that can show the behavior, and for a level above unit, why a lower one
   cannot show it. No test replaces the project's own code with a test double. The
   `testing-strategy` skill (`skills/testing-strategy/SKILL.md` in the fuse-konductor clone)
   defines the levels. For behavior that repeats, retries or reconciles, include a test that runs
   it again on the finished state and changes nothing, and a test for each failure path that
   follows it through to recovery. Each test fails without the feature.
7. **Deferred:** ideas and extensions that came up but are not part of this feature, so they are
   recorded instead of built.

Keep each section as short as the feature allows; a small feature may need only a few lines per
section. Leave out what does not apply.

The spec states the current result. Once a question is resolved, write its answer where it
belongs and remove the question. Approvals, resolved questions and the history of reviews go to
the decisions file, not the spec.
