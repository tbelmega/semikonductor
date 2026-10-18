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
    back to an earlier step, forward, skip); `status`, `list` and `validate`.
  - The engine refuses to complete a step while a required artifact is missing without a reason
    or a check fails. It hands over to the owner at owner gates and when a review reaches its
    round cap, with the owner's options in plain words.
  - Where a step's instruction and an artifact's guide disagree, the step block says the
    instruction wins over a guide that ships with fuse, and asks the agent to name each
    disagreement; the review request tells the reviewer the same. A guide from the project's or
    the owner's own library or policy is a house rule instead: the agent follows the owner's
    ruling, else the guide when it clearly applies, and asks when it is unclear.
  - When the owner sends work back, from the current step in any status, the files the steps
    wrote stay recorded as draft and each reopened step's next pass lists them to keep, update or
    redo. Review rounds count per pass, with the pass in the findings file names from the second
    pass on. `status` shows each file once, under the latest step that records it. A produced
    folder that existed before the step, such as a shared research folder, is recorded file by
    file from the files the agent names.
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
    specs, feature splits, implementation plans, research notes, test coverage and more. A project
    or a user can override any entry.
  - Policy files (`~/.konductor/policy-overrides.yml`, the project's `.konductor/policy-overrides.yml`
    and `.konductor/policy-overrides.local.yml`) set check commands, artifact paths, the reviewer
    model for each author model and how the reviewer is launched, and the owner's rulings where
    fuse-flow and the house rules overlap. Reviewers write findings as JSON to
    `.konductor/reviews/`.
  - A step runs attended or unattended, set with `mode` and attended when it is not set. The step
    block's `MODE` line tells the agent to ask the owner often, or to decide on its own judgement,
    and tells the owner whether to stay. In both, the agent records the decisions it makes on its
    own in `.konductor/decisions/<slug>.md`, following the `decision-log` guide. Hand-over and
    completion blocks gain a `DECISIONS:` line whenever finished work, in the workstream or in any
    workstream it delegated to, has not been reviewed, with four ways for the owner to respond.
    The shipped fuse workflows mark the steps that work alone as unattended, and Komposer shows
    and sets the mode.
- **Shipped workflows:**
  - `fuse-feature-development`, one feature in an existing codebase: intake, design,
    implementation and code review, with agent reviews before the owner approves the spec and
    lands the work. The shipped workflows leave branching to the project's own rules: when there
    are none and the checkout is on the integration branch, the agent asks the owner once whether
    to create a branch.
  - `fuse-pull-request`, a change through the project's pull request or code review process, the
    way the project runs it: open the request, answer each round of reviewer feedback with fixes
    that pass an agent review first, and finish once the change is merged.
    `fuse-feature-development` offers a pull request at its last gate only where the house rules,
    the project's history or the agent's memory show such a process, and hands off to it when the
    owner approves the work for one; it can also be started on its own. The change may be on a
    feature branch, a fixed branch per worktree or the integration branch itself.
  - `fuse-system-development`, a new system or a module with its own architecture: intake,
    requirements, optional prototypes, a system design with a principal engineer review
    rehearsal by an agent, and a build order whose features are then built with
    `fuse-feature-development`. The owner approves the prototype findings or sends the work back
    to the requirements.
  - `fuse-dependency-migration`, a migration or refactoring that must keep the behavior: catalogue
    the checks, add missing ones, record a baseline, migrate in increments and compare.
  - `fuse-rapid-prototyping`, a new product idea explored as a runnable prototype: a short
    interview, many small build-and-feedback iterations with no code review loop, and a product
    brief of what to build that `fuse-system-development` can take up.
  - `fuse-bug-bash`, a time-boxed bug bash: intake, a catalogue of the existing checks, a
    discovery wave of independent agents with different lenses and models, and, in a fixing run,
    reviewed fixes and a confirmation wave, ending in a report. Its library entries
    `bug-bash-plan`, `bug-bash-findings` and `bug-bash-report` hold the method.
  - `fuse-rapid-prototyping`, `fuse-system-development` and `fuse-feature-development` hand off
    to each other: rapid prototyping to system or feature development, and system development to
    one feature workstream per entry of its build order, which receives the product brief,
    requirements, design and build order as inputs.
  - In `workflows/konductor/`: `_k-full-sdlc` and `_k-phase-chain`, Konductor's full lifecycle
    pass and lighter phase chain, and one workflow per remaining Konductor SOP, named after it with
    a `-sop` suffix, such as `k-design-doc-creation-sop` and `k-code-review-workflow-sop`. Duties
    the SOPs took on for the skills they loaded, such as credentials, the owner's confirmation and
    cleanup around `app-discovery`, are steps and gates of these workflows.
  - Examples: four project-specific workflows, and a native workflow after obra/superpowers.
  - The workflows in `workflows/fuse/` take acceptance tests from the spec, start every bug fix with a
    failing reproduction, and have the reviewer check the tests against the spec, instead of
    forcing test-first on every change. Specs are saved under date-prefixed paths in
    `docs/specs/`.
- **Komposer,** in `fuse/komposer/`, a local web editor for workflows. It shows a workflow as a
  diagram, edits it without losing the file's comments and layout, browses the artifact library,
  and shows the runs of a project's workstreams. It keeps unsaved edits as a working copy, warns
  before a save affects a running workstream, follows the system's light or dark theme, and
  serves only to 127.0.0.1 behind a token.
- **Skills:**
  - `fuse-workstream`: finds a workstream to resume, recommends a workflow for new work, starts it
    once the user agrees, and runs it, keeping fuse-flow's commands out of what the owner reads.
    Its opt-in debug mode ends every reply with a report of what fuse did.
  - `fuse-flow-builder`: builds or changes a workflow with the user, by interview, by encoding an
    existing process, or together in Komposer, following fuse's principles for workflows.
  - `fuse-tutorial`: a coach for new users. Started in the clone before anything is installed, it
    installs Fuse-Konductor with the user after checking their harnesses and conflicting skills or
    instructions, explains the repository, and teaches hands-on: choosing a workflow, working on a
    real project, building a greenfield demo project, or shaping a workflow to how the user works.
  - `aws-mcp-usage`: confirmation rules for AWS MCP tools that act on an account, and which AWS
    guidance to load for common tasks, taken from the removed architect and developer agents.
- **The always-on block** `AGENTS.fuse.md`, which `install.sh` writes into instruction files. It
  says when fuse applies, the rules that hold while a workstream runs, and how to write for the
  owner: self-explaining headings, decisions and commit messages, without bare labels such as `D1`.
  It defines house rules: the project's and the harness's agent instructions, the owner's earlier
  rulings, what the agent remembers of the project, and what the project's history shows. Where
  a step says in prose how to do something a house rule covers, such as branching, getting a
  change reviewed, starting a reviewer or keeping decision records, fuse does not win by default:
  the agent follows the owner's ruling, else the house rule when it clearly applies, and asks when
  it is unclear. A value set in a fuse-flow policy file is the deterministic form and always wins;
  without one, the step block's default defers to the house rules, as for how a reviewer is
  started.
- **`install.sh` and `INSTALL.md`.** `--project <dir>` copies the skills into the project's
  `.agents/skills/`, links `.claude/skills` and `.kiro/skills` to it, and adds the block to the
  project's `AGENTS.md`, for the team to commit. `--global <file>...` adds the block to each
  harness's user-level instruction file and copies the skills next to it; `--link` links them into
  the clone instead, for people who edit the skills. `--uninstall` reverses either. The script
  changes only what it installed and keeps the rest of each instruction file byte for byte.
  Supported harnesses: Claude Code, Codex, Cursor (project install only), OpenCode and Kiro CLI.
- A smoke-test harness in `fuse/smoke/`: an orchestrating agent plays the user, has a separate
  fuse agent build a trivial program with a workflow, and judges whether an engineer who knows
  nothing about fuse-flow could get through it.
- `docs/GLOSSARY.md`, including the scope terms prohibited, deferred and out of scope.

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
- The `verification` skill names the checker for each kind of artifact and when to run
  `design-impact-review`, taken from the removed agent prompts.
- Skill descriptions open with when to use the skill, and the prose in skills and SOPs is
  rewritten in plain language.
- The `persistent-memory` validator runs on Bun instead of Python, so the repository and its tests
  need only Bun.
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
- The `architecture-advisor` skill, now the quick-opinion mode of `trade-off-evaluator`.
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
  infrastructure lens of `k-code-review-workflow-sop`. `verification` points infrastructure
  changes at it.
- The user guide and its Python tooling, and the agent benchmark harness.
- The SOPs in `agent-sops/`, which `install.sh` never installed. The workflows in
  `fuse/flow/workflows/konductor/` replace them. The SOP files are in this repository's history and in upstream Konductor.

### Upgrading from Konductor

Uninstall Konductor with its own `konductor uninstall` before installing Fuse-Konductor, so that
its agents and generated files do not stay behind next to the new skills. Then follow
`INSTALL.md`, or open a session in the clone and ask for the tutorial.

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
