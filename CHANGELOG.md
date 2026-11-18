# Changelog

All notable changes to Fuse-Konductor are documented here. Fuse-Konductor is a fork of
[Konductor](https://github.com/aws-solutions/konductor) 1.0.0, developed on the `fuse` branch.
The 1.0.0 entry at the bottom is Konductor's own release, the starting point of the fork.

This changelog follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Entries describe what changed since the
previous release, not each commit.

## [Unreleased]

Fuse-Konductor keeps Konductor's skills and the guidance in them, and replaces the machinery around
them. Instead of specialist agents coordinated by orchestrators, your harness's default agent runs
a workflow step by step with fuse-flow, a small engine that tracks the steps, artifacts and gates of
each piece of work. Instead of a compiled installer that generates output per harness, a shell
script installs plain skills and an always-on instruction block that every supported harness reads.

### Added

- **fuse-flow,** in `fuse/flow/`, a workflow engine that runs on Bun, or on Node 22.18 or later
  with npm, with no build step. It installs its two dependencies, zod and yaml, on first use.
  - A workflow is a YAML file of ordered steps. Each step has an instruction, the artifacts it
    consumes, produces or updates, an optional condition, and gates: checks and scripts, agent
    reviews with a round cap, and owner actions. JSON schemas in `fuse/flow/workflows/schemas/`
    give editors completion and validation.
  - A workstream is one piece of work following one workflow. Its state lives in the project's
    `.konductor/workstreams/`, so work resumes in a later session. Steps have six states, from
    `PENDING` to `COMPLETED` or `SKIPPED`.
  - Commands: `start` creates or resumes a workstream; `continue` finishes the current step and
    records the agent's artifact reports and the owner's decisions (approve, more review rounds,
    back to an earlier step, forward, skip); `status`, `list` and `validate`; `rename`, which moves
    a workstream's files to a new slug while its documents keep their paths; `close`, with
    which the owner gives a workstream up, with a reason; and `check`, which runs the current
    step's checks and scripts the way `continue` does and prints each one's exit status, the tail
    of its output and any lines that read as failing tests, without changing the workstream.
  - `start` warns when it mints a workstream in a checkout with uncommitted changes outside
    `.konductor/` or on the branch a remote's HEAD points to; a policy's `checkout: refuse` turns
    the warning into a refusal. The README describes how to move a workstream to another checkout.
  - The engine refuses to complete a step while a required artifact is missing without a reason
    or a check fails. It hands over to the owner at owner gates and when a review reaches its
    round cap, with the owner's options in plain words. When a check exits 0 but its output
    reads as failing tests, the check still counts as passed, and a `WARNING:` line in the
    agent's output and in the owner's hand-over names the line, so a check command whose pipe
    or wrapper hides a failure is noticed.
  - At a review's round cap, the agent makes the last round's fixes and starts no further round
    of that review. When the step ends at an owner gate, the agent runs the step's remaining
    reviews, finishes the step and names each fix no reviewer has seen in the hand-over's
    VERIFICATION line, so the owner decides there; only a step without an owner gate is reported
    blocked. The agent does not ask the owner for more rounds.
  - `continue` also refuses a step with an agent review until the reviewer has written a
    findings file for the step's current pass, under the name the step block prints. A review
    the owner waives is passed over with `continue --waived "<reason>"`, which records the
    waiver and its reason in the state file and the hand-over. The maker classifies each review
    finding as a required fix, optional or a false positive. Unless the review guide says
    otherwise, a checked P0 or P1 is required and a P2 or P3 optional, fixed when cheap or listed
    as deferred; a round with no required fix passes, and fixing its optional findings starts no
    further round.
  - Each review's cost stays visible across send-backs: `status`, the step block and the
    hand-over count its reviewer launches and rounds over every pass from the findings files.
    Several reviewers of one round each write their own findings file, with the reviewer's name,
    and count as one round. `continue --more-rounds <n> --gate <n>` grants rounds to one review
    alone. The review guide treats a finding that asks for more detail in text the previous
    round's fixes added as a P2, so a document review converges. A launch command must return
    once the findings are written; `fuse/flow/workflows/schemas/launch-once.sh` is an example
    wrapper that makes any agent task's command return once its output file is written.
  - The review guide, `fuse/flow/workflows/fuse/review.md`, opens with the sections a reviewer
    reads. A document reviewer runs at low reasoning effort and a code reviewer at the author's
    effort, or `medium` when the author runs `low`, unless the step or the house rules name
    another; every reviewer reports findings rather than rewrites and keeps the whole artifact
    in scope, and from the second round starts from the diff since the last reviewed round. A
    document review asks whether each mechanism, field, prerequisite or rule is needed for the
    owner's request, and a finding that asks to complete one the request does not need is at
    most a P2; examples separate a P1 from a P2. The author hands the reviewer the changed files,
    the existing code the artifact relies on and the proof commands, without conclusions, and
    puts a finding that a rule rests on an unchecked assumption, or that a prerequisite lies
    outside the repository, to the owner at the next gate. The policy examples leave the
    reviewer's effort unset, so the guide decides.
  - The labelled lines of a hand-over print as Markdown list items, so a chat that renders
    Markdown shows each on its own line. A line another rule requires at the start of the message
    goes first, before the agent's own text and the block, and a report another rule asks for,
    such as the debug-mode report, may follow the block.
  - A file a step without an owner gate records is `done`, and becomes `approved` only at a
    later owner gate that approves it.
  - When the workflow of a running workstream is edited, an owner's acceptance or block of a
    review holds only while that review is unchanged: its number, its text, and the content of
    each guide it follows. Otherwise the review runs again. The owner's approval is refused while
    a gate the edit added has not run on the work, and a workflow file that has gone is refused
    rather than replaced by a guess.
  - Where a step's instruction and an artifact's guide disagree, the step block says the
    instruction wins over a guide that ships with fuse, and asks the agent to name each
    disagreement; the review request tells the reviewer the same. A guide from the project's or
    the owner's own library or policy is a house rule instead: the agent follows the owner's
    ruling, else the guide when it clearly applies, and asks when it is unclear.
  - A review gate's reviewer gets every guide that applies to each artifact it reviews: the
    artifact's guide as the definition of a good artifact, its review guide from the library entry
    that wins, and the gate's guide, so a gate's guide no longer hides an artifact's criteria. A
    team's or local policy's `review.guide` replaces only the gate's guide. Every applied guide
    is part of the review's identity, so editing any of them, an authoring guide included, makes a
    passed or accepted review run again.
  - When the owner sends work back, from the current step in any status, the files the steps
    wrote stay recorded as draft and each reopened step's next pass lists them to keep, update or
    redo. Review rounds count per pass, with the pass in the findings file names from the second
    pass on. `status` shows each file once, under the latest step that records it. A produced
    folder that existed before the step, such as a shared research folder, is recorded file by
    file from the files the agent names. After a rebase that only resolved conflicts, the owner
    can `--forward-to` past the steps whose results still hold, with a note naming the evidence.
    In a workflow with agent reviews, the owner's send-back option asks whether the changes need
    another agent review; when the owner says they do not, the agent makes them, runs the checks
    and finishes the step with `--waived "<the owner's words>"`, and changes beyond the owner's
    notes are reviewed anyway. The next pass prints the owner's notes with an instruction to
    apply each one everywhere it occurs, in documents, names, messages, code and tests, and to
    say in the hand-over where each was applied.
  - A later step may change a document an earlier step produced, such as the requirements, with
    the owner's agreement. The step block's `AMENDING EARLIER WORK` line says how, and `status`
    shows the document as amended by that step.
  - Workflows can work together while each workstream stays one flat list of steps. A workflow
    declares the documents it expects from outside as `inputs`, and the workflows that may come
    next as `hands_off_to`. `start --after <slug>` binds the inputs to an earlier workstream's
    documents, and `start --input <id>=<path>` binds one to a file. The completion block offers
    each next workflow with its start command, and starts nothing on its own. A `workflow` gate
    makes a step wait for a child workstream: fuse-flow creates the child with its inputs bound,
    refuses the step until the child is complete, and lets later steps read the documents the
    gate lists in `returns`. After a send-back, the next pass gets a fresh child, and the earlier
    one stays as history. `validate` checks these references across workflow files, including
    loops of workflows waiting for each other. Komposer shows hand-offs and workflow gates as
    links to the target workflow, and links each run to the runs it came from or waits for.
  - `for_each: <folder artifact>` on a workflow gate makes the step wait for one child workstream
    per file in the folder, each given its own file as an input. The `DELEGATE` line names every
    child with its item, `continue` waits until all are complete, and later steps read one
    returned document per child, labelled with its item.
  - A child workstream ends as succeeded or failed; its agent declares a failure with `finish`.
    On a `for_each` gate, `rerun: failed` gives new children only to the items that failed when
    the owner sends the work back, and carries the others over; the owner can name the items with
    `--rerun`. `retries: <n>` lets fuse-flow re-run failed items itself, handing each new child the
    previous attempt's document. `accept: succeeded` holds the step while any child failed.
  - A workstream records its base, the commit HEAD was at when it started, with that commit's
    subject. Agent reviews of code cover the changes since the base, so they work on any
    branching strategy, including on the integration branch itself. After a rebase or squash
    rewrites the base, fuse-flow finds it again by its subject, or else uses the newest commit
    made before the workstream started, or the first commit of the history; it never refuses for
    want of a base. `start` and `status` show it.
  - Workflows are found by name in the project's `.konductor/workflows/`, then
    `~/.konductor/workflows/`, then the shipped ones, at any folder depth, so personal and team
    workflows can sit in their own folders or symlinked repositories.
  - An artifact library in `fuse/flow/library/artifacts/` holds a guide for each kind of
    document, often with a template and a review guide, for requirements, user stories, designs,
    specs, feature splits, implementation plans, research notes, test coverage, a project's
    glossary and more. A project or a user can override any entry. The `code` entry's guide is the
    `testing-strategy` skill, so every step and review of code gets the test levels, and its
    review guide rates a behavior change the spec does not ask for as P1. The test-coverage and
    Kiro design guides judge each test by the lowest level that can show its behavior, instead of
    mocked dependencies and percentage targets per architecture. The feature-spec guide asks for
    each acceptance test's level, repeat-run and failure-recovery tests for behavior that repeats,
    retries or reconciles, the existing mechanism checked for each new one, and each claim about
    another service or library marked as checked or unchecked; its review guide makes a published
    contract changed without a compatibility plan a P1 finding.
  - Policy files (`~/.konductor/policy-overrides.yml`, the project's `.konductor/policy-overrides.yml`
    and `.konductor/policy-overrides.local.yml`) set check commands, artifact paths, the reviewer
    model for each author model and how the reviewer is launched, and the owner's standing
    rulings, which every step block prints. Reviewers write findings as JSON to
    `.konductor/reviews/`. fuse-flow keeps the local policy file out of git through the
    checkout's own exclude file, so it adds no file to the project, and reports a project rule
    that still un-ignores it.
  - A step runs attended or unattended, set with `mode` and attended when it is not set. The step
    block's `MODE` line tells the agent to ask the owner often, or to decide on its own judgement,
    and tells the owner whether to stay. In both, the agent records the decisions it makes on its
    own in `.konductor/decisions/<slug>.md`, following the `decision-log` guide. Hand-over and
    completion blocks gain a `DECISIONS:` line whenever finished work, in the workstream or in any
    workstream it delegated to, has not been reviewed, with four ways for the owner to respond.
    The shipped fuse workflows mark the steps that work alone as unattended, and Komposer shows
    and sets the mode as the Autonomy Mode. A step card shows the mode as glyphs, an owner and an
    agent for attended and the agent alone for unattended, and gate pills carry the same owner and
    agent glyphs, with a cog for checks and scripts.
  - Loop gates: any owner-action, check, script or agent gate with `repeat_from` repeats the
    steps from there to its own step, cycle after cycle, until it passes, without an owner
    decision per cycle. A check or script decides by its exit code; at an agent loop gate the
    agent runs `continue --again`, at an owner-action one the owner does. `interval` is printed as
    the wait before each later cycle, which the agent does with its harness's own tools; fuse-flow
    keeps no clock. `max_cycles` blocks the step at the cap, and the owner grants more cycles with
    `--more-cycles`. Komposer edits the three fields and keeps `repeat_from` when a step is
    renamed.
  - An agent gate names what an agent judges. Without a guide it is an independent review, as
    before; a guide whose front matter says `judged_by: working-agent` hands the judgement to the
    agent that did the work, with no reviewer and no policy review guide in its place.
- **Shipped workflows:**
  - `fuse-feature-development`, one feature in an existing codebase: intake, design,
    implementation and code review, with agent reviews before the owner approves the spec and
    lands the work. Intake names the workstream and its files once the owner has confirmed the
    domain terms, and renames them at the first term correction. The design step binds the check
    command in the local policy file, offering the team file when the team should share it; the
    delivered spec states the current result, with resolved questions, approvals and review
    history in the decision log; and the hand-over recommends compacting or clearing the
    conversation before each entry into the build. The implementation step proves that a test
    check fails by breaking one acceptance test and restoring it, treats a test that passes and
    fails on the same code as a defect to fix rather than rerun or loosen, and runs the checks
    with `fuse-flow check` or cuts test output to the summary and the failures. The code review
    leaves fuse's files under `.konductor/` out of the commits unless the owner asked for them,
    and never edits the project's ignore files to hide them. The design step plans each test at
    the lowest level that can show its behavior; researches the limits, throttling and failure
    states of each system the feature calls, tracing its source where available and treating a
    checkout of it next to the project as a request to review it; keeps the project's terms in
    its glossary; and puts a compatibility plan for each published contract the feature changes
    to the owner in the spec. The implementation step keeps the behavior of shared code's existing
    callers, shown by a control test, and commits changes the spec does not need separately or
    asks first. The shipped workflows leave branching to the project's own rules: when there
    are none and the checkout is on the integration branch, the agent asks the owner once whether
    to create a branch.
  - `fuse-pull-request`, a change through the project's pull request or code review process, the
    way the project runs it, for one pull request or a set of them: open them or take the ones the
    owner names, agree once on how much the agent may do, then poll them all about every 15
    minutes in a loop, fix what that level allows behind a check and an agent review, reply, and
    end with a report of what merged and what is blocked. Every cycle ends with a one-line status
    of the set; a pull request that becomes blocked is reported to the owner at once, and quiet
    ones are polled less often and count as stalled after about three days. A pull request
    ledger in `.konductor/pull-requests/` keeps the loop's state.
    `fuse-feature-development` offers a pull request at its last gate only where the house rules,
    the project's history or the agent's memory show such a process, and hands off to it when the
    owner approves the work for one; it can also be started on its own. The change may be on a
    feature branch, a fixed branch per worktree or the integration branch itself.
  - `fuse-system-development`, a new system or a module with its own architecture: intake,
    requirements, optional prototypes, a system design with a principal engineer review
    rehearsal by an agent, and a build order whose features are then built with
    `fuse-feature-development`. The owner approves the prototype findings or sends the work back
    to the requirements. The owner approves the design, or answers its open questions, before the
    build order is written; the design step may run a small experiment the owner agrees to, and
    researches the limits and failure states of each system the design calls.
  - `fuse-dependency-migration`, a migration or refactoring that must keep the behavior: catalogue
    the checks, add missing ones, record a baseline, migrate in increments and compare.
  - `fuse-rapid-prototyping`, a new product idea explored as a runnable prototype: a short
    interview, many small build-and-feedback iterations with no code review loop, and a product
    brief of what to build that `fuse-system-development` can take up.
  - `fuse-bug-bash`, a time-boxed bug bash: intake, which assesses the test tooling, an optional
    `fuse-feature-development` child workstream that builds missing tooling first, a catalogue of
    the existing checks, a discovery wave of independent agents with different lenses and models,
    and, in a fixing run, reviewed fixes, a confirmation wave and a rewrite of the fix commits
    into one commit per behaviour, ending in a report. When the limits end the run with findings
    open, the report makes the case for a second pass. Its library entries `bug-bash-plan`,
    `bug-bash-findings` and `bug-bash-report` hold the method.
  - `fuse-usability-review`, a time-boxed review of a frontend's user interaction design for a
    named audience: intake of the audience profile and core tasks, an optional
    `fuse-feature-development` child workstream that builds the tooling agents need to run the
    app, an inventory of every screen and control, blind agents that walk the running app without
    the code next to informed agents that check the code and the house rules, owner triage by
    root cause, and a report with step counts, recommended fixes and redesign proposals. It
    reports and never fixes, and offers no hand-off. Its library entries `usability-review-plan`,
    `usability-review-findings` and `usability-review-report` hold the method.
  - `fuse-rapid-prototyping`, `fuse-system-development` and `fuse-feature-development` hand off
    to each other: rapid prototyping to system or feature development, and system development to
    one feature workstream per entry of its build order, which receives the product brief,
    requirements, design and build order as inputs.
  - In `workflows/konductor/`: `_k-full-sdlc` and `_k-phase-chain`, Konductor's full lifecycle
    pass and lighter phase chain, and one workflow per remaining Konductor SOP, named after it with
    a `k-sop-` prefix, so they sort together, such as `k-sop-design-doc-creation` and
    `k-sop-code-review-workflow`. Duties
    the SOPs took on for the skills they loaded, such as credentials, the owner's confirmation and
    cleanup around `app-discovery`, are steps and gates of these workflows.
  - Additional sample workflows demonstrated ways to shape fuse to a project.
  - The workflows in `workflows/fuse/` take acceptance tests from the spec, start every bug fix with a
    failing reproduction, and have the reviewer check the tests against the spec, instead of
    forcing test-first on every change. Specs are saved under date-prefixed paths in
    `docs/specs/`.
- **Komposer,** in `fuse/komposer/`, a local web editor for workflows. It shows a workflow as a
  diagram, edits it without losing the file's comments and layout, browses the artifact library,
  and shows the runs of a project's workstreams. It keeps unsaved edits as a working copy, warns
  before a save affects a running workstream, follows the system's light or dark theme, and
  serves only to 127.0.0.1 behind a token. Its Review in effect box lists every guide an agent
  gate's reviewer gets for each artifact, with where each comes from.
  - It refuses to save a workflow that fuse-flow would refuse, judges every read and write by the
    real path it leads to, and lists workflows, workstreams and their states as fuse-flow reads
    them.
  - Edits survive two tabs on the same workflow, switching workflows, reloading and changes on
    disk; the editor takes no edits while a confirmed save writes the file.
  - A link followed from another project's workstream keeps resolving names in that project, on
    every page.
  - Its tooltips open quickly on hover, at once on click or keyboard focus, and look the same
    everywhere.
  - The address names the page and the selected workflow, so back and forward move between them
    and a link opens the same view.
  - A workflow gate's `for_each`, `accept`, `rerun`, `rerun_override` and `retries` are shown and
    edited in Komposer. A for-each gate is marked on every diagram with a layers glyph and a
    `for-each <folder>` chip, and the folder's consumes chip carries the same glyph. The step
    inspector switches a gate between one child and one per item of a folder, edits its inputs, and
    sets what lets the step complete and how failed items are re-run. Compare keeps these settings
    and shows them, and a for-each run shows as waiting until every child of the pass is complete.
- **Skills:**
  - `fuse-workstream`: finds a workstream to resume, recommends a workflow for new work, starts it
    once the user agrees, and runs it, keeping fuse-flow's commands out of what the owner reads.
    It applies each owner correction everywhere it occurs, renames a workstream after a term
    correction, recommends a fresh or compacted conversation before each entry into
    implementation, and reads several files or line ranges per call during research. Its opt-in
    debug mode ends every reply with a report of what fuse did.
  - `fuse-flow-builder`: builds or changes a workflow with the user, by interview, by encoding an
    existing process, or together in Komposer, following fuse's principles for workflows.
  - `fuse-tutorial`: a coach for new users. Started in the clone before anything is installed, it
    installs Fuse-Konductor with the user after checking their harnesses and conflicting skills or
    instructions, explains the repository, and teaches hands-on: choosing a workflow, working on a
    real project, building a greenfield demo project, or shaping a workflow to how the user works.
  - `testing-strategy`: the test levels fuse workflows use, defined by what runs for real (type
    check, unit, component, external-system and end-to-end), with the rules that no test replaces
    the project's own code with a test double and that each test sits at the lowest level that can
    show its behavior. It yields to a project's established testing conventions.
  - `aws-mcp-usage`: confirmation rules for AWS MCP tools that act on an account, and which AWS
    guidance to load for common tasks, taken from the removed architect and developer agents.
- **The always-on block** `AGENTS.fuse.md`, which `install.sh` writes into instruction files. It
  says when fuse applies, the rules that hold while a workstream runs, and how to write for the
  owner. While a workstream runs, a turn ends only with a block fuse-flow printed (the owner's
  turn, the stop lines, or the end of the workflow), and the agent writes no text between tool
  calls, since some harnesses join a turn's messages into one. On writing for the owner, it
  asks for self-explaining headings, decisions and commit messages, without bare labels such as
  `D1`.
  It defines house rules: the project's and the harness's agent instructions, the owner's earlier
  rulings, what the agent remembers of the project, and what the project's history shows. Where
  a step says in prose how to do something a house rule covers, such as branching, getting a
  change reviewed, starting a reviewer or keeping decision records, fuse does not win by default:
  the agent follows the owner's ruling, else the house rule when it clearly applies, and asks when
  it is unclear. A value set in a fuse-flow policy file is the deterministic form and always wins;
  without one, the step block's default defers to the house rules, as for how a reviewer is
  started. A session that a script, a command or another agent starts for one self-contained task,
  such as a review, ignores the block; a session that relays the user's messages follows it. When the clone is not where the block says, the agent tells the user.
- **`install.sh` and `INSTALL.md`.** `--project <dir>` copies the skills into the project's
  `.agents/skills/`, links `.claude/skills` and `.kiro/skills` to it, and adds the block to the
  project's `AGENTS.md`, for the team to commit. `--global <file>...` adds the block to each
  harness's user-level instruction file and copies the skills next to it; `--link` links them into
  the clone instead, for people who edit the skills. `--uninstall` reverses either. The script
  changes only what it installed and keeps the rest of each instruction file byte for byte.
  Every install prints the clone's commit, and names uncommitted changes, so an install from an
  outdated checkout is noticed; a project install records the commit in the project's manifest.
  Supported harnesses: Claude Code, Codex, Cursor (project install only), OpenCode and Kiro CLI.
  `INSTALL.md` recommends starting at low reasoning effort and never running a workstream at
  `max` or `xhigh`, and compacting the conversation at about 300,000 tokens for models with a
  window of a million tokens, with OpenCode's `limit.input` setting as the example.
- A smoke-test harness in `fuse/smoke/`: an orchestrating agent plays the user, has a separate
  fuse agent build a trivial program with a workflow, and judges whether an engineer who knows
  nothing about fuse-flow could get through it.
- `docs/GLOSSARY.md`, including the scope terms prohibited, deferred and out of scope.
- A step's `guides:` lists the guides its instruction tells the agent to use: library guides such
  as `design/review.md`, looked up with the project's own library first, and files next to the
  workflow such as `./k-backend-review.md`, written as a gate's `guide:` is. The step block prints
  each absolute path with the same precedence note artifact guides get, and `fuse-flow validate`
  and Komposer's saves refuse a guide that names no file. The shipped workflows name their guides
  this way instead of writing paths into instructions. Komposer lists a step's guides read-only
  and keeps them through saving, Save as new and Compare.

### Changed

- **Installation uses a shell script instead of a compiled installer.** Most of Fuse-Konductor's
  value comes from teams that fork it and change the skills and rules to their own conventions.
  With a binary, each such change reaches engineers only after the fork runs a release pipeline,
  which most forks will not maintain. With the script, a change needs no release: a project install
  is committed and shared with `git pull`, and a global install picks up a change when the user
  pulls the clone and runs the script again. What is given up is the checksummed binary download;
  a clone over an authenticated connection and a script short enough to read take its place.
  Revisit this if forks become rare.
- **The running agent does the work** that SOPs and skills used to delegate to specialist agents,
  with generic subagents or separate passes where independence matters.
- Skill descriptions open with when to use the skill, and the prose in skills and SOPs is
  rewritten in plain language.
- `fuse-feature-development`'s implementation step ends with a completeness check: the hand-over
  lists each of the spec's requirements and acceptance criteria as done, with the test or file
  that shows it, or as not done, with the reason, so a quietly dropped requirement is visible.
- `README.md` describes Konductor and Fuse-Konductor, starts new users with the tutorial, and links
  the workflows, Komposer and the skills.
- All pull requests target `fuse`, whose history stays linear.

### Removed

- All 11 agent specs, including the three orchestrators, and the layer that only routed work to
  them: the `delegation-protocol`, `claude-teams-behavior`, `mux-dispatch`, `cmux-dispatch` and
  `sdlc-navigator` skills, the `k-delegate` SOP and the orchestrator routing rules.
- The `konductor` command line tool, its per-harness synthesis, release pipeline, bootstrap
  installers and telemetry. Fuse-Konductor collects no data.
- The `skill-lookup` MCP server.
- The `legacy-to-agentic-estimate` skill.
- The `about-konductor` skill and SOP, whose onboarding the `fuse-tutorial` skill now covers.
- The `task-decomposition` and `user-story-writing` skills. Their instructions are now the
  `feature-split` and `user-stories` guides in the artifact library.
- The `plan-review` skill. No workflow reviews an implementation plan with an agent, and the
  `implementation-plan` guide's self-review covers its core checks: spec coverage, ambiguous steps
  and consistency between tasks.
- The `design-doc-guidelines`, `design-evaluation` and `design-quality-check` skills. The first is
  now the `design` guide in the artifact library; the other two together are its review guide,
  one part for writing quality and one for production readiness.
- The `workspace-skills` skill. It wrote agent-created skills into `.kiro/skills` and
  `.claude/skills`, which in a project install `install.sh` manages.
- The `git-workflow` skill. Only the `_k-full-sdlc` implementation step used it; its commit and
  branch rules are now `fuse/flow/workflows/konductor/k-git-workflow.md`, which that step names.
- The `pre-planning-analysis` and `test-coverage-analysis` skills. The `task-doc` and
  `test-coverage` guides in the artifact library, which linked to them, are now short guides of
  their own; the test coverage guide keeps the coverage procedure and report and drops the
  release-readiness mode, which no workflow used.
- The `architecture-advisor` skill. Answering a quick architecture question needs no skill.
- The `adr-generator`, `program-decision-docs` and `decision-research` skills. The
  `decision-record` guide in the artifact library now covers them as sections: research before
  deciding, ADRs, and program decision documents. It also follows a project's existing
  decision-record convention when there is one. Checking the factual claims of research and
  decision evidence moved to `doc-accuracy-analyzer`.
- The `adversarial-code-review-pass-security`, `-integrity` and `-schema` skills, now the three
  lenses of `fuse/flow/workflows/konductor/k-adversarial-code-review.md`, which runs them in one
  pass or as separate single-lens passes.
- The `argumentation-reference`, `dom-inspection` and `smithy-validation` skills, now files next to
  the guides in the artifact library that use them: `design/argumentation-reference.md`,
  `discovery-report/dom-inspection.md`, and `api-model/review.md`, the review guide of the
  `api-model` guide.
- The `backend-development` and `frontend-development` skills. Their standards are now in
  `k-backend-review.md` and `k-frontend-review.md` in `fuse/flow/workflows/konductor/`, one set of
  standards per side for writing and for reviewing code.
- The `sop-state-management`, `progress-tracking` and `requirements-extraction` skills.
  fuse-flow keeps each workstream's state, which the first served for the SOPs; nothing used the
  second; and the requirements guide in the artifact library replaces the third's design handoff
  files.
- The project-management skills `program-planning`, `sprint-planning`, `asana-sprint-planning`,
  `status-reporting` and `risk-management`, with the Asana setup guide
  `docs/guides/asana-integration.md`, and the `security-remediation` skill. They are outside
  Fuse-Konductor's scope and no workflow or skill used them.
- The `constraints` skill, which claimed to be active in every interaction of the removed
  agents, and the `git-merge` skill, whose merge commits contradict the linear history that
  Fuse-Konductor's own branches keep.
- The `k-code-simplifier` skill, formerly `asdlc-code-simplifier`: general cleanup advice that no
  workflow, guide or other skill used.
- The `cypress-test-implementation`, `historical-issues-registry` and `document-formats` skills.
  The first was a 1,900-line Cypress planning template that no workflow used; Playwright stays as
  the end-to-end implementation skill. The second was an abstract filter that needed a platform
  mapping Fuse-Konductor never shipped, so its only caller always skipped it. The third listed
  basic Pandoc commands and had no caller.
- The `ui-text-validation`, `security-test-generation` and `non-functional-requirements` skills.
  The first two are now guides next to the test coverage guide in the artifact library,
  `ui-text.md` and `security-tests.md`, for the report sections the `_k-` workflows' test steps
  ask for; the security guide is cut from about 740 lines to the plan and its gaps. The third's
  measurable forms of quality requirements are now part of the requirements guide.
- Eleven skills that produce one kind of artifact. Each is now a guide in the artifact library,
  where a workflow step that produces the artifact reads it, and an agent asked for one such
  document offers it:
  - `threat-modeling` is the `threat-model` guide, and `decision-writing` the `decision-record`
    guide, with its modes as sections.
  - `system-design-patterns` is `interview.md` next to the `design` guide, and
    `adversarial-design-review` is `adversarial-review.md` there, with its argumentation reference.
    The adversarial review uses the deliberation panel only with the owner's explicit consent: a
    calling workflow asks the owner and passes the answer, missing or unclear consent means the
    single-voice review, and used on its own the review asks once before the first round.
  - `smithy-modeling` is the `api-model` guide, with its review guide and a Smithy reference.
  - `agents-md-authoring` is the `agents-md` guide.
  - The three `kiro-*-generation` skills are the `kiro-requirements`, `kiro-design` and
    `kiro-tasks` guides. The step's artifact path decides where each file goes.
  - `e2e-test-strategy` is the `e2e-test-strategy` guide, cut from about 1,600 lines to 350.
  - `app-discovery` is the `discovery-report` guide, with `dom-inspection.md` next to it. Used on
    its own, it now asks for credentials and confirmation itself and cleans up after itself.

  Steps that use one of these as a check inside another artifact, such as a threat model's checks
  in a design, name the guide's path in their instruction.
- The `code-review` skill, with the `backend-review`, `frontend-review` and
  `adversarial-code-review` skills it had absorbed. Its review checklist is now the `code`
  artifact's review guide in the artifact library, `code/review.md`, in the P0 to P3 priorities of
  the other review guides. The backend and frontend standards and the adversarial second pass are
  `k-backend-review.md`, `k-frontend-review.md` and `k-adversarial-code-review.md` in
  `fuse/flow/workflows/konductor/`, which the Konductor review workflows that use them name. Its
  GitHub pull request steps, its own review loop and its pull request description rules are gone:
  `fuse-pull-request` takes a change through the project's own review process, and the workflows'
  review gates replace the loop.
- The `aws-service-validator` skill, now `aws.md`, the AWS check of `doc-accuracy-analyzer`.
- The `find-aws-skills` skill, now the search-and-load part of `aws-mcp-usage`.
- The `infra-validation` skill, now `k-infra-review.md` in `fuse/flow/workflows/konductor/`, the
  infrastructure lens of `k-sop-code-review-workflow`.
- The `cost-estimation`, `dynamodb-design`, `dynamodb-validation`, `external-research`,
  `humanize-writing`, `iam-policy-design`, `policy-validation` and `trade-off-evaluator` skills.
  In with-skill and without-skill runs on realistic tasks, a current frontier model did as well
  or better without each of them, and each made a run cost more. Most of their content is what
  such a model already does; the rest was scripted interaction (menus, mandatory scenarios,
  numeric scores) that padded the result, or facts that were wrong or out of date, such as
  service limits and prices. The design, decision-record and design-doc steps that named them
  now state what they need directly.
- The `verification` skill. Its two rules that a model does not follow by default, starting a bug
  fix with a failing reproduction and showing that each new test can fail, are now rules of
  `testing-strategy`. The rest, running the build and the tests and showing their output, is
  default behavior, and the workflows' check and review gates cover the checker for each
  artifact.
- The `deliberation-panel` and `playwright-test-implementation` skills, now guides in the
  artifact library: `design/deliberation-panel.md`, which `k-aspect-review`, the
  requirements-summary guide and the adversarial design review follow when the user agrees to the
  panel's cost, and `e2e-test-strategy/playwright.md`, which the Playwright step of
  `k-sop-e2e-test-generation` follows. Both were reached only from those callers.
- The `socratic-elicitation` skill, now the `requirements-summary` guide in the artifact library,
  which the design-doc workflow's intake step and the requirements, task-doc and workflow-building
  guidance follow. Picked up for an ad-hoc request, its one-question-at-a-time rule made the agent
  stop after a single question where it otherwise laid out every open decision with a recommended
  default; in a workflow interview that cadence is the intended one.
- The `design-impact-review` and `architecture-diagram-generation` skills. With and without them,
  the agent traced the same downstream impacts and drew the same draw.io AWS diagrams, and the
  diagram skill carried wrong placement rules, such as Lambda outside the VPC.
- The `persistent-memory` skill and its validator. It wrote what the user asked to remember into
  `.konductor/memory/` instead of the harness's own memory, and a new session in a user project
  never read that folder, so the facts were lost; the harness's native memory kept them. The
  memory instructions in the `agents-md` guide and this repository's `AGENTS.md` are gone with it.
  `install.sh` still requires Bun, for fuse-flow.
- The user guide and its Python tooling, and the agent benchmark harness.
- The SOPs in `agent-sops/`, which `install.sh` never installed. The workflows in
  `fuse/flow/workflows/konductor/` replace them. The SOP files are in this repository's history and in upstream Konductor.

### Upgrading from Konductor

Uninstall Konductor with its own `konductor uninstall` before installing Fuse-Konductor, so that
its agents and generated files do not stay behind next to the new skills. Then follow
`INSTALL.md`, or open a session in the clone and ask for the tutorial.

### Upgrading from an earlier `fuse` commit

Workstreams started with an earlier fuse-flow continue with the new one: it reads the paths,
folder records and review acceptances the earlier version wrote. Before resuming a step whose
review was running during the upgrade, check its findings files against the names the step block
prints:

- In a step with a check, script or child workstream before two or more reviews, the earlier
  fuse-flow numbered the files by counting only the reviews, so an old `-gate<k>` file can carry
  the number another review has now. Rename each old file to the number the step block prints for
  its review, starting with the highest, so no file is overwritten. `fuse/flow/README.md`
  describes this under the policy files.
- `continue` refuses while a review it owes has no findings file under the printed name. Rename
  the reviewer's file to that name, or, when the owner waives the review, pass over it with
  `continue --waived "<reason>"`.
- Some shipped workflows were renamed: the Konductor SOP workflows `k-<name>-sop` are now
  `k-sop-<name>`, and `kiro-spec-workflow-sop` is `k-sop-kiro-spec-workflow`. A workstream that
  follows an old name is refused with
  "no workflow named". Change the `workflow:` line of its `.konductor/workstreams/<slug>.yml` to
  the new name, and update your own workflows that hand off to or wait for an old name or path.
- fuse-flow no longer creates `.konductor/.gitignore`; it keeps the local policy file out of git
  through the checkout's exclude file. An existing `.konductor/.gitignore` is never edited or
  removed and goes on protecting the file. Once
  `git check-ignore .konductor/policy-overrides.local.yml` confirms the file is ignored without
  it, you can delete an untracked one yourself.
- `fuse-feature-development` now binds a newly found check command in
  `.konductor/policy-overrides.local.yml`. A check already bound in the team file keeps working.
- Review gates now apply the artifact's guide and review guide alongside a gate's guide, and a
  policy's `review.guide` replaces only the gate's guide. A review's identity now names every
  applied guide, so a review that passed or that the owner accepted before the upgrade runs again
  when its step resumes if it now applies more guides than before, and editing an artifact's
  authoring guide now makes a passed review of that artifact run again. A project that relied on
  a policy guide to replace an artifact's review guide can override the artifact's library entry
  instead.
- A workflow that uses a step's `guides:` needs the fuse-flow that ships with it; an earlier
  fuse-flow refuses the field.
- A project's or user's own copy of a guide a shipped step names now wins over the step's
  instruction where they disagree, as an artifact guide in the project library already did. This
  also holds for guides the shipped workflows used to name by path in their instructions, which
  always came from the clone.
- Fifteen skills were removed or moved into the artifact library (see Removed). Running
  `install.sh` again removes their installed copies. Update your own workflows and instruction
  files that name one: `deliberation-panel`, `playwright-test-implementation` and
  `socratic-elicitation` by the path of their guide, the rest by stating what the step needs.
  Facts the `persistent-memory` skill stored stay in `.konductor/memory/`; move any you still
  want into your harness's own memory or the project's `AGENTS.md`.

## [1.0.0] - 2026-09-23

### Added

- 8 specialist agents (product manager, architect, developer, QA, researcher, technical program
  manager, browser, media analyzer) plus three orchestrators (`konductor`,
  `konductor-mux-orchestrator`, `konductor-cmux-orchestrator`) that coordinate them across the
  SDLC, delegating work, tracking progress, and enforcing a maker-checker quality gate on every
  handoff.
- 82 skills across 8 capability areas: architecture and design, planning and tracking,
  architecture and development review, testing and QA, orchestration and delegation, Kiro spec
  generation, documentation and writing, and research and security.
- 19 agent-sops, invoked as `/prompts` entries in Kiro CLI and as `/sop-<name>` skills in Claude
  Code, covering design doc creation, code review, E2E test
  generation, and a full end-to-end SDLC pass (`k-full-sdlc`).
- Persistent memory: a local, cross-session scratchpad under `.konductor/memory/` that needs no
  setup, with a validator enforcing size limits and an optional URL allowlist.
- Multi-runtime support for Kiro CLI v2, Kiro CLI v3, Kiro IDE, and Claude Code.
- The `konductor` CLI with `install`, `update`, `uninstall`, `synth`, `init`, and `doctor`
  subcommands.
- A `skill-lookup` MCP server that works with Kiro CLI v2, Kiro CLI v3, and Kiro IDE.
