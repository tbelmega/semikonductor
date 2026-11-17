---
name: testing-strategy
description: Use whenever planning, implementing or reviewing automated tests. Defines the test hierarchy used by fuse workflows.
---

# Testing strategy

Which level of test shows a behavior, and what a test may replace with a test double. Use it to
plan the tests of a change, to write them, and to review them.

## The project's conventions come first

When the project has established testing conventions, follow them where they differ from this
skill. Look for them in a steering document, the project's `AGENTS.md` or house rules, and the
existing test layout that the team keeps to.

With the user, use the project's own names for test levels, with the term from this skill in
parentheses, such as "integration test (component test)". Record the mapping in the project's
glossary, so the next reader finds it.

## Our system

Our system is the code this project builds, ships and deploys. Everything else is outside it,
such as other services and their APIs, the network, the clock and randomness.

## Test levels

A level is defined by what runs for real, not by the tool, the folder or the file name.

1. **Type check.** The compiler or type checker. It needs no test run.
2. **Unit test.** Pure code, such as a function that maps inputs to outputs, run with no test
   double.
3. **Component test.** A module through its public interface, with all of our own code real.
   Only what lies outside our system is faked.
4. **External-system test.** Our code against a real instance of another system, in a local
   container or in a development environment the owner authorized.
5. **End-to-end test.** The deployed system through its user interface.

## Rules

- **Never replace our own code with a test double.** No mock, stub, spy or fake of a module,
  class or function of our system. When a test seems to need one, test at the next level up, or
  move the boundary so that the code under test becomes pure.
- **Fake only what lies outside our system.** That includes the clock and randomness: pass them
  in, so a test can fix them.
- **Use the first level that can show the behavior.** Start at the type check and go up only
  when the level below cannot show it. A higher level is slower and fails for more reasons.
- **Push checks down to the types.** Where the language allows it, make an invalid state
  impossible to write, with strict types, rather than testing that it is rejected.
- **Start a bug fix with a failing reproduction.** Write a test or command that reproduces the
  bug, run it, and see it fail before you change the code.
- **Show that each new test can fail.** Run it before the code exists, or break the code briefly
  and watch it fail. A test that has never failed may not test anything.

## Acceptance tests

An acceptance test is defined by its purpose, not by its level: it shows one behavior the spec
promises, written at the lowest level that can show it. The spec names each acceptance test's
level and, for a level above unit, why a lower one cannot show it.

## Reviewing tests

In a code review, rate these findings as follows, unless the project's conventions say otherwise:

- A test that replaces our own code with a test double: P2.
- A test written above the level it needs: P3.
