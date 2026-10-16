# Recording decisions for the owner

Every step runs attended or unattended, and its `MODE` line says which. In an attended step the
owner is with the session and you ask often; in an unattended step you decide on your own
judgement and the owner comes back at the next owner gate. In both, some choices are yours to
make. This guide says which of them to record, how to record them, and what to do when the owner
reviews them.

The record is one file per workstream, `.konductor/decisions/<slug>.md`, which the `MODE` line
names. It is private to this checkout and git ignores it, so the owner can write comments into it.
fuse-flow never reads it: it only tells you where it is, and tells the owner at each hand-over that
it has decisions to review.

## What counts as a decision

Record a choice when the owner could reasonably object to it: you picked one of several workable
options, filled a gap the documents leave open, interpreted an ambiguous requirement, or chose a
default the owner did not state. Record it even when you are confident, because the owner was not
there.

Do not record:

- what the instruction, a document or the owner's earlier answer already settles;
- routine work with only one sensible way to do it, such as fixing a typo or following an
  existing pattern;
- a progress log of what you did. The file lists decisions, not activity. A file the owner has to
  wade through is a file the owner stops reading.

In an attended step you ask about the larger choices, so the file holds the smaller ones you made
without asking. In an unattended step it holds every choice you would have asked about.

## Writing an entry

Append each entry at the end of the file when you make the decision, not at the end of the step.
Use this shape:

```markdown
### <the decision, in one sentence>

- Step: <step id>
- Context: <what made a decision necessary>
- Alternatives: <the other options you considered>
- Why this one: <the reason, in a sentence or two>
- How to reverse: <what would change if the owner picks another option>
```

When the decision is already written, with its reasoning, in a document the step produces, such as
an agent decision labelled in a spec or a design, do not repeat it. Write a one-line entry that
points to it:

```markdown
### <the decision, in one sentence>

- Step: <step id>. Recorded in <path>, section "<heading>".
```

The file then lists every decision in one place, and the reasoning lives in one place.

## When the owner reviews

At an owner gate the hand-over block ends with a `DECISIONS:` line. Fill in how many decisions
are open, the entries since the last closed section, or write "none recorded" when you added
none. The owner can respond in four ways:

1. **Accept them as they are.** Close the section (below), then carry on with the gate as usual.
2. **Comment inline in the file.** Read every comment, answer it in the file or in chat, and make
   the changes it asks for (below).
3. **Ask for changes in chat.** Make them (below).
4. **Walk through them one by one.** Offer this whenever there is more than one open decision.
   Take one decision per question. For each, give its context in a few sentences, the
   alternatives, and your recommendation, marked as such. Use the harness's tool for asking the
   user a question where it has one; otherwise give numbered options with your recommendation
   first. Record the owner's answer under the entry, in the same turn, before you ask about the
   next decision. Stop when the owner says so; the decisions not yet discussed stay open.

### Making a change the owner asks for

A response that only approves changes nothing but this file. A response that changes an artifact
or code must not be applied to work that awaits the owner's approval and then approved on top: the
gates would not run on the changed work. Instead, send the work back, with the owner's agreement,
to the step whose work must change, with the change in the note, using the send-back command the
hand-over block gives for the agent (`continue <slug> --back-to <step> --note "<the change>"`):

- for this step's own work, send it back to this step;
- for an earlier step's work, send it back to the step that produces it;
- for the work of a delegated workstream, which is finished and cannot be continued, send it back
  to the step that delegated it, which the `DECISIONS:` line names. Its next pass creates a fresh
  child workstream. Start that child with the note and the earlier child's decisions file, so it
  does not decide the same things again without knowing the owner's answer.

When the workflow is complete, nothing can be sent back. Make the change in a new workstream that
follows on from this one, started with `start <new-slug> --workflow <a workflow that fits the
change> --after <slug>`, so it reads this workstream's documents.

### Closing a section

Once the owner has responded, put a heading above the entries that were open:

```markdown
## Reviewed at <step id>, <date>: <accepted | changed, with what changed>
```

New entries go below it. The next gate then shows only what is new, and the file keeps the whole
history. Do not delete entries, including those the owner rejected; record the owner's answer under
each instead.

## Decisions from delegated workstreams

A delegated workstream keeps its own decisions file. When it finishes without an owner gate, for
example because a subagent ran it, the parent's `DECISIONS:` line names its file too. Review its
decisions with the owner together with the parent's, and close the section in each file you
reviewed.
