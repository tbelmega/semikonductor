# Komposer

Komposer is a local editor for fuse-flow workflows. It shows a workflow as a diagram, edits it
without disturbing the file's comments and layout, and shows the runs of workstreams in the
project and in your other projects. It reads and writes the workflow files on disk, in all three places fuse-flow looks:

- the project's `.konductor/workflows/`;
- your own `~/.konductor/workflows/`;
- the workflows that ship with fuse-flow, in `fuse/flow/workflows/`.

The Library tab shows the artifact library from the same three levels.

The detail panel on the right is closed when Komposer opens, so the workflow's steps fill the
screen. Selecting a step opens it on that step; the Library, Workflow and YAML buttons at the bottom
right open it on those tabs; Escape or its close button closes it again. The step tab groups its
fields in four sections (basics, instruction, inputs and outputs, gates); only the instruction is
open at first, a closed section shows a one-line summary, and a section with a problem stays open.

## Running it

You need [Bun](https://bun.sh) 1.3 or later. From this folder, the first time:

```bash
bun install
bun run build
```

Then start it on a project, which is any git repository:

```bash
bun run start -- <project directory>
```

Leave the directory out to use the current one. The command prints a URL with a token, such as
`http://127.0.0.1:4807/#token=...`; open it in your browser. `--port <n>` picks another port.

Run `bun run build` again after pulling changes. For working on Komposer itself, `bun run dev`
serves the app with Vite on port 5173 and passes `/api` to the server started with `bun run start`.

## What to know

- **Light and dark themes.** Komposer follows your system's light or dark setting until you
  choose one with the sun/moon button next to its name; that choice is kept in the browser.
- **Edits are kept as a working copy** in the project's `.konductor/editor/` folder, which git
  ignores, until you choose Save. Save either updates the original file or saves a new one. If
  the file changed on disk in the meantime, Komposer asks before overwriting it.
- **Saving a workflow that a workstream is following** affects that workstream, because fuse-flow
  reads the workflow again on every command. Komposer warns you when a save moves or renames
  steps that a running workstream depends on.
- **Runs from all your projects.** The Projects section at the bottom of the list shows the
  project Komposer was started on and every project in `~/.konductor/projects.yml`, each with
  its runs; selecting a run opens it on the workflow it follows. fuse-flow adds a project to that
  list when it writes a workstream there. For runs from before that, the folder button next to
  Projects adds every project with runs in a folder and up to four folder levels below it. A
  run whose workflow is the project's own file, outside the three folders above, opens that file
  read-only. Removing a project from the list leaves its runs where they are.
- **Example runs.** The last project in the list, `example-runs`, holds five made-up runs of the
  `custom-example-small`, `-medium` and `-large` workflows, in `example-runs/.konductor/workstreams/`
  in this folder. They come with the clone, so Komposer has runs to show before you have any of
  your own. They show finished, waiting, in-progress and blocked runs, with a send-back, a failed
  check and extra review rounds. Only the run files exist; the artifacts they name were never
  written.
- **The server is for your machine only.** It listens on 127.0.0.1, requires the token from the
  printed URL, refuses requests that come with another host name, and writes only `.yml` files in
  the three workflow folders, its own working-copy folder and the projects list. It shows a review guide that a
  workflow names only when the guide lies in the project, a library or a workflow folder, or is
  a guide shipped with the package library.
- **Known limitation:** comments inside a flow list (`[...]`) that spans several lines are lost
  when an item of that list is added, removed or moved, or when a gate in it is edited. No shipped
  workflow uses that form.

## Tests

```bash
bun test          # the server's API and the YAML editing, end to end
bun run typecheck
```
