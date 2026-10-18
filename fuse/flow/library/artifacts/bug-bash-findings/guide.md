# Recording bug bash findings

The findings folder holds one JSON file per lens or review and an index the owner can read. The
quality bar is in the bug-bash-plan guide.

## One file per lens or review

Each agent writes a JSON array to its own file in the folder, named after its task, such as
`logic-engine.json` or `review-fix-docs-r2.json`. Each element:

```json
{"id": "<task>-<n>", "severity": "P0|P1|P2", "title": "one sentence",
 "where": "path:line, path:line", "evidence": "what was observed, quoting output or text",
 "repro": "exact commands or reading steps, or null", "suggested_fix": "short"}
```

A review of a fix series writes an object instead, so that a clean review still records what it
looked at:

```json
{"series": "<task>", "range": "<base>..<head>", "verdict": "clean|findings",
 "findings": [], "notes": "one paragraph"}
```

`findings` holds elements of the shape above; `verdict` is `clean` only when it is empty. A review
that an engine gate asks for follows the schema and the file path the step block prints instead;
the index refers to that file. Next to each file, the agent writes a few sentences on method:
which techniques found its findings, which wasted time, and how long it took.

## The index

`index.md` lists every finding on one line: its status, id, severity, title and location. Status
is one of: unverified, confirmed, rejected (with the reason), duplicate of another id, fixed (with
the commit), deferred to the owner, or listed (an optional finding left as it is). Group the lines
by the file they came from, so the source of each finding stays visible.

## Verifying

- Every P0 and P1 is checked before it is fixed: reproduce it, or read the code path and quote it.
  A finding whose evidence does not hold is rejected with the reason. With few findings, check them
  yourself and mark them confirmed. With many, mark them unverified and let each fix agent
  re-establish its own first; an unverified finding at or above the threshold goes to fixing like
  a confirmed one, and its fix agent confirms or rejects it before changing anything.
- Mark duplicates across lenses and models; a finding two models found independently is noted as
  such, since it is the most reliable kind.
- Re-rate a severity that does not match the quality bar, and say so.
- A finding about behaviour the owner has ruled out of scope is rejected, citing the ruling.
