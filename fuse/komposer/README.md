# Komposer

Komposer is a local editor for fuse-flow workflows. It shows a workflow as a diagram, edits it
without disturbing the file's comments and layout, and shows the workstreams that follow it, in
the project and in your other projects. It reads and writes the workflow files on disk, in all three places fuse-flow looks:

- the project's `.konductor/workflows/`;
- your own `~/.konductor/workflows/`;
- the workflows that ship with fuse-flow, in `fuse/flow/workflows/`.

The bar at the top switches between the pages: **Edit** (key 1), **Compare** (key 2) and
**Workstreams** (key 4). Present is shown there but not built yet. Edit is the page Komposer
opens on. The workflow selected in the list on the left is the same on the Edit and Workstreams
pages.

On the Edit page, the strip at the far right opens a panel with three tabs, in scope order:
**Library** (the artifact library from the same three levels), **Workflow** (its form, its YAML
and its changes against the original) and **Step** (the selected step). The panel is closed
when Komposer opens, so the workflow's steps fill the screen. Clicking a step selects it and
opens the Step tab; clicking the active strip button, the panel's Close button or Escape closes
the panel, and a second Escape clears the step selection. The Step tab groups its fields in four
sections (basics, instruction, inputs and outputs, gates); only the instruction is open at
first, a closed section shows a one-line summary, and a section with a problem stays open.

The Workstreams page lists the workstreams of the selected workflow, or of all workflows, by
project, and shows the selected one as a summary (where it is, its steps and its events) or as
its workflow's diagram in the workstream's state.

The Compare page, also opened by "workflow compare" at the end of the fuse-flow section, shows
any two workflows side by side as read-only diagrams, with each step marked as the same, changed
(naming the fields that differ) or only on one side. "Swap sides" exchanges them, the YAML view
shows the line diff of the two files, and a step that differs can be copied to the other side. A
copy is an unsaved change of that workflow, which you save or discard on the Edit page like any
other edit.

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
  choose one with the theme button at the right of the top bar; that choice is kept in the browser.
- **Edits are kept as a working copy** in the project's `.konductor/editor/` folder, which git
  ignores, until you choose Save. Save either updates the original file or saves a new one. If
  the file changed on disk in the meantime, Komposer asks before overwriting it.
- **Saving a workflow that a workstream is following** affects that workstream, because fuse-flow
  reads the workflow again on every command. Komposer warns you when a save moves or renames
  steps that a workstream in progress depends on.
- **Workstreams from all your projects.** The Workstreams page lists the project Komposer was
  started on and every project in `~/.konductor/projects.yml`, each with its workstreams.
  fuse-flow adds a project to that list when it writes a workstream there. For workstreams from
  before that, **Add projects** adds every project with workstreams in a folder and up to four
  folder levels below it. A workstream whose workflow is the project's own file, outside the
  three folders above, opens that file read-only. A hand-off or workflow gate in such a
  workstream's workflow names a workflow of that project, as fuse-flow reads it, and following it
  opens that file read-only too. If that project's file of that name cannot be read, or its
  workflow folder cannot be searched, the link shows it as unavailable with the reason, as
  fuse-flow would fail there, rather than leading to a shared workflow of the same name. A project
  whose workstreams cannot be read says why in the list. Removing a project from the list leaves
  its workstreams where they are.
- **Example workstreams.** The last project in the list, `example-runs`, holds five made-up
  workstreams of the `custom-example-small`, `-medium` and `-large` workflows, in
  `example-runs/.konductor/workstreams/` in this folder. They come with the clone, so Komposer
  has workstreams to show before you have any of your own. They show finished, waiting,
  in-progress and blocked workstreams, with a send-back, a failed check and extra review rounds.
  Only the workstream files exist; the artifacts they name were never written.
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
