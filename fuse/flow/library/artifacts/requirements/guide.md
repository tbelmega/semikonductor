# Writing requirements

Requirements say what a system must do, for whom, and how the owner will judge it done. They do
not say how it is built; that is the design's job. The same guide serves a system built from
scratch and a new module of an existing system. A module has one more section, which describes the
system it joins and what of that system must keep working.

The document has two readers at two times. While it is drafted, its reader is the owner, who
answers questions and approves or declines your decisions, often between other work. Once it is
approved, its readers are the designer, the reviewers and anyone who later asks why the system
does what it does. The document therefore has two forms: a working draft ordered by what needs the
owner's attention, and a durable form that reads from top to bottom. Both share one body, so the
change from one to the other is small.

## The golden rule

What needs the owner's attention most goes on top of the draft. The owner should be able to open
the file, read until the first section that needs nothing from them, and stop.

The draft is filled in by an interview with the owner, run with the socratic-elicitation skill.
The draft changes every turn: each answer is folded into the body and removed from the top in the
turn it is given, so nothing answered stays on top and nothing lives only in the conversation.
Each turn ends with a local commit of this file alone, so the owner reviews one turn's diff
instead of rereading the whole document. The commits are the change log; do not keep a "changes
since last time" section in the document.

## The working draft

Start the file as soon as the purpose and rough scope are settled, using the template next to this
guide. Mark it `status: draft` in its front matter. It holds two parts.

### For the owner (on top)

Every item that needs the owner, ranked by how much the answer could change scope, behavior or
cost. Within that ranking, put open questions before your own decisions, because a question blocks
work and a decision does not. Among your decisions, put the hard to reverse ones first.

Write each item so the owner can act on it without reading the rest of the document:

- **A title that names what it decides,** such as "Offline use: must the tool work without a
  network?", never a bare label such as "Q3". A short label may accompany the words.
- **The context** in one to three sentences: why it matters and what you found.
- **For a question:** the options, your recommendation with its reason, and what in the
  requirements changes with each answer.
- **For one of your decisions or assumptions:** what you decided, why, and how hard it would be to
  reverse later. Mark it "(agent decision)". It stands unless the owner objects, but it stays on
  top until the owner has seen it: approval of the document is approval of every item still listed
  here.

The list on top is a record of what is open, not a script to read out: the interview asks its top
item and adds questions as answers raise them. When the section is empty, write that nothing is
open.

### The body (below)

The sections of the durable form, in its order, filled in as far as the conversation has settled
them. Open points in the body refer to their item on top by its title. Do not mark a requirement as
agreed while the question it depends on is still open.

## The durable form

When nothing is open and the owner has approved the requirements, make the document durable, as its
own commit with no other changes, so the owner can see it is only a restructuring:

1. Remove the attention section.
2. Make sure every approved agent decision is in the body: as a requirement, as a constraint, in
   **Decisions** when its reason is worth keeping, or in **Assumptions** when it is still a belief
   the design must check. Approving an assumption does not make it true.
3. Set `status: approved`, with the date.

If the work is later sent back to requirements, set the status to `draft` again and bring back an
attention section on top for what is now open.

## Sections of the body

Leave out a section that has nothing in it, except Purpose, Users, Requirements and Definition of
done, which every system has.

1. **Purpose.** The problem, for whom, and why it is worth solving now, in the owner's terms. If
   the owner gave reasons for building it, they go here.
2. **The existing system** (for a new module only). What the system does today that this module
   touches, the parts it must work with, what of the system must keep working (existing users,
   interfaces, stored data), and who owns the neighbouring parts. Every claim names the file,
   module, document or service it comes from. A system built from scratch can still depend on
   existing tools, services or data; name those under Constraints.
3. **Users.** Each kind of user and the situation they are in. Users planned for later are listed
   here and also under Deferred behavior.
4. **Requirements.** What each user can do, grouped by capability. Each requirement is one
   behavior that a user can observe and a test can check, written with "must". Give each a short
   stable identifier with a title in words, such as "Live preview (R-preview): the preview must
   update after each file the agent writes", so the design and the feature split can refer to it.
   State the behavior, not a solution; a fixed choice of solution is a constraint.
5. **Quality requirements.** Only the qualities that matter for this system, each with a measure:
   how fast, how reliable, how secure or private, how accessible, how costly to run, how it is
   operated. "Fast" is not a requirement; "the preview updates within two seconds" is. For a
   service, the measures usually take these forms:
   - performance: response time targets as percentiles (p50, p99), separate for reads and writes
     when they differ, and throughput in requests per second;
   - availability: an uptime percentage, with the recovery time and the data loss the owner
     accepts after a failure (RTO and RPO);
   - security: who may do what, which data must be protected and from whom, the encryption
     required for data at rest and in transit, and each compliance requirement mapped to its
     standard, such as SOC 2, PCI DSS or HIPAA. A particular authentication method is a
     constraint only when the owner, a policy or the existing system fixes it; otherwise the
     design chooses it;
   - scalability: the expected range of load and when the system must scale out and back in;
   - observability: the metrics that must exist, how long logs are kept, and the trace sampling
     rate;
   - cost: the monthly budget or the cost per transaction.

   Say how the system behaves when it cannot meet a target, when that matters to the owner.
6. **Constraints.** Choices that are fixed before design starts, each with where it comes from:
   an owner decision, the existing system, a policy, a platform. For example: runs locally only, or
   must use the team's existing authentication.
7. **Definition of done.** How the owner will judge the system done: the scenarios they will run
   or watch, and which requirements each scenario shows. These become the design's acceptance
   tests.
8. **Prohibited behavior.** What the system must never do, each written so a test can check it.
9. **Deferred behavior.** What will likely become a requirement later. For each, say why it waits
   and what the design must keep possible for it. Do not build towards it.
10. **Out of scope.** What this work does not decide at all, not even whether it is wanted later.
11. **Assumptions.** What the requirements rest on that nobody has verified, and how it could be
    checked. The design step checks them or proposes an experiment.
12. **Decisions.** The decisions whose reason a later reader would want, each with who made it
    (owner, or an agent decision the owner accepted), the alternatives it ruled out, and why. A
    decision whose result is plain from the requirement it produced needs no entry.
13. **Glossary.** Domain terms a reader outside the project would not know. Use the project's
    glossary instead when it has one.
14. **Sources.** Research notes, documents and conversations the requirements draw on, with paths
    or links.

## Writing the requirements

- Write for a reader without your context. Every reference explains itself or points to something
  just above it, never to something further down or in another file.
- Separate what the owner said from what you propose. Do not let draft wording turn your
  assumption into a requirement the owner never agreed to.
- Keep design out: no components, data formats or libraries unless they are constraints.
- Cite files, modules or functions in code; do not give line numbers.
- Keep research in research notes. The requirements cite a note; they do not inline what it found
  unless a requirement rests on it.

## Self-review before the review gate

1. **Attention section:** every item has a title in words, a recommendation and the effect of the
   answer, and nothing answered is still listed. When nothing material is open, only your own
   decisions remain there.
2. **Testable:** every requirement, quality requirement and prohibited behavior can be checked by
   a test or a scenario someone can run.
3. **Complete:** every requirement is shown by at least one scenario in the Definition of done.
4. **Consistent:** no requirement contradicts another, a constraint, or a prohibited behavior, and
   nothing deferred or out of scope is also required.
5. **No design:** no requirement fixes a solution that is not a constraint.
