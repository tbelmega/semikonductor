---
name: interview-me
description: Use when the user says "interview me", "interview me on <topic>", "interview me on that" (often about the options or questions your last reply raised) or "ask me one by one", or when you hold several open questions or decisions that only the user can settle. Settles them one self-contained question at a time, records each answer before asking the next, and closes with what was decided and where it was recorded.
version: 1.0.0
tags: [skill, interview, questions, decisions, owner]
---

# Interview me

An interview settles a set of open points with the user, one question at a time, so that each
answer is quick and well informed. Write every question for a reader who comes to it cold: they
may have lost track since the point came up, or never read what it rests on.

## Which points to cover

- **A named topic:** the open points on that topic.
- **"On that", or a bare "interview me" right after a reply that raised options or questions:**
  exactly those points.
- **A bare "interview me" with nothing open in the conversation:** ask in one question what to
  cover. If the project keeps decisions waiting for the user somewhere, such as a board, an
  outbox or a decisions file, offer those as one of the choices.

## Before the first question

- Gather the open points from the conversation, the files and the tracking item.
- Drop the points that the code, the documentation or the user's recorded decisions already
  answer. Settle the points your rules let you settle yourself, and list them, so the user can
  object.
- Put the rest in order of leverage: first the points whose answers change or remove other
  questions.
- Tell the user how many questions there are, and update the count when answers add or remove
  some.

## Each question

- Ask one question per message, or per question prompt where the harness has a tool for it.
- Make it stand on its own. In a few plain sentences, say what the point is, where it came from
  and why it needs the user's call. Define any term the user did not introduce.
- Never make the user look something up: no finding or ticket numbers, no "option B above", no
  "the split we discussed". Restate what they need inside the question. A file path may back up
  a statement, but the question must not depend on reading it.
- Offer the real options and say what each one causes. Lead with your recommendation and the
  reason for it.
- In a multiple-choice prompt, put all of this into the question and option texts: the prompt may
  hide whatever was written before it.

## Each answer

- Record the answer where it belongs, such as the spec, the tracking item, the decisions file,
  the code or memory, before you ask the next question, so that a crash or a context reset loses
  nothing.
- If the answer is unclear or raises a new question, follow it up before moving on. If it changes
  later questions, rewrite or drop them.
- For an answer in the user's own words, act on what they mean and say briefly how you read it.

## Ending

Stop when every point is settled or the user ends the interview. Close with a short list: each
point, what was decided and where it was recorded. Name any point that is still open.
