# Planning and running a usability review

A usability review finds the problems a frontend's actual audience would meet, within a time box,
by many independent agents. Its main purpose is poor interaction design: elements that do not
explain themselves, cryptic references, and tasks that take too many steps or repeat an action.
It also checks consistency, the project's own rules and general practice. It reports and never
fixes. This guide holds the plan's structure and the method. The house rules win where they say
otherwise.

For the orchestration of the informed agents, this guide points to sections of the bug-bash-plan
guide instead of repeating them. That guide is the bug-bash-plan library entry, found the way
fuse-flow finds library entries; in fuse's own library it sits next to this entry, at
`../bug-bash-plan/guide.md` from this file. Read the sections named here when you reach them.

## The plan, in this order

1. **For the owner:** the decisions they must make or check, each with your recommendation.
2. **Scope:** the app, and the routes and screens in and out.
3. **Audience profile,** as described below, and where else it is written.
4. **Core tasks,** as described below.
5. **House rules that apply:** steering documents, the design system, message files, the
   project's own conventions, each with its path.
6. **Quality bar:** the severities below, adapted to this audience with an example of each.
7. **Limits:** wall-clock time and spend, per step where it matters, and the limit ruling, as the
   section on the end of a review describes.
8. **Reviewers:** the model and harness for each lens and for the review of the report. Use two
   model families for the first-time walkthroughs of the most important tasks.
9. **The app and its data:** how agents start it, whether a live app may be used, whether the
   tasks may change its data, and whether the tasks only read data, so that agents may share an
   instance.
10. **Tooling:** what agents need and have, the gaps, and whether the owner has the missing
    tooling built first.
11. **Owner channel:** how the owner is notified of questions during the run, if at all.
12. **Records:** the folder that holds the run's records. It is ignored by git and inside the
    repository, never only in the harness's scratch space, which a restart can delete.
13. **A test with real people:** whether the owner wants the script in the report.
14. **Inventory** and **lenses**, written by the inventory step.

## Audience profile

Settle each of these, and say which the owner stated and which you inferred:

- **Expertise:** power users, casual users, or both.
- **How often they come back:** mostly first-time users, regulars, or both.
- **Devices and viewport widths,** with the narrowest width that matters.
- **Input:** mouse, touch, keyboard, or a mix.
- **Languages,** and whether the app is ever shown in more than one.
- **Accessibility needs,** such as screen readers or keyboard-only use.
- **The documentation the audience actually has,** such as a README, onboarding text or nothing.

Personas are named combinations of these, such as "first-time casual user on a laptop". Each core
task names the persona who does it.

The profile is written into the plan. At the intake gate, offer to write it into the project's
documentation as well, so the next review and the design workflows start from it, and write it
there only when the owner agrees. The next intake starts from that copy and asks only what has
changed.

## Core tasks

Usually five to ten, fewer when the owner narrows the scope. Each has:

- a start state, such as "a new project with one workflow" or "the run viewer with a failed run";
- a success condition the agent can observe on screen;
- the persona who does it;
- the input method and viewport width its step count is taken at.

A task describes what the user wants, in the user's words, never which controls to use: "find out
which of this artifact's files exist", not "hover over the letters on the pill".

## Quality bar

Severity is rated for the audience in the plan. The same problem can be P1 for first-time users
and P2 for regulars, and every rating names the persona it applies to.

- **P0:** the evidence shows a core task's success condition cannot be reached by any path the
  audience can use, or a target user triggers a destructive action without meaning to.
- **P1:** the task can be completed, but a target user would plausibly fail, make a mistake or
  need help: a control they cannot find, a label they read wrongly, a step they do not know they
  must take. Extra steps are P1 only when the evidence shows a real burden or risk of error for
  the audience, such as a regular repeating them many times a day.
- **P2:** friction that a target user gets past without help, including avoidable extra steps by
  default.
- **P3:** taste. Not reported.

Visual design, branding, performance and copywriting beyond whether a label is understood are
outside the review.

## Tooling

Agents need to start the app with realistic seeded data, start several instances at once, each on
its own port with its own data, and drive it in a browser, with screenshots. Check each at intake.
Usually a project's own development server and fixtures are enough. For each gap, say what it costs
the run, such as states no agent can reach or agents that must share an instance, and what
tooling would close it, and recommend at the intake gate whether to build it first. When the owner
agrees, the tooling step builds it as a feature workstream, and the review runs on a head that has
it, as the bug-bash-plan guide's test tooling section describes for a bug bash. The plan names that
head.

## Inventory

- **From the code:** every route, screen and state, and every interactive element with its visible
  label, tooltip and accessible name, and every abbreviation, letter, icon or number shown without
  a word next to it. Note where the same concept appears on several screens.
- **In the browser:** follow the page crawl of the discovery-report guide
  (`../discovery-report/guide.md` from this file in fuse's library) for what can be reached by
  clicking, without its form submission unless the plan allows changing data. Screenshot each screen in each of these states at each target width: empty, loading,
  error, long text, many items. Set up the states clicking cannot reach from the seeded data, or
  list them as not reached. Name each screenshot after its screen, state and width.
- **Baseline checks:** run once, where the project has them or they are cheap to add in a clone:
  an accessibility scanner, a lint for hard-coded strings where the project uses message files,
  and a lint for the design system where one exists. Their findings are recorded, not re-reported
  by every lens.
- **Lens assignment:** choose the lenses from the catalogue below, and assign each its model,
  persona, tasks or screens, and app instance.

The inventory is for informed agents and the orchestrator. No blind agent sees it.

## Blind and informed agents

An agent that has read the code knows what every element means and can no longer tell that it
does not explain itself. So the lenses are split by what they know:

- **Blind agents** see only the running app, the audience profile, their persona and their task.
  Their wrong guesses are the findings.
- **Informed agents** read the code and the house rules. They build the inventory and check
  consistency, step counts and the rules.

The orchestrator joins the two: a blind finding names what the user met, and the inventory names
what the element really does and where else it appears.

### Keeping a blind agent blind

- It gets no clone and no shared context file: an empty working directory, the app's address and
  its brief. The shared context file explains the source and collects what earlier agents learned.
- Its brief is built from its lens's template below and holds nothing else: nothing from the
  inventory, no explanation of the interface, no findings or notes from other agents. You have
  read the code, so write the brief from the template, not freehand, and read it once more for
  anything that tells the agent what an element means.
- The brief forbids reading the source, its tests and any documentation the audience does not
  have.
- Before you use a blind agent's result, check both the brief you sent and the transcript. A result
  whose brief explained the interface, or whose agent read the source or other forbidden
  documentation, is discarded, not used, and recorded in the cost ledger with the reason.
- A blind agent that has seen the app once has learned it. A second walkthrough of the same task
  by the same persona as a first-time user needs a new agent.

### The blind brief

Blind walkthroughs, including the returning-user lens, get this brief:

```text
You are testing a web app as one of its users. You have never seen it before.

App: <address>
You are: <persona, in the audience profile's words>
You use: <the task's input method, such as mouse, touch or keyboard only>
Your window is: <the task's viewport width> pixels wide
You have this documentation: <the documentation the audience has, or "none">
Your task: <the task, in the user's words>
You start from: <the start state, as the user would see it>
You are done when: <the success condition, as the user would see it>

Use only the browser, with only the input method above, at the window width above. Do not read
any source code, tests, repository files or other documentation, even if you could reach them.
Do not change data you were not asked to change.

Before each action, write what you are looking for, which control you will use, and what you
expect to happen. After it, write what happened and whether it matched. One action is one click
or tap, one key press or shortcut that is not typing, one field filled, one hover held to reveal
something, one drag, or one continuous scroll. Write every action to <walkthrough path>, one
numbered line each, in this form:
<the walkthrough record line from the usability-review-findings guide>
End that file with "result: done" when you reached the end of the task, "result: stuck" and what
you looked for and where when you cannot go on, or "result: stopped" when you are told to stop.

Write your findings to: <findings path>, in the format <the findings format from the findings
guide>.
<only for the returning-user lens: When the first pass ends with "result: done", go back to the
start state and do the same task again in the same session, with the same input method and window
width, writing a second record to <second walkthrough path> in the same form. In your findings,
say what still cost effort the second time.>
```

The glossary-guessing lens performs no walkthrough and gets this brief instead:

```text
You are looking at screenshots of a web app as one of its users. You have never seen it before.

You are: <persona, in the audience profile's words>
You have this documentation: <the documentation the audience has, or "none">
Screenshots: <the paths of the inventory's screenshots, and nothing else from the inventory>

Do not read any source code, tests, repository files or other documentation, even if you could
reach them, and do not open the app. For each screenshot, list every label, letter, icon,
abbreviation and number you see, and write what you think it means and how sure you are: sure,
fairly sure, or guessing. Write the list to <guesses path>, one line each, in this form:
<screenshot> | <the element and where it is> | <what you think it means> | <how sure>
```

The same rules for keeping an agent blind apply to both briefs.

## Lens catalogue

Each lens is one agent with one model, persona and set of tasks or screens.

### Blind lenses, which see only the running app

- **First-time walkthrough.** One agent per persona and core task. Before each action it writes
  what it is looking for, which control it will use and what it expects to happen; after the
  action, whether that happened. A wrong expectation, a control it could not find, or a step it
  did not know it had to take is a finding. This is a cognitive walkthrough with the thinking
  written down, and the most important lens.
- **Glossary guessing.** Given only the inventory's screenshots, never the inventory itself, the
  agent writes what each label, letter, icon, abbreviation and number means, and how sure it is.
  The orchestrator compares the guesses with the inventory; a wrong or unsure guess on something
  the audience must understand is a finding. The most direct test for cryptic references.
- **Returning user,** where the audience includes regulars: the same tasks a second time in the
  same session, looking for what still costs effort after it has been learned.

### Informed lenses, which read the code and the house rules

- **Interaction cost.** Find the shortest path for each core task that still meets its success
  condition and keeps the safeguards the task needs, and count its steps by the rule below.
  Compare it with the first-time walkthrough of the same task and persona. Flag two controls for
  the same action, an action that has to be done twice, a confirmation that protects nothing, a
  round trip between screens, and a choice the app could have made itself.
- **Consistency.** The same concept named, drawn or placed differently; the same control behaving
  differently; drift from the design system.
- **House rules.** The project's steering documents, message files and conventions.
- **States and edge content.** Empty, loading, error, long names, many items, narrow widths, from
  the inventory's screenshots and the code.
- **Keyboard and accessibility.** Focus order, keyboard reach, accessible names and contrast,
  beyond what the scanner found.
- **Power user,** where the audience includes power users: shortcuts, bulk actions, and how fast a
  repeated task gets.
- **General practice.** The well-known usability heuristics, such as visible system status,
  recognition over recall, and error prevention, applied screen by screen.

### Counting steps

A step is one user action: a click or tap, a key press or shortcut that is not typing, one field
filled however many characters it takes, one hover held to reveal something, one drag, or one
continuous scroll that brings a target into view. What the app does in response, such as changing
screen, is not a step. For example, opening a menu, choosing an entry and confirming a dialog is
three steps.

Count at the task's persona, input method, viewport width and start state from the plan. Every
walkthrough records its actions one per line in this form, and so does the shortest path, so the
counts come from the records rather than from a second traversal. A walkthrough that stopped
part-way has no step count; say so instead of counting its steps.

## Orchestration

For the informed agents, follow these sections of the bug-bash-plan guide's orchestration rules:
the shared context file, one clone per agent, records in the repository, background processes
that survive the harness, the watchdog, the cost ledger, credentials that expire, validating every
result file on receipt, and verifying what agents report. The shared context file also holds the
quality bar, the audience profile and the findings format. Blind agents follow only the watchdog,
the cost ledger and validating every result file; everything else they get is their brief.

Two rules of this workflow come on top:

- **One app instance per agent.** Walkthroughs change data, and two agents in one instance would
  see each other's changes and report them as design problems. Each agent gets its own instance
  with its own seeded data, unless the plan records that the tasks only read data.
- **No agent changes the project.** None writes to the owner's checkout, and none changes data in
  a live app or submits its forms without the owner's permission recorded in the plan.

## Verifying

There are no fix agents to re-establish a finding later, so check every P0 and P1 before triage,
without changing the app's data: replay the step in a fresh instance, or quote the screenshot, the
walkthrough line or the code that shows it. A finding whose evidence does not hold is rejected
with the reason. Handle duplicates, re-rating and findings outside the scope as the bug-bash-findings
guide's verifying section says. A finding two model families found independently needs the least
checking. A P2 may reach triage unverified, marked so.

Agents are not real users. They know common conventions better than most people and read every
word where people scan. A blind finding that two model families both hit is strong evidence; a
single agent's confusion is a lead, and the index says which it is.

## Owner channel

Follow the bug-bash-plan guide's owner channel section: questions only the owner can answer go to
the workstream's decisions file with the default you go ahead with, the owner is notified through
the channel the plan names, and the run waits only where no safe default exists. Read the
decisions file for answers between lens waves and before every step. In this workflow no step
changes code, so an answer that concerns an earlier step's work, such as a task to add, goes back
to that step only when the owner asks for it; otherwise keep the default and put the answer first
in triage.

## When the review is done

A run is done when every planned lens has reported, or when the limits are reached. The report
says which. Reaching the limits is a normal end, and intake records the limit ruling in the plan so
that the run reaches triage without waiting for the owner. By default:

- Reserve time and spend for verifying, triage and the report, estimated from the cost ledger as
  the run goes. Start no new lens once what is left would not cover them.
- When the limits are reached, stop the lenses still running. A walkthrough that stopped part-way
  is kept as evidence for the steps it did and marked incomplete.
- Go to triage with what was found. Triage and the report list first every core task without a
  complete walkthrough or step count, every lens that did not run, and every state the inventory
  did not reach, so the owner sees what the run did not cover before what it found.

## A test with real people

When the owner wants it, the report ends with a short script for a test with five people on the
riskiest core tasks: whom to recruit, from the audience profile; the tasks, in the user's words,
with their start states; what to say before and during each session, without explaining the
interface; what to watch for, from the findings each task should confirm or refute; and how to
record what happened. The workflow writes the script and never runs the test.
