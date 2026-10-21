# Recording usability review findings

The findings folder holds one JSON file per lens, the walkthrough records, the glossary guesses,
and an index the owner can read. The quality bar and the verifying rules are in the
usability-review-plan guide. The shape extends the bug-bash-findings guide's, so the two
workflows' findings read alike.

## One file per lens

Each agent writes a JSON array to its own file in the folder, named after its lens and task or
screens, such as `walkthrough-t3-first-time.json` or `consistency.json`. Each element:

```json
{"id": "<file>-<n>", "severity": "P0|P1|P2", "persona": "<persona it is rated for>",
 "title": "one sentence",
 "task": "<core task id, or null>", "screen": "<screen>", "state": "<state>", "width": "<px>",
 "where": "what the user sees and where, and for informed lenses path:line",
 "screenshot": "<path in the records folder, or null>",
 "expected": "what the agent expected or looked for, or null",
 "observed": "what happened, quoting the screen or the record",
 "evidence": "the walkthrough line, the screenshot, or the code that shows it",
 "suggested_fix": "short", "root_cause": null}
```

Blind walkthroughs fill `task`, `persona`, `expected` and `observed` from their walkthrough record
and leave `where` to what they saw; they never name a source file. The glossary-guessing agent
writes only its list of guesses, in the form its brief gives, to `guesses/` in the folder; the
orchestrator compares each guess with the inventory and writes the findings, with `task` set to
null, `expected` to the guess and how sure the agent was, and `observed` to what the element
really means. `root_cause` is set by the
orchestrator when it groups findings. Next to each file, the agent writes a few sentences on
method: what found its findings, what wasted time, and how long it took.

## Walkthrough records

Every walkthrough, and every shortest path an informed agent finds, is a text file in
`walkthroughs/`, named after its task, persona and agent. One line per user action, numbered, in
this form:

```text
<n>. <action> | looking for: <what> | expected: <what should happen> | observed: <what happened> | match: yes|no
```

Only user actions get a number, as the plan guide's rule for counting steps says; what the app
does in response goes in `observed`. The file ends with `result: done|stuck|stopped`, and for
`stuck` what the agent looked for and where. A record that ends `stopped`, because the limits were
reached, is kept as evidence for the steps it has and has no step count.

## The index

`index.md` holds, first, the root causes: each with an id, a one-line description, its severity
and persona, every finding that belongs to it, and where it occurs. Then every finding on one line,
grouped by the file it came from: id, severity, title, root cause, and two separate fields.

- **Verification:** unverified, confirmed, rejected (with the reason), or duplicate of another id.
  Mark a finding two model families found independently.
- **Disposition,** set at triage for its root cause: recommended fix, redesign proposal, deferred,
  or rejected by the owner (with the reason).

The bug bash's "fixed with the commit" status does not apply: this workflow fixes nothing.

Under the findings, list every discarded blind result, walkthroughs and glossary guesses alike,
each with its lens and the reason. Then give the step count of each core task: the shortest
path's count, each walkthrough's count, and the record each comes from.
