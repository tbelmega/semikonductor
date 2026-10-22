# fuse-flow

fuse-flow keeps an agent on a defined process. 
You choose one of the pre-defined workflows, or define your own: an ordered sequence of activities and the artifacts they produce. 
The engine reads that workflow and the work done so far, and calculates the next step.

You will not interact with the engine. The agent guides you through the steps. But instead of interpreting prose instructions and reason about it, 
the agent invokes this deterministic program behind the scenes to decide the next step.


## Behind the scenes

You do not need to know any of this, but you're welcome to explore and understand what's happening.

The agent invokes `fuse-flow start` on the terminal, which prints what to do now. 
The agent does that work and runs `fuse-flow continue`, which checks and records
the step before printing the next one. fuse-flow refuses completion while required artifacts are
unaccounted for or a mechanical gate fails, and it hands decisions to the owner when required.

It is a small command line tool meant to be operated by agents. It runs the TypeScript sources
directly on [Bun](https://bun.sh), or on Node 22.18+, 23.6+ or 24+. Bun is the main runtime and
runs the tests.

fuse-flow is part of fuse-konductor and runs from the fuse-konductor clone. `install.sh` installs
the agent rules into a project or into a user-level instruction file and checks that Bun is
present. It does not copy fuse-flow. A global install writes the clone path into the rules. A
project install writes `clone=<path>` to `~/.konductor/fuse-konductor-clone`, so a committed
`AGENTS.md` stays the same for every developer. One clone serves any number of projects. Each
repository keeps its private workstream state under `.konductor/workstreams/`. Writing a
workstream also adds the repository's root to `~/.konductor/projects.yml`, a list of paths that
Komposer reads to show the runs of every project; the state itself stays in the project.

```bash
cd <your-project>
<fuse-konductor-clone>/fuse/flow/fuse-flow start my-feature --workflow _k-full-sdlc
```

When zod and yaml are missing from the clone's `fuse/flow/node_modules`, normally only on the
first run, fuse-flow downloads them from the npm registry with `bun install`, or with `npm install`
when only Node is present. That is the only time it uses the network. An offline run fails and
names the command to run.

In normal use, the agent runs the `fuse-flow` script by its full path. Every follow-up command
fuse-flow prints uses that same path, so nothing needs to be on `PATH`. This document shortens the
command to `fuse-flow ...`.

## The agent loop

A workstream is one piece of work, such as a feature, refactoring or story. Its workflow is an
ordered list of steps. The current step is the first step that is neither `COMPLETED` nor
`SKIPPED`.

1. `fuse-flow list` shows the project's workstreams and the workflows a new one can follow.
   `fuse-flow start <slug> --workflow <name or path>` creates a workstream and prints its first
   step. `fuse-flow start <slug>` resumes an existing workstream and prints its current step.
2. The agent follows the printed step block. When the work is done, it runs the printed
   `fuse-flow continue <slug>` command and accounts for produced and updated artifacts.
3. fuse-flow runs the mechanical gates, records the result, and prints the next step or an
   `OWNER'S TURN` hand-over block.
4. The agent repeats until the hand-over block says `STATUS: workflow complete`.

When the owner must decide, the agent presents the printed options with a recommendation and runs
the command for the decision only after the owner has made it.

## Workflow format

A workflow is YAML with `version: 1`, a `name`, an optional `description`, and one or more ordered
`steps`. Every step has a unique `id` and an `instruction`. `title`, `description` and `phase` are
optional information for readers and the viewer.

A step may carry `mode: attended` or `mode: unattended`; a step without it is attended. An attended
step tells the agent to ask the owner often and the owner to stay with the session. An unattended
step tells the agent to decide on its own judgement, asking only before an irreversible action, one
outside the checkout, or where the instruction asks for the owner, and tells the owner it can leave
until the next owner gate. Where the instruction sets how the whole step runs, such as an
interactive or automatic mode, the instruction wins. In both modes the agent records the decisions
it makes on its own in the workstream's decisions file (see [Decisions](#decisions)). Mark a step
unattended when it is written for the agent to work alone; leave every other step unmarked.

```yaml
version: 1
name: feature
steps:
  - id: research
    instruction: Map the existing behavior.
    condition:
      agent: the work touches an unfamiliar area
    optional_produces:
      - artifact: research-note
        path: docs/research/{slug}.md

  - id: spec
    instruction: Turn the request into an agreed specification.
    produces:
      - artifact: spec
        path: docs/specs/{slug}.md
    gates:
      - owner-action: approve the specification

  - id: implement
    instruction: Implement the approved specification.
    consumes: [spec]
    updates:
      - artifact: code
        path: src/
    gates:
      - check: default
      - agent: review the branch diff
        max_rounds: 2
        guide: reviews/code.md
      - owner-action: approve the change
        route_back_to: spec
```

The step fields have these effects:

- `instruction` opens the step block and says what the step must achieve. It is printed as
  written: a literal block (`|`) keeps its line breaks and indentation, and a folded one (`>`)
  keeps the breaks between its paragraphs. Only blank lines before the text and whitespace after
  it are dropped.
- `condition` makes the step optional. It is written as one `owner-action`, `check`, `script` or
  `agent` mapping. A `check` or `script` condition runs when the engine reaches the step: exit 0
  runs it and another result skips it. A `check` condition whose kind the policy binds to `none`
  counts as passed, as a `check` gate does, so the step runs, and the `CONDITION` line says the
  check is not configured. A `check` condition whose kind is not bound at all holds the step in
  `PENDING`, not handed out, until the kind is bound; such a step cannot be reported blocked, and
  the block it prints offers `--skip` for when the owner decides it should not run. An `agent`
  condition is judged by the agent. An `owner-action` condition asks the owner. A step without a
  condition is mandatory.
- `consumes` lists artifact identifiers from earlier steps. The step block prints each resolved
  input as `READ`, including the source step. A missing input is reported rather than refused, so
  the agent can recover it after a jump. A step that was skipped because it was not needed, or
  that finished without recording the artifact, such as one that reported it not produced or an
  optional producer that wrote nothing, wrote nothing: `READ` then names the document of the
  nearest earlier step that declares the artifact, as a later workstream's input does, and
  reports nothing to read only when there is none. For a folder artifact, `READ` lists the files the source step recorded in it rather than
  the whole folder. `READ` names the document, or the files in a folder, that the source step
  recorded, also after an edit moved the artifact's path, as a later workstream's input does; a
  later workstream's input is then the folder that holds the recorded files, the repository root
  `.` when they have no deeper folder in common. Each document read, also a file
  recorded in a folder and a document the step's own child returned, is reported when it is no
  longer on disk.
- `produces` contains one artifact mapping or a list. Each mapping has an `artifact` identifier,
  a `path`, and an optional `description`. Completion requires the path to exist, and a folder
  to hold something, or the agent to report `--not-produced <artifact> <reason>`. When the path is
  a folder that existed before the step, such as a research folder shared with other work, the
  agent writes the step's files in it and names each with `--updated <file>`, or with
  `--updated <artifact>=<file>` when the folder lies inside another declared path; the engine
  records the files one by one. A folder that another artifact of the workstream recorded, such
  as an index updated in a shared reports folder, counts as existing for a later producer. Naming such a folder itself is refused. A declared folder the step
  created, named itself, stands for the whole folder.
- `optional_produces` has the same mapping shape. Existing paths are recorded, but missing paths
  never refuse completion.
- `updates` has the same mapping shape for artifacts that usually exist before the step, such as
  code. The agent accounts for every updated artifact with one or more `--updated <file>` flags,
  or with `--unchanged <artifact> <reason>`. A missing update path is reported and may be created.
  `--unchanged` is refused for an artifact whose files this command, or an earlier command in the
  same pass such as a blocked report, names as updated.
- `--updated <file>` counts for the artifact whose declared path holds the file, and the engine
  fixes that artifact when the file is named. A file outside every declared path counts for no
  artifact. A file inside the paths of two artifacts, such as a report inside the code at `.`, is
  refused until the agent names the artifact with `--updated <artifact>=<file>`; it repeats the
  flag for each artifact the file counts for. The step block lists such paths under
  `FILES IN TWO ARTIFACTS`. A relative path is read from the current directory, else from the
  repository root. A file in neither place, such as a deleted one, is read where a path of the
  step holds it, for the artifact named if one is; where both places or neither are held, where
  git knows it, in the index or in the history of HEAD, so a staged or committed deletion still
  names the file where it was.
- `--unchanged` and `--not-produced` name an artifact by its identifier or by its path, relative
  to the current directory, else to the repository root, as the step block prints it. An
  identifier wins when a name is both. A path that several of the
  step's artifacts share is refused, and the artifact must then be named by its identifier.
- `{slug}` in an artifact path is replaced with the workstream slug, and `{date}` with the local date
  the workstream started (YYYY-MM-DD), which stays the same for the whole workstream.
- `gates` is one gate or a list. Gate kinds are `owner-action`, `check`, `script` and `agent`.
  Gates run in a fixed order: mechanical gates, agent reviews, then owner actions. List order does
  not change that sequence.
- `check: <kind>` names a lower-case check kind that policy binds to a command. `script: <command>`
  is a literal shell command. Both run from the repository root through `sh -c` and must exit 0.
  fuse-flow sets two variables for the command, which it may rely on: `FUSE_FLOW_SLUG`, the
  workstream's slug, and `FUSE_FLOW_STEP`, the step's id. The step block prints the command with
  both set, as `FUSE_FLOW_SLUG=<slug> FUSE_FLOW_STEP=<step> sh -c '<command>'`, so a run by hand
  is the run fuse-flow makes on `continue`.
- `agent: <review>` tells the maker to obtain an independent review. `continue` is refused until
  the reviewer has written a findings file for at least one round of the step's current pass, as
  the step block names it; fuse-flow does not read the findings, since the maker classifies them.
  A review the owner accepted needs none. When the owner waives a review that has not run,
  `continue --waived <reason>` finishes the step and records the waiver, with the reason, in the
  hand-over's `VERIFICATION` line; a send-back ends it. `max_rounds`, at least 1,
  caps review rounds that end with a required fix. The default is 2. `guide` may name a review
  guide relative to the workflow file or by absolute path. The guide that applies, after policy
  and the library have had their say, must be a file; one that a more specific guide replaces
  need not exist. A new workstream and `validate` refuse a guide that cannot be followed in any
  step. A running workstream refuses one only in the steps not finished yet, whose step blocks
  print it, and `--back-to` in the steps it would reopen; the owner's `--skip`, `--forward-to`
  and a new workstream's `--from` check only the steps from the one they reach, so the owner can
  pass over a review whose guide is gone. `--from` likewise does not check the review guides of
  the child workflows of the delegating steps it skips. When the hand-out moves the current
  step first and the decision is not applied, the steps from the one the hand-out reached are
  checked instead. A delegating step's existing child that refuses such a guide cannot be used. `status` and `list` read the workstream
  whatever its guides. fuse-flow prints these instructions;
  the maker counts the rounds and reports `--blocked` at the cap.
- `owner-action: <action>` leaves the completed work in `AWAITING_OWNER` until the owner decides.
- Any gate mapping may have `route_back_to`, as one step identifier or a list. Each target is the
  same step or an earlier step. It suggests routes for the owner's `--back-to` decision and does
  not create automatic control flow. A mapping may also have an informational `description`.
- `workflow: <name or path>` makes the step wait for a child workstream that follows that
  workflow. A path is relative to the workflow file, as a gate's `guide` is, while
  `start --workflow <path>` reads a path from the current directory, else from the repository
  root. It is described under
  "Workflows that work together" below.

### Workflows that work together

Every workstream stays one flat list of steps. Workflows relate only by references between
workstreams: one workstream can be started after another and take its documents, and one step can
wait for a child workstream. One workflow's steps never run inside another's.

```yaml
version: 1
name: code-review
inputs:
  - artifact: build-order
    description: The system's build order, when the change is part of a system.
  - artifact: requirements
    required: true
hands_off_to:
  - workflow: release
    when: once the owner has merged the change
steps:
  - id: intake
    instruction: Write the review diff.
    consumes: [requirements, build-order]
    produces: { artifact: review-diff, path: "reviews/{slug}.diff" }
  - id: adversarial
    instruction: Merge the new findings into the review.
    gates:
      - workflow: adversarial-review
        slug: "{slug}-adversarial"
        inputs: { given-diff: review-diff }
        returns: [adversarial-report]
  - id: summary
    instruction: Write the verdict.
    consumes: [adversarial-report]
```

- `inputs` lists documents the workflow expects from outside. Steps consume an input like an
  artifact from an earlier step. An input is optional unless it has `required: true`. A step
  block shows an input that was not bound as not given. A workflow may not declare an input with
  the id of an artifact one of its own steps writes; name the input differently, such as
  `given-diff`.
- `start --after <earlier slug>` binds each input to the earlier workstream's latest recorded
  document with the same id, or to that workstream's own input of that id. `start --input
  <id>=<path>` binds one input to a file and wins over `--after`. `start` refuses a required
  input that stays unbound, and an `--input` the workflow does not declare. A relative input path
  is read from the current directory, else from the repository root, as `continue` reads one. An
  input path that does not exist is reported in the step block, as a missing artifact is.
- `hands_off_to` is one workflow or a list, each a name or a `{ workflow, when }` mapping; a
  path is relative to the workflow file. The completion block names each one with its `when` text and the exact `start ... --after <slug>`
  command. Nothing starts on its own: the agent offers the next workflow to the owner where its
  `when` applies, and does not mention it where it does not, so a `when` can rule a hand-off out,
  such as a pull request workflow in a project without pull requests. When one workstream leads
  to several, such as one feature workstream per entry of a build order, the agent starts each as
  the owner agrees.
- A `workflow` gate delegates the step to a child workstream. When the step is handed out,
  fuse-flow creates the child under `slug`, a template with `{slug}` (the parent's slug) and
  optionally `{step}`; the default is `{slug}-{step}`. `inputs` maps each child input id to an
  artifact of this workflow from before the step. The step block tells the agent to run the
  child to its end, itself or in a subagent, and the owner's decisions in the child are made
  there. The gate runs before every other gate: `continue` is refused until the child is
  complete, and the refusal says which step the child is at and in which state. A workstream
  under the child's slug that follows another workflow, or belongs to another step, never
  satisfies the gate. A child recorded for the step's current pass keeps its slug after an edit of
  the gate, so when the gate now names another workflow, the owner sends the work back to the step,
  whose next pass creates a new child. When the child cannot be created or used, the `DELEGATE`
  line says why, or points to the refusal above it that does, and `WHEN THE WORK IS DONE` says
  the step cannot complete until that is resolved. The owner cannot accept a blocked delegating
  step, or approve one awaiting the owner, while its child is unfinished, such as after its
  workflow gained a step; the hand-over block then offers finishing the child first or skipping
  the step instead of the approval, and `VERIFICATION` says the child recorded complete is
  unfinished now. It offers finishing the child only when finishing it would satisfy the gate:
  for a recorded child whose state file is gone it offers restoring that file or sending the work
  back for a new child, and for a child that cannot be used, such as one that follows another
  workflow than the edited gate, correcting what the `STATUS` line names.
- `returns` lists the child's documents that later steps may consume, as a list of ids or a
  mapping from the id in this workflow to the id in the child, to rename one that would clash,
  as in `returns: { system-design: design }`. A returned id resolves to the newest child's
  recorded document. Only the listed ids come back; nothing is copied. When the newest child
  recorded nothing under the id, there is nothing to read, even if an earlier step wrote a
  document with the same id. A delegating step that was skipped returns nothing; when the owner
  jumped past it or started the workstream after it, the step block says to restore what the
  child would have returned.
- When the owner sends the work back past a delegating step, its next pass gets a fresh child
  with a pass suffix, such as `review-adversarial-2`, and the earlier child stays as history.
  The step's state records which child belongs to which pass. Skipping a delegating step removes
  its child, if nothing happened in it yet.
- `validate` checks the references against the other workflow files: each hand-off and gate
  target resolves and its review guides can be followed as they apply in this project, a gate's
  `inputs` name inputs the child declares and give every required one, its `returns` name
  documents the child has, and no chain of workflow gates leads back to the workflow. A hand-off
  target that takes none of this workflow's documents is only a warning.
  So is a `name` that differs from the file name; the warning names the reference
  `start --workflow` takes: the file name where a lookup by it finds the file, else the path, as
  for a `.yaml` file, which is never found by name.
  At run time, a child whose chain of parents already follows its workflow is refused.
- `status` and `list` show the workstream a workstream was started after, its parent, the
  workstreams started after it, and the child a waiting step waits for. Komposer draws hand-offs
  and workflow gates as links that open the target workflow.

## Commands

| Command | What it does |
|---|---|
| `start <slug> [--workflow <name or path>] [--from <step>] [--after <slug>] [--input <id>=<path>]...` | Create or resume a workstream and print what to do. A new workstream requires `--workflow`. On a resumed workstream, `--workflow` names the workflow it follows, or, when that file is gone, its new path. On a new workstream, `--from` starts at a later step and records earlier steps as skipped on the owner's decision. `--after` and `--input` bind the workflow's inputs, as described under "Workflows that work together". |
| `continue <slug>` | Finish the current step after its artifacts are accounted for, each review it owes has a findings file in this pass, and its mechanical gates pass, then print the next step or hand-over block. A step that this command hands out first, such as one added to the workflow or reached because a condition now skips the step before it, is printed and not finished; an owner's decision is likewise not applied when the hand-out moved the current step. |
| `continue <slug> --waived <reason> [<the flags above>]` | Finish the current step as `continue` does, without the reviews that have not run, which the owner waived. Records each waiver with the owner's reason; the hand-over names it. Refused when no review is left to waive. |
| `continue <slug> [--updated [<artifact>=]<file>]...` | Report each file revised under an `updates` artifact. Repeat the flag for several files. Files outside declared update paths are accepted and identified in the hand-over block. A file inside the paths of two artifacts takes the identifier of the one it counts for. |
| `continue <slug> [--unchanged <artifact> <reason>]...` | Report each `updates` artifact deliberately left unchanged. Repeat the flag as needed. |
| `continue <slug> [--not-produced <artifact> <reason>]...` | Report each required `produces` artifact deliberately not written. Repeat the flag as needed. |
| `continue <slug> --blocked <why> [--gate <n>] [--updated [<artifact>=]<file>]...` | Record that the agent cannot finish the current step, such as at the review round cap. `--gate` names the review it is blocked at, by its number in the step block. The files of the step's `produces` paths on disk, and the files named with `--updated`, are recorded as draft, so the hand-over lists them and acceptance keeps them. The owner decides what happens next. |
| `continue <slug> --skip <why>` | Skip a conditional step, or skip any step after the owner explicitly asks. Records the reason, as the agent's decision for an agent condition it judged and as the owner's otherwise. |
| `continue <slug> --owner-approved [--gate <n>] [--note <text>]` | Record the owner's approval of an `AWAITING_OWNER` or `BLOCKED` step and complete it; the gates the blocked step has not passed do not run, and the hand-over names them. A step that delegates to a child workstream is approved only while the child is complete; otherwise the owner skips it. With `--gate`, the owner accepts only the review the step is blocked at: the step goes back to the agent, which runs the gates still ahead and does not run that review again. An acceptance, a block at a review and the reviews a step passed before the owner are each bound to the review's identity as recorded then: its number, its text, and each guide it follows with the artifact the guide applies to and a digest of the guide's content. They hold only while the workflow names the review exactly so. When an edit of the workflow, of a guide or of the policy changes an accepted review, the step block prints a `TAKEN BACK` line that names it and asks the agent to tell the owner; the review runs again with its rounds counted afresh, in findings files with `-redo` in the name, and the reviews that passed before it run again once an edit changes one of them. When the edit removed the review or moved it to another number, the line says so, and the hand-over's `VERIFICATION` line names the acceptance that was taken back. A change of the review the step is blocked at refuses `--gate` and leaves the owner the other decisions. A record an earlier fuse-flow wrote without the identity is bound to the reviews as the workflow names them at the first command that reads it; where no review has its number then, or the workflow no longer has the step, it is bound to none, so a review an edit adds at that number later runs, and the step block says the acceptance was taken back. An `AWAITING_OWNER` step whose work a check, script or review that an edit added or changed has not run on cannot be approved: the hand-over names those gates, and the owner sends the work back to the step, which runs them. |
| `continue <slug> --more-rounds <n> [--note <text>]` | Add one or more review rounds to an agent gate on an `IN_PROGRESS` or `BLOCKED` step. |
| `continue <slug> --back-to <step> [--updated [<artifact>=]<file>]... [--note <text>]` | On the owner's decision, reopen the named step and every later step, from the current step in any status. Files stay on disk and stay recorded, as draft; `--updated` records what the current step wrote so far. A reopened step's next pass lists the files of its earlier passes; where it writes an artifact whole at a path an edit has moved, later steps and `--after` read the new file alone, also when an earlier fuse-flow recorded the earlier one, and the earlier one stays in the step's files as history. Its review rounds count from that pass, with findings files named `<step>-pass-<n>-round-<m>.json`. |
| `continue <slug> --forward-to <step> [--note <text>]` | On the owner's decision, skip the current step and every step before the later target. |
| `status <slug>` | Show all steps, their six states, gates, artifacts, skip reasons and the current step. Each review gate shows its round cap, with any rounds the owner granted, such as `[cap 3, 2 plus 1 granted]`, or the owner's waiver in this pass, as `[waived by the owner: <reason>]`. Each file shows once, under the latest step that records it. `done` means the step's gates passed and it has no owner gate; `approved` means an owner gate approved it. Steps the state file records that the workflow no longer has, because the workflow was edited, are listed after the steps with their status. |
| `list` | List the project's workstreams with their workflow and current step, and how many recorded steps the workflow no longer has, and every workflow a new workstream can follow, by location, with the name `start --workflow` takes and its description. Names that cannot be started by name, and invalid files, are listed with the reason. |
| `validate <name, file or directory>...` | Validate one or more workflows without starting a workstream. A directory means every `.yml` and `.yaml` file below it, including nested and symlinked folders. |
| `help`, `--help`, `-h` | Print command usage, lookup paths and state location. |

`--note` is valid only with `--owner-approved`, `--more-rounds`, `--back-to` or `--forward-to`.
`--gate` is valid only with `--blocked` or `--owner-approved`.
`--waived` is valid only when the step's work is reported done, with no decision or other report.
The owner decision flags are mutually exclusive. `--blocked` and `--skip` are mutually exclusive
reports, and artifact-reporting flags do not accompany either kind, except `--updated` with
`--back-to` and `--blocked`. Exit codes are 0 for success,
1 for a refusal, and 64 for a usage error. The `fuse-flow` launcher exits 69 before the engine
runs when it finds neither bun nor a recent enough node with npm, or cannot install the
dependencies.

## Output contract

The plain-text output is an interface for agents. A layout change is deliberate and should update
the tests and this section.

When it is the agent's turn, the step block uses these labels:

- `STEP` gives the step identifier, position and instruction.
- `RULINGS` lists the owner's rulings from the policy files, where they set any.
- `OWNER SAID` quotes the owner's note with each decision that led into this pass.
- `CONDITION` explains why an optional step runs or how to skip it.
- `MODE` says whether the step is attended or unattended, what that asks of the agent and the
  owner, and where the agent records its decisions.
- `DELEGATE` names the child workstream a step with a workflow gate waits for, and how to run it.
- `READ` gives each consumed artifact's path and source step, input or returning child workstream.
- `RETURNS` names a document the step's own child returns, once the child is complete.
- `PRODUCE` gives a required artifact path, identifier, guide and template information.
- `PRODUCE (optional)` gives an optional artifact in the same form.
- `UPDATE` gives an artifact path the step changes and reports when the path is missing.
- `FILES IN TWO ARTIFACTS` names the declared paths that lie inside another artifact's path, where
  a file needs `--updated <artifact>=<file>`.
- `EARLIER PASS` lists what the step wrote before the owner sent the work back, to keep, update or
  redo.
- `GUIDES` says how the step's instruction and the artifact guides rank where they differ.
- `WHEN THE WORK IS DONE` gives numbered gate and completion instructions.
- `IF YOU STOP BEFORE THE STEP IS DONE` gives the five hand-back lines below, pre-filled with the
  workstream, the step and any skipped steps, for a message that waits on the owner while the step
  is in progress.
- `REFUSED` gives the reason completion was refused, followed by the step block again.

When the owner acts next, `continue` first prints a line with what it recorded, such as
`build: COMPLETED`. Then come `OWNER'S TURN`, with what the agent does with the block, and the
pre-filled hand-over block. The agent replaces placeholders, preserves the order, and ends its
own message with these five lines, and a sixth when the agent has finished work since the
owner's last decision:

- `SUMMARY:` the task, workstream slug and step position.
- `STATUS:` one of `awaiting owner action`, `blocked`, `needs input`, `paused` or
  `workflow complete`.
- `PRODUCED:` new and updated files, or a compact summary for five or more files, plus reasons for
  artifacts reported unchanged or not produced. A folder recorded whole is listed by name and does
  not count as a file.
- `VERIFICATION:` mechanical gate results, review rounds used and required fixes still open, or
  `none`.
- `NEXT STEP:` the owner's options, with the recommendation first and its reason.
- `DECISIONS:` how many decisions are open, or `none recorded`, the decisions files they are in,
  and the owner's four ways to respond. It names this workstream's file and the file of each
  delegated workstream whose finished work the owner has not reviewed, with the step that
  delegated it. It also says, in plain words, that a change goes back to the step whose work it
  changes, so the gates run again, or after `workflow complete` into a new workstream; the
  `decision-log` guide gives the agent the commands.

fuse-flow pre-fills the block for `awaiting owner action`, `blocked` and `workflow complete`. The
output ends with `FOR YOU, NOT FOR THE OWNER:`, which the agent keeps out of its message. For a
step that waits for the owner, it gives the command for each of the owner's options. On
`workflow complete`, present when there is something to say, it names the workflows this one
hands off to, with their start commands, and for a child workstream the parent step that waits
for it, or why that step no longer waits for it: the owner skipped or completed it, or sent the
work back so that its new pass waits for another child. For
`needs input` or `paused`, the agent fills in the lines the step block printed under
`IF YOU STOP BEFORE THE STEP IS DONE`.

## Files

### Workflows

A workflow reference containing a slash or ending in `.yml` or `.yaml` is a path. Otherwise a name
is looked up as `<name>.yml`, first in the project's `.konductor/workflows/`, then the user's
`~/.konductor/workflows/`, then `fuse/flow/workflows/` in the package. Within each location,
fuse-flow searches every folder at any depth, following symlinks, so a workflow may keep its own
files in a folder of its own, such as `fuse/`. The first location with a match
wins; two matches in one location are refused as ambiguous, wherever they sit.

The schemas in `src/schemas/` define the fields. `bun run schema` writes editor schemas to
`workflows/schemas/`. A workflow may point its editor at `workflow.schema.json`. fuse-flow checks
cross-field rules, including unique step identifiers, valid `consumes` references and backward
`route_back_to` targets. It reads the workflow again on every command, so edits affect running
workstreams. An edit of a step's gates holds back the approval of work already recorded for the owner until
they run on it, and it takes back the owner's acceptance of a review it changes;
`continue --owner-approved` under Commands describes both.

### Artifact library

Each artifact identifier selects one folder with this layout:

```text
library/artifacts/<id>/
  entry.yml         optional; `description:` says what the artifact is (library-entry.schema.json)
  guide.md          how to produce the artifact
  template.<ext>    optional structure for the artifact
  review.md         optional review guide
```

The engine points the agent to a template but does not copy it. It searches the project's
`.konductor/library/artifacts/<id>/`, then the user's `~/.konductor/library/artifacts/<id>/`, then
the package's `fuse/flow/library/artifacts/<id>/`. The first existing folder wins as a unit, so
files are not mixed across library levels. An entry may also be filed in folders below
`artifacts/`, such as `artifacts/writing/<id>/`: a folder that holds only folders groups entries,
and any other folder is an entry named by the folder. An id found twice in one library is refused,
as a workflow name is. The engine does not use `entry.yml`; Komposer shows the
description and pre-fills a step's instruction from it. `library/gates/` is reserved; reusable gate
entries are not defined yet.

### Policy overrides

Policy binds workflow intents to a project. Files are read at these locations:

1. `~/.konductor/policy-overrides.yml`, personal defaults across projects.
2. `.konductor/policy-overrides.yml`, team policy checked into the project.
3. `.konductor/policy-overrides.local.yml`, personal policy for that project, normally gitignored.

A policy file may contain:

```yaml
checks:
  default: bun run check
  test: none
review:
  max_rounds: 3
  guide: review-guides/default.md
  reviewer: a different model from the maker
  launch: subagent                 # or a command, below
  reviewers:                       # the reviewer's model, by the author's model
    claude-opus-5.5:
      model: gpt-6.1-sol
      effort: high
      launch:                      # a row's own launch, for a model this harness cannot run
        command: opencode run -m amazon-bedrock/us.openai.{model} "$(cat {prompt_file})"
    gpt-6.1-sol: { model: claude-opus-5.5, effort: high }
rulings:
  - In fuse-flow workstreams, the workflow's review gates replace the review loop of the project's own review skill.
artifacts:
  spec:
    path: docs/specs/{date}-{slug}.md
```

`launch` says how the agent starts a reviewer: `subagent`, a fresh subagent in its own harness,
or a shell command such as another harness on the terminal. When no policy file sets it, the agent
starts the reviewer the way the house rules ask, and else as a subagent. In the command,
`{model}`, `{effort}`, `{prompt_file}` and `{findings_file}` are replaced. Whichever way it is
started, the reviewer writes its findings to `.konductor/reviews/<slug>/<step>-round-<n>.json`,
following `workflows/schemas/review-findings.schema.json`, and the agent reads them from there; the
directory is gitignored, so a review guide does not belong there; `review.guide` is relative to
the policy file that sets it. In a step with several reviews, the file name carries the review's number
in the step block's list, the number `--gate` takes, as in `<step>-gate<g>-round-<n>.json`.
Before this numbering, fuse-flow counted only the reviews, so `-gate<k>` was the k-th review of the
step. In a step with a check, script or child workstream before two or more reviews, a review that
was running during the upgrade therefore has findings files under its old number, which can be the
new number of another review: with a check and two reviews, the old `-gate2` was the second review
and is now the first. Before resuming such a step, rename each old file from the k-th review's
old number to the number the step block prints for that review, starting with the highest, so no
file is overwritten. A row of `reviewers` may carry its own `launch`, for a reviewer model the
author's harness cannot run. `rulings` are the owner's decisions where fuse-flow and the house rules,
such as another installed skill or always-on instruction, overlap; fuse-flow prints them with every step.

The complete override order, from general to specific, is: engine and package defaults, user
policy, workflow and gates, project policy, project-local policy, workstream state, then the
owner's recorded decision for approval, added rounds or a jump. In the implemented fields, project
and local policy override workflow values where defined. Check bindings and the reviewer use local,
project, then user policy; so do `launch`, while `reviewers` merges by author model and `rulings`
from every file apply. Artifact paths use local or project policy, then the workflow; a workflow
always gives each artifact a path, so user policy may not set `artifacts` and is refused when it
does. Review `max_rounds` uses local or project policy, then
the gate, then user policy, then the engine default. A review guide uses local or project policy,
the project's artifact `review.md`, the gate's `guide`, user policy, then the user and package
artifact review guides. Only the guide that applies is checked: a command refuses when it is not
a file, and a guide it replaces may be missing.

### Decisions

`.konductor/decisions/<slug>.md` is where the agent records, as it works, every decision it made
on its own judgement that the owner could object to. The `decision-log` guide in the artifact
library gives the entry format, what counts as a decision, the owner's four responses (accept,
comment inline, ask for changes in chat, or walk through the decisions one at a time) and how the
agent closes a reviewed section. The directory is gitignored, so the owner's inline comments stay
in this checkout. fuse-flow creates the directory and prints the path, but never reads the file:
it decides when to print the `DECISIONS:` line from the workstream histories alone. The line
appears when the latest finished stretch of the agent's work (a step completed, waiting for the
owner, or blocked) is later than the owner's latest review, that is the latest decision the owner
took on a step that was waiting for the owner or blocked. A decision taken while a step is still
in progress, such as review rounds granted ahead of time, is not a review. For a delegated
workstream, at any depth, a review in it or in any workstream above it counts.

### Workstream state

`.konductor/workstreams/<slug>.yml` records the workflow reference (a name; a path relative to the
repository root for a workflow file inside it, so the workstream survives a move of the checkout;
else an absolute path, as in state files written before), each step's
state, artifacts, reported files and reasons, verification, granted rounds, skip reason and
timestamped history. A recorded workflow file that is gone, as after a move of the checkout or a
rename, is refused, never guessed; `start <slug> --workflow <its new path>` then moves the
workstream to that file, with the steps it has done. It
also records the workstream it was started after (`after`), its parent workstream and step
(`parent`), the inputs bound when it started (`inputs`), each delegating step's child per
pass (`children`), and its base (`base`): the commit HEAD was at when it started, with its
subject. An agent gate tells the reviewer that code changes are those since the base. When a
rebase or squash has rewritten the base, fuse-flow finds it by its subject, written before the
workstream started and, while git still has the recorded commit, by the same author at the same
time; a subject that several such commits share does not decide then. When several commits still
match, as a cherry-pick in the same second can make them, the one with the recorded commit's
patch is the base, else the oldest of them. Else it uses the newest
commit made before the workstream started, else the first commit of the history, and says which;
outside a git repository there is no base, and nothing is refused.
Only fuse-flow writes it. The directory is gitignored.

## Rules

- **Order.** Steps run one at a time in file order. There is no parallel execution.
- **States.** `PENDING` has not been handed out. `IN_PROGRESS` is with the agent.
  `AWAITING_OWNER` has finished work waiting on an owner action. `BLOCKED` means the planned path
  broke down. `COMPLETED` and `SKIPPED` are terminal; a skipped step records `skip_reason`.
- **Artifacts.** Recorded artifacts are `draft` while an owner action waits, the step is blocked
  or the work was sent back. A step without an owner gate records them as `done` when it
  completes: its gates passed, but no owner approved them. They are `approved` once the owner
  approves the step, or the next later step with an owner gate, which approves the work of the
  steps without an owner gate before it too. State files written by earlier fuse-flow versions
  record `approved` also for steps without an owner gate, and are read as they are. Sending work
  back makes `done` and `approved` artifacts draft again. `superseded` is available for a later
  artifact replacement process.
- **Refusals.** A missing unreported `produces` artifact, an unaccounted `updates` artifact, an
  unbound check, or a failed mechanical gate refuses `continue` and repeats the step block. The
  refusal is recorded but does not block the step or consume a review round. A `continue` whose
  step was sent back while its checks ran records nothing, refusal or results, in the new pass.
- **Review cap.** The maker classifies each finding as a required fix, optional or a false
  positive, fixes the required ones and repeats until a round ends with no required fix. Unless the
  review guide says otherwise, P0 and P1 findings are required and P2 and P3 findings optional,
  fixed when cheap or listed as deferred. A round with no required fix passes and ends the review;
  fixing its optional findings starts no further round. A round ending with a required fix counts. At the printed cap, the maker reports the step
  blocked rather than starting another round. The owner can approve as is, grant rounds or send
  work back.
- **Jumps.** `--from`, `--forward-to`, `--back-to`, and skipping a mandatory step are owner
  decisions. After a jump, the agent restores missing consumed artifacts in the owner's interest
  and reports what it did.
- **Concurrency.** Mechanical commands run outside the state-file lock. If two commands try to
  advance the same workstream, only the first successful state update records the step.

## What fuse-flow does not try to do

fuse-flow tracks one engineer's workstream on one machine. It is not a security boundary.

- `continue` acts on the current step and has no step identifier. Run it once per step. The history
  makes replays visible.
- Commands in `script` gates and policy-bound checks run like Makefile targets from the repository
  root with the caller's environment, plus `FUSE_FLOW_SLUG` and `FUSE_FLOW_STEP`. Use only trusted workflows and policy files.
- Owner-decision flags record the owner's word. They do not authenticate who typed it, so the agent
  runs them only after the owner decides.
- The engine does not create templates, infer check commands, count review rounds, compare file
  contents, or choose jumps.
- There are no parallel branches, path-choice constructs, workflow parameters, per-item loops or
  reusable gate library entries. One workflow never runs inside another; workstreams only refer
  to each other, and only documents pass between them. The engine does not start one workstream
  per item of a list.

## Code

| File | Contents |
|---|---|
| `src/cli.ts` | Argument parsing, usage, printing and exit codes. |
| `src/commands.ts` | Command behavior and output blocks. Start here. |
| `src/workflow.ts` | Workflow loading and gate descriptions. |
| `src/workstream.ts` | State-file reading and locked updates. |
| `src/links.ts` | Hand-offs and delegation: child slugs, documents across workstreams, cycle and cross-file checks. |
| `src/schemas/workflow.ts` | Workflow schema and cross-step validation. |
| `src/schemas/step.ts` | Step and artifact schema. |
| `src/schemas/gate.ts` | Gate and condition schema. |
| `src/schemas/policy.ts` | Policy override schema. |
| `src/schemas/workstream.ts` | Workstream state schema and migration. |
| `src/schemas/generate.ts` | JSON Schema generation. |
| `src/policy.ts` | Policy layering, artifact placement, library lookup and review guides. |
| `src/project.ts` | Repository root, workflow lookup and `.konductor/` paths. |
| `src/errors.ts` | Refusal and usage errors. |
| `fuse-flow` | Runtime launcher for Bun or Node. |

Tests: `bun test` in this directory. Each test runs the real command line in a throwaway repository.
