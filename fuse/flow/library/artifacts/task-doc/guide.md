# Analyzing an unclear request

Before planning, classify what kind of work the request is, surface what is unclear, and bound
the scope, so the next steps do not build on guesses. Write the result as a short brief at the
top of the document.

## 1. Classify the intent

| Intent                 | Signals                                  | Primary focus                                        |
| ---------------------- | ---------------------------------------- | ---------------------------------------------------- |
| **Refactoring**        | "refactor", "restructure", "clean up"    | Safety: regression prevention, behavior preservation |
| **Build from scratch** | "create new", "add feature", greenfield  | Discovery: explore existing patterns first           |
| **Mid-sized task**     | A scoped feature, a specific deliverable | Guardrails: exact deliverables, explicit exclusions  |
| **Collaborative**      | "help me plan", "let's figure out"       | Interaction: clarity through dialogue                |
| **Architecture**       | "how should we structure", system design | Strategy: long-term impact                           |
| **Research**           | Investigation needed, path unclear       | Investigation: exit criteria, time bounds            |

## 2. Analyze by intent

- **Refactoring.** Ask what behavior must be preserved, how to roll back, how far the change
  propagates, and which dependencies are hidden. Verify before the refactor and after each
  change, and record the preserved behavior. Never combine it with feature changes.
- **Build from scratch.** Ask what similar code, conventions and utilities exist, and how it will
  be tested. Research the patterns before implementing, reference specific files, and define
  "done". Do not invent new patterns.
- **Mid-sized task.** Ask for the exact deliverables, the explicit exclusions, the assumptions and
  the verification criteria. List deliverables and exclusions, with acceptance criteria per
  deliverable. Do not expand the scope.
- **Collaborative.** Ask what matters most to get right, the timeline, the constraints, and
  whether the owner wants options or a recommendation. Present choices at decision points and
  confirm understanding. Do not make major decisions without the owner.
- **Architecture.** Ask about long-term implications, what to optimize for, the constraints and
  the alternatives considered. Document the trade-offs. Do not optimize prematurely.
- **Research.** Ask which question must be answered, what "good enough" means, the time budget
  and what happens with the findings. Define exit criteria and a time bound. Do not research
  indefinitely.

## 3. Check for failure patterns

| Pattern                | Signal                              | Action                         |
| ---------------------- | ----------------------------------- | ------------------------------ |
| Over-engineering       | Adding features not requested       | Ask: "Is X actually needed?"   |
| Scope creep            | Vague boundaries that grow          | Enforce explicit exclusions    |
| Assumption cascade     | Building on unvalidated assumptions | Validate the assumptions first |
| Premature optimization | Optimizing before it works          | Focus on "working" first       |
| Analysis paralysis     | Researching forever                 | Set time bounds, exit criteria |
| Hero syndrome          | Trying to do everything             | Split the work into pieces     |

When the intent is collaborative at medium or low confidence, architecture at low confidence, or
you flagged an assumption cascade or scope creep, resolve it with the owner first: question them
as the `socratic-elicitation` skill's intake mode describes, and fold the answers into the brief.

## The brief

```markdown
## Brief

- **Intent:** <type>, <high | medium | low> confidence, because <rationale>
- **Key ambiguities:** <what is unclear and why it matters>
- **Questions for the owner:** <what we need to know and why>, if any
- **Recommended approach:** <the steps, in order, and what each is for>
- **In scope:** <explicit list>
- **Out of scope:** <explicit list>
- **Deferred:** <what comes later>
```

Before handing it over, check that the intent is classified, that the scope separates in from
out, that a low-confidence classification comes with questions that would resolve it, that the
assumptions are written down, and that you checked for the failure patterns.
