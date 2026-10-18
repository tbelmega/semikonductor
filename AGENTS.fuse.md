# fuse-konductor

fuse-konductor guides a workstream through an ordered workflow. `fuse-flow` tracks each step and
prints the work to do next. Do the step with the owner; let fuse-flow decide the order.

The fuse-konductor clone is at {{CLONE}}. `fuse-flow` is `fuse/flow/fuse-flow` in that clone. Run
it by its full path from the root of the user's project repository, never from inside the clone.
fuse-flow needs Bun and installs its own dependencies on first use. If Bun is missing, tell the
user to install it from https://bun.sh. If the clone is not at the path above, ask the user for its
location.

## When to use it

- If the user asks to work with konductor, fuse or fuse-konductor, load the `fuse-workstream`
  skill and follow it. To build or change a workflow, use the `fuse-flow-builder` skill instead;
  for a guided tour, the `fuse-tutorial` skill.
- If the user asks to continue substantial work that may already be in progress, or to start a new
  feature, system or other large workstream, load the `fuse-workstream` skill: it finds the
  workstream to resume or suggests a suitable workflow. Requests such as "let's build X", "I want a
  new X" or "let's migrate X to Y" count. When unsure whether the work is large enough, load the
  skill anyway: it decides, and says so when no workflow is needed. The user decides. If they
  decline, do not suggest it again for that work.
- If the user asks for one document, analysis or other artifact outside a running workstream,
  such as "write a threat model" or "draft an ADR", load the `fuse-workstream` skill: it looks
  for the artifact in the fuse library and offers a workflow that produces it, the library's
  guide on its own, or a small custom workflow.
- Otherwise, do not bring it up.

## House rules

House rules are the ways of working that apply to this project and this owner beyond fuse: the
project's `AGENTS.md`, steering or other agent instruction files; the harness's global
instructions; the owner's earlier rulings, in fuse-flow's `rulings:` or anywhere else; what you
remember of working on this project; and what the project shows, such as pull request links in
earlier commit messages, or every commit made directly on the integration branch.

- Where fuse-flow has a setting for something, such as a check command, an artifact path, a review
  guide or how the reviewer is started, a value set in a policy file is the owner's deliberate
  choice: fuse-flow applies it, and it wins. Where no policy file sets it, the house rules still
  apply to it, as below.
- Where a fuse workflow, guide or skill says in prose how to do something that a house rule also
  covers, such as branching, commits and their messages, how a change gets reviewed or merged, how
  a reviewer is started, or where and in what format decision records are kept, do not let fuse
  win by default. Follow the owner's ruling if there is one. Otherwise follow the house rule when it
  clearly applies, and say that you did. When it is unclear which applies, ask the owner, with your
  recommendation. Record the answer as the `fuse-workstream` skill says.
- When both ask for the same work, such as two reviews of one change, do it once.

## While a workstream runs

- Follow the complete block fuse-flow prints, and run the continuation command it gives, until it
  hands the work to the owner or the workflow completes. After a context reset, run
  `fuse-flow start <slug>` to print the current step again.
- Run `--from`, `--forward-to`, `--back-to`, or `--skip` on a step without a condition only when
  the owner explicitly asked for that jump or skip. If one would help, recommend it with a reason
  and wait. Run any owner-decision command only after the owner has decided.
- Run a test suite or check that calls a deployed system, such as a deployed app, a cloud account
  or live endpoints, only when the owner authorized that target, even when a step says to run
  every test. Otherwise record it as not run, never as passing. A check bound in the project's
  policy was confirmed with the owner when it was bound.

## Writing for the owner

The owner reads what you write without the context you have built up. Write every statement so
that it explains itself to that reader.

- A heading, list entry or decision names its subject in words, such as "Matching rule: which free
  slot a booking request gets". A label such as `D1`, `Q3`, `P1` or `round 3` may accompany the
  words but never replaces them, in a document, a hand-over or a commit message.
- Refer only to what the reader has just read. A label defined in the text closely above may be
  reused. Do not point at a decision further down the document, in another file, or in the
  conversation; say what it is instead.
- Write commit subjects that describe the change on their own terms, without plan, task, finding
  or review-round identifiers, unless the house rules' commit format asks for one, such as a
  ticket number.
- Keep fuse-flow behind the scenes. Name the next step, phase or artifact in plain words, such as
  "next, the code review". Do not show fuse-flow commands, flags or the workstream's state file,
  and do not assume the owner knows how fuse-flow works. When the owner asks how it works,
  explain it.
