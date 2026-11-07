# Writing a glossary

A glossary defines the terms a project uses, so that the code, the specs and the conversations
with the owner call each thing by one name. It is kept up to date as the work defines new terms.

## Where it lives

Use the project's existing glossary when it has one, wherever it lives. Otherwise create
`glossary.md` in the folder that holds the workstream's documents.

## Choosing a term

Prefer a term that already exists over a new one. Look for existing terms in:

- the code: type, module, field and function names;
- the product brief or hand-over, when it defines terms;
- the project's own documentation;
- the documentation of the systems and libraries the project depends on.

Where the sources disagree, pick one term and use it everywhere. Record the term you picked and
the synonyms used elsewhere that are not to be used, with where each occurs, so a later reader
does not bring them back.

## Entries

One entry per term, sorted alphabetically:

```markdown
**<Term>:** <what it means in this project, in one or two sentences>.
Source: <where the term comes from, such as a file path, a document or the owner>.
Not: <rejected synonym> (<where it occurs>), <rejected synonym> (<where it occurs>).
```

Leave out the `Not:` line when no other term is in use. Record a mapping between the project's
names and another vocabulary the same way, such as a test level the project calls by another name.

Keep each entry short. A term that every reader of the project already knows needs no entry.
