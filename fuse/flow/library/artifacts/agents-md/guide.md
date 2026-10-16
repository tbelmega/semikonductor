# Writing an AGENTS.md file

How to create or update a repository's `AGENTS.md`, with its context-loading block and the
`CLAUDE.md` bridge for Claude Code. `AGENTS.md` is a README for AI agents: a predictable place for
project context and instructions, part of the open [agents.md](https://agents.md) standard and
read by many agentic tools. It is updated when project conventions, build commands or structure
change, or when a durable learning is promoted from session memory into permanent project
guidance. The step's artifact path decides where it is written; the default is the repository
root.

## How AGENTS.md is loaded

Loading differs by runtime:

|             | Kiro CLI custom agents                                                                   | Claude Code custom agents                            |
| ----------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `AGENTS.md` | Not read automatically. It must be in the agent's `clientConfig.kiroCli.resources` as `file://AGENTS.md`. | Not read automatically. Claude Code reads only `CLAUDE.md`. |
| `CLAUDE.md` | Not read automatically.                                                                  | Read at session start, at every hierarchy level.     |

So when Kiro loads `AGENTS.md`, import directives (`@path` or `#[[file:]]`) in it are not
expanded. To make agents load steering, memory or skills, write instructions inside `AGENTS.md`,
as the context-loading block below does, not imports.

Two things bootstrap the loading:

1. **Kiro:** the agent spec lists `"file://AGENTS.md"` in `clientConfig.kiroCli.resources`.
2. **Claude Code:** the repository has a `CLAUDE.md` containing the import `@AGENTS.md`, so Claude
   Code loads the content of `AGENTS.md`. Further imports can be chained there if needed, such as
   `@.konductor/memory/MEMORY.md`.

## Structure

Write these sections, adapted to the project. Infer what you can from the repository: build
files, existing test commands, the directory structure, and the git history for commit message
conventions. For what cannot be inferred, such as pull request or review conventions not visible
in the repository, or team-specific domain knowledge, ask the owner, unless the step or its
inputs already say. Mark inferred content as inferred, so the owner can correct it in review.

1. **Context Loading (MUST follow at session start).** The instruction block below.
2. **Project Overview.** What the project is, in two or three sentences.
3. **Project Structure.** A directory map.
4. **Setup & Commands.** The build, test and install commands.
5. **Code Style & Conventions.** Formatting, naming and language rules. If a
   `.kiro/steering/*.md` file already documents them, reference it
   (`See .kiro/steering/<file>.md`) instead of duplicating its content.
6. **Testing.** How to run the tests.
7. **Workflow.** Git and pull request conventions.
8. **Domain Knowledge**, optional. Durable facts specific to the project.

## The context-loading block

Always include this block. Because Kiro does not expand import directives in `AGENTS.md`, it uses
explicit instructions, so the agent loads the adjacent context with its own file-reading tools:

```markdown
## Context Loading (MUST follow at session start)

Before starting work, load available project context:

- You MUST read `.kiro/steering/**/*.md` if present — workspace steering rules.
- You MUST read `<workspace>/memory/*.md` if present — persistent facts and preferences.
- Workspace-specific skills may exist at `.kiro/skills/**/ws-*.md` — be aware and load when relevant.

If a path does not exist, skip it silently and continue.
```

Replace `<workspace>` with the project's workspace directory, such as `.konductor`, so that
`<workspace>/memory/*.md` becomes `.konductor/memory/*.md`.

## Rules

- `AGENTS.md` holds instructions that developers write; it is not agent memory. Do not
  put session memory or timestamped facts in it; those belong in the memory files. Promote only
  durable, reviewed learnings.
- Keep it concise and easy to scan, with bullets and short sections instead of prose.
- For a public package, keep the content generic: no internal tools, domains or credentials.
- A change meant for `CLAUDE.md` goes into `AGENTS.md`; `CLAUDE.md` should only import
  `@AGENTS.md`.

## Procedure

1. Check whether `AGENTS.md` exists. If it does, read it and patch it instead of replacing it.
2. Draft the sections above, always with the context-loading block.
3. Confirm before writing. A calling workflow handles the owner's confirmation, for example
   through its own review gate, so go on. Used on its own, show the owner the proposed content,
   and the `CLAUDE.md` you would create, and write nothing until they confirm.
4. Write `AGENTS.md`. Make sure a `CLAUDE.md` with `@AGENTS.md` exists, and create it if it is
   missing.
5. Check that the relevant agent specs list `file://AGENTS.md` in
   `clientConfig.kiroCli.resources`.
6. In the hand-over, list what you inferred and what you changed, so the owner can review it.
