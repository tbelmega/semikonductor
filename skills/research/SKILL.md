---
name: research
description: Use when asked to find out or document how something currently works, such as this codebase, another project, an external system or API, or a process, before planning or deciding, or when findings should outlive the conversation. Keeps the record of the research, not its method. Checks existing research notes first, writes one dated note per question in a fixed shape with a source for every claim, and hands the note to the user to review.
version: 1.0.0
tags: [skill, research, research-note, record-keeping]
---

# Research notes

A research note records what you found out about one question, so that a decision can rest on it
and nobody has to research the same thing again. The question can be about anything the work
depends on: this codebase, another project used as an example, or documentation and other material
on the internet. This skill covers the record: where notes live, what a note holds, and how notes
are reused. How to research is up to you.

## Where notes live

In the research directory the workflow step names. Without a step, in the place the project
already keeps research notes, as its instructions or earlier notes show; otherwise in
`docs/research/`.

## Before you research

- Look for notes on the same or a closely related topic, and read any you find. Tell the user what
  they cover and how old they are, then offer to answer from them as they are, to check them
  against the current code or sources and update them, or to research afresh.
- Do not start a new note while an existing one covers the question; update that one.
- If the question is unclear, settle what it is before you start, and say what is out of scope.

## The note

Write one file per question, named `YYYY-MM-DD-<topic>.md` with the date you started it. Create it
early and add findings as you go, so that a context reset loses nothing. It holds:

1. **Question and scope:** what you set out to find out, and what you left out.
2. **Answer:** the key findings first, a few sentences each.
3. **How it works:** the detail behind the findings.
4. **Conventions, risks and bugs:** what someone building on this must know.
5. **Open questions:** what you could not settle, and what would settle it.

Leave out the sections that do not apply.

Every claim names where it comes from, so that it can be checked: a file, module or function in
code, or a link to an external source. For another project, say which project and version you
read, and how the parts you report map onto this one. For documentation, say which version or
date it describes. Mark what you inferred, as opposed to what you read or ran. Do not give line
numbers; they go stale as soon as the code changes.

When you check an older note against current sources, correct it in place and add a line saying
when it was rechecked and against what.

## Handing it over

The note is what the user reviews, not the chat summary. Give its full path and summarize the
findings that bear on the decision at hand. In a workflow step, continue the step with them;
otherwise ask the user to review the note before anyone plans on it.
