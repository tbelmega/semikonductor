---
name: fuse-workstream
description: Use when the user asks to work with fuse, fuse-konductor or a fuse-flow workflow, wants to start a new feature, system, migration or other substantial piece of work, or wants to continue work that may already be in progress, even if they name no workflow. Also use when, outside a running workstream, the user asks for one document, analysis or other artifact, such as "write a threat model", "draft an ADR" or "plan the E2E tests". Finds a workstream to resume, or recommends a workflow for new work and starts it once the user agrees, then runs it step by step with fuse-flow. For a single artifact, offers a workflow that produces it, the library's guide for it on its own, or a small custom workflow. Also turns fuse debug mode on or off, which ends every reply with a report of what fuse did.
version: 1.0.0
tags: [skill, fuse-flow, workflow, workstream]
---

# Fuse workstream

A workstream is one piece of work, such as a feature, a new system or a migration, that follows one
fuse-flow workflow from its first step to its last. fuse-flow keeps the workstream's state and
prints, at every command, the step to do now. This skill covers how to find the right workstream or
workflow, how to start it, and what to keep in mind while it runs. The steps themselves are
explained by what fuse-flow prints.

## Before you start

- **Find fuse-flow.** The fuse-konductor always-on rules give its path. Otherwise it is
  `<clone>/fuse/flow/fuse-flow`, where `<clone>` is the `clone=` line of
  `~/.konductor/fuse-konductor-clone`; if neither exists, ask the user where the clone is.
- **Run it from the root of the user's project repository,** never from inside the clone. A
  workstream's state is saved in `.konductor/workstreams/<slug>.yml` of that repository, after every
  command, and everything the steps produce belongs in that repository too.
- **Keep the mechanics out of what the owner reads.** Name workflows, steps and documents in plain
  words, such as "the feature workflow" or "next, the code review". Do not show fuse-flow commands,
  flags or the state file unless the owner asks how it works.
- **Debug mode.** When the owner asks to turn fuse debug mode on or off, or to see fuse at work
  turn by turn, read `debug-mode.md` next to this file and follow it.

## 1. Resume or start

Run `fuse-flow list`. It prints the project's workstreams with their workflow and current step, and
every workflow a new workstream can follow, with its description.

- **The user names a workstream,** or one clearly matches the request by its slug, its workflow or
  its current step: resume it with `fuse-flow start <slug>`. If several may match, ask which one,
  naming each by what it is about.
- **A workstream that is complete is not resumed.** If the user wants to change that work, it is a
  new workstream.
- **The user asks for one document or analysis,** such as a threat model, a decision record or a
  test plan, and it is not part of a running workstream: follow section 6.
- **Otherwise the work is new:** pick a workflow (section 2) and start it (section 3).

## 2. Pick a workflow

If the user names a workflow, use it. Otherwise recommend one, from the descriptions `list` printed
and what the request says. Read the descriptions every time; the set of workflows changes.

### What to weigh

- **The kind of work.** Where does it start and what is the result? A feature in an existing
  codebase, a new system or a module with its own architecture, a migration or refactoring that must
  leave the behavior the same, a small and well-understood change, or something still unclear that
  needs discovery first. Match it against each description's starting point and result.
- **Who set the workflow up.** A workflow in the project's `.konductor/workflows/` was put there
  for this project, often by the team; prefer it to a shipped one for the same kind of work. Then the
  user's own, in `~/.konductor/workflows/`. Shipped workflows in `personal/` and `team/` folders of
  the clone are the owner's or a team's own, not general defaults.
- **Examples are examples.** Workflows in an `examples/` folder show what a workflow can look like.
  Recommend one only when nothing else fits, and say that it is an example.
- **The amount of ceremony the work deserves.** A workflow with specs, reviews and owner approvals
  costs the owner attention and the agent tokens. For a change that one short message can describe
  and one review can check, say that no workflow is needed and do the work directly, unless the user
  asked for one.
- **Work that is too big for one workstream,** such as several features: recommend a workflow that
  plans the whole, if one exists, and one workstream per feature after it. Split fairly finely, and
  invite the owner to combine pieces that are too small to be worth their own spec, review and
  landing; your split is a proposal.
- **Gaps in the request.** If the kind of work is unclear and the answer would change the
  recommendation, ask one question with two to four options, your recommendation first. Do not ask
  what you can read from the repository or the conversation.

### How to recommend

Give the owner one recommendation with its reason in a sentence, then one or two alternatives with
what each would add or leave out, and the option of working without a workflow. Describe each
workflow by what it does, such as "a feature workflow: a spec you approve, a build against tests
from the spec, an independent review, then you land it". Start only after the owner agrees. If they
decline, do not suggest a workflow again for this work.

If nothing fits, offer to build or adapt a workflow with the owner; the `fuse-flow-builder` skill
covers that.

## 3. Start the workstream

- **Pick a slug:** short, lower-case letters, digits and hyphens, named for the work, such as
  `checkout-redesign`. It must not be the slug of an existing workstream.
- **Run** `fuse-flow start <slug> --workflow <name>`, with the name `list` printed. When `list` says
  a workflow can only be started by its path, pass the path.
- **Starting later in the workflow.** If the owner says earlier steps are already done, for example
  a spec exists and is agreed, recommend starting at the first step that is not, with your reason.
  Run `fuse-flow start <slug> --workflow <name> --from <step>` only after the owner agrees; the
  earlier steps are recorded as skipped on the owner's decision. Then follow the new step's `READ`
  lines, and recover what they name as the step block says.

## 4. While it runs

- **Follow the block fuse-flow prints,** completely, and run the continuation command it gives.
  Repeat until it hands the work to the owner or the workflow is complete. The block says how to
  account for each artifact, which checks and reviews to run, and how to hand back to the owner.
- **After a context reset or in a new session,** run `fuse-flow start <slug>` again: it prints the
  current step as if for the first time. The state file and the step's artifacts hold everything
  that matters; the conversation may not.
- **Jumps and skips are the owner's decisions.** `--from`, `--forward-to`, `--back-to`, and
  `--skip` on a step without a condition run only when the owner asked for them. When one would
  help, recommend it with a reason and wait.
- **`fuse-flow status <slug>`** shows every step with its state, when you need the whole picture.

## 5. When other installed rules overlap

Other installed skills and always-on instructions may cover the same ground as a step, such as a
second review mechanism, commit rules or a testing policy.

- When they agree, do the work once. Never run two reviews of the same work because two rule sets
  each ask for one.
- When they differ, look for the owner's ruling: the `RULINGS` lines of the step block, the
  project's `AGENTS.md`, and your harness's memory. If there is none, ask the owner which takes
  precedence, with your recommendation, before you do the overlapping part.
- Record the ruling as one plain sentence under `rulings:` in a fuse-flow policy file:
  `.konductor/policy-overrides.local.yml` for this owner in this project (the default),
  `.konductor/policy-overrides.yml` for the team, or `~/.konductor/policy-overrides.yml` for all of
  the owner's projects. fuse-flow then prints it in every step block. Save it to your harness's
  memory too, and offer to add it to the project's `AGENTS.md` or the owner's global instruction
  file, outside any block another tool manages.

## 6. A request for one artifact

When the user asks for one document, analysis or other artifact outside a running workstream,
such as "write a threat model" or "draft an ADR for this", the fuse library may already define
it: what it is, a guide to writing it, often a template, and sometimes a review guide.

1. **Look for it in the library.** Each folder under `library/artifacts/` is one artifact, with
   an `entry.yml` that describes it. Look in the project's `.konductor/library/`, then
   `~/.konductor/library/`, then `<clone>/fuse/flow/library/`; the first one that has the
   artifact wins. Match the request against the descriptions, not only the folder names. If
   nothing fits, do the work as you would without fuse, and do not bring fuse up.
2. **Find the workflows that produce it.** Search the workflows `fuse-flow list` shows for the
   artifact's id in their `produces` or `optional_produces`. Their files are in the project's
   `.konductor/workflows/`, `~/.konductor/workflows/` and `<clone>/fuse/flow/workflows/`.
3. **Offer the user up to three ways, in one short message,** with your recommendation first and
   its reason in a sentence:
   - **Start a workflow that produces it.** Name at most three, the ones that fit the request
     and the project best, and describe each by what it does, as section 2 says. Leave out
     workflows whose other steps the request clearly does not need.
   - **Write it now with the library's guide.** Follow the artifact's `guide.md` and
     `template.md`, and review the result against its `review.md` if it has one. This is the
     lightest way and fits a one-off the user wants now.
   - **Build a small workflow for it.** Fits when the user will want this artifact again, or
     wants steps around it that no workflow has. Load `fuse-flow-builder` and walk the user
     through it: suggest the few steps that fit, such as an interview before the draft or an
     independent review after it, and show the workflow as a diagram in Komposer, as that
     skill describes; if you can take a screenshot of the page, show it. Start the workstream
     once the user agrees.
4. **Keep it light.** The user asked for a document, not a process. Do not explain fuse-flow, and
   do not ask more than the choice. If the user declines all three, write the artifact with the
   guide or without fuse, as they prefer, and do not offer again for this request.
