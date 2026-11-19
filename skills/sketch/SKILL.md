---
name: sketch
description: Use when the user's whole message is the word "sketch" or "/sketch", optionally followed by what they want explained, because they do not follow the agent's last reply. Works out what they are most likely missing, such as a reference the reply assumed they remember or an abstract idea that needs an example or a diagram, explains the likeliest gap at once in the smallest form that closes it, and lists the other likely gaps as choices. Not when "sketch" answers a question the last reply asked, or is part of a request for new work, such as "sketch an API for orders".
version: 1.0.0
tags: [skill, sketch, explain, context, example, diagram, user-command]
---

# Sketch

The user typed `sketch` because they do not follow your last reply. Find what they are missing
and give them the smallest thing that closes the gap.

## With a target

`sketch <target>`, such as `sketch the round cap`, names what they miss. Explain that target as
described under "Closing the gap", then stop. Do not list other gaps.

## Without a target

1. Read your previous reply as someone who was not following closely would. List what they would
   most likely be missing: at most three items, the likeliest first. Name each by what it is,
   such as "the round cap in the reviewer" or "how the two review loops fit together", never by
   the form of the help ("more context", "a diagram").
2. Explain the first item at once.
3. End with the other items as choices, plus one to name something else. Each choice names its
   item in words and reads on its own. Where the surface offers one-click reply options, use
   them; otherwise use a short numbered list. Do not open a blocking question prompt, which can
   hide the explanation written above it. Fewer than three items is fine when fewer gaps are
   real.

With no previous reply, say that there is nothing to sketch yet.

## Closing the gap

- **A reference the reply assumed the user remembers,** such as an earlier question to them, a
  review finding, a decision, a number or label like "question 3", or a skill, rule, file or
  product feature that was not just discussed: give the missing context. Say in a few sentences
  what it is, and where and when it came up or which file it lives in. Look it up in the
  conversation, the files, the tracking item or board, and any history or memory tools the
  harness has, rather than rebuilding it from memory. If you cannot find it, say so.
- **An abstract description or proposal:** show it. Give one concrete example from the project
  at hand, with its real names and values, or one diagram of the type that fits:
  - a sequence diagram for who calls whom, in what order;
  - a state diagram for a lifecycle;
  - a call tree for control flow;
  - a file tree, one line of responsibility per entry, for where things live;
  - a before and after, such as a diff, for a proposed change.

  Draw it with what the surface renders inside the reply: Mermaid, a text diagram in a code
  block, or an inline widget where the surface offers one. Keep only the parts the point needs,
  and put each picture next to the sentence it supports.
- **A reply that is hard to follow as a whole:** one diagram or a short walk through its main
  line. To have the same reply said again in simpler words, the user has the `plain` skill.

## Rules

- **Explain; do not decide.** Add context, examples and pictures. Make no new proposal and change
  no recommendation. If explaining shows that the earlier reply was wrong, say so plainly.
- **Read only.** Read whatever helps. Run nothing that changes state, run no workflow command, and
  do not move a workflow step forward.
- **Small.** A few sentences, one example or one diagram.
- **Facts keep their exact spelling:** paths, commands, numbers and names.

## Fixed-form blocks and rules for every reply

If your previous reply ended with a block that a workflow or the harness requires in a fixed
form, such as a workflow's hand-over block, a completion receipt or a line of reply options,
repeat that block exactly at the very end, after the choices. Do not run the workflow's
commands to print it again.

Bookkeeping the owner switched on for every reply, such as a debug report and the log line it
appends, still runs after the explanation. It is not part of the explanation, so the read-only
rule does not stop it. Nothing else is exempt from that rule.
