# Komposer

Komposer is a local editor for fuse-flow workflows. It shows a workflow as a diagram, edits it
without disturbing the file's comments and layout, and shows the workstreams that follow it, in
the project and in your other projects. It reads and writes the workflow files on disk, in all three places fuse-flow looks:

- the project's `.konductor/workflows/`;
- your own `~/.konductor/workflows/`;
- the workflows that ship with fuse-flow, in `fuse/flow/workflows/`.

The bar at the top switches between the pages: **Present** (key 1), **Compare** (key 2),
**Edit** (key 3) and **Workstreams** (key 4). Present is the page Komposer opens on. The workflow
selected in the list on the left is the same on every page; on Compare it is the left side.

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

The Compare page shows the selected workflow on the left and another workflow of the three
locations on the right, each with its description below its picker so you can read what both are
for, and their steps aligned row by row. Between the two descriptions, **Ask your agent** copies a
question about when to use which workflow and their trade-offs, naming both files, for you to paste
into your own agent; Komposer runs no agent itself. Each row is marked as the same, changed,
only on the left, only on the right, or moved, and a changed row lists the fields that differ.
Instructions are compared as fuse-flow reads them, trimmed, with their line breaks and indentation.
The pickers above the two sides choose them; in the list on the left, a row picks the left
workflow and its **as right** button the right one, and **Swap** exchanges the two. **only
differences** folds runs of identical steps, and **all instructions** shows every step's
instruction. The left is the editable workflow and the right is read-only: the buttons on the
right cards change the left workflow, applying one difference (**← Apply**), all of a step's
differences, or adding, removing or moving a step. Clicking a left step opens it in the panel at
the right, as on the Edit page. A change made on Compare is an unsaved edit of the left workflow,
which you save with Compare's own **Save…** or on the Edit page, or discard on the Edit page.

The Present page shows the selected workflow's diagram, read-only, under its name and
description. The workflow list and a **Show** panel are drawers at the left and right edges:
each slides in while the pointer is over its strip and its arrow pins it open. In the Show
panel, **Side by side with** adds a second workflow next to the first, and the toggles choose
what the diagrams show (phases, descriptions, conditions, artifacts, gates, consume lines and
route-back lines), with **Show all** and **Steps only** as shortcuts. Following a workflow link
in a diagram selects that workflow and stays on Present.

## Running it

You need [Bun](https://bun.sh) 1.3 or later. Komposer uses fuse-flow's own source, so fuse-flow's
dependencies are installed too. From this folder, the first time:

```bash
bun install --cwd ../flow
bun install
bun run build
```

Then start it on a project, which is any git repository:

```bash
bun run start -- <project directory>
```

Leave the directory out to use the current one. The command prints a URL with a token, such as
`http://127.0.0.1:4807/#token=...`; open it in your browser. `--port <n>` picks another port.

Run the two installs and `bun run build` again after pulling changes. For working on Komposer
itself, `bun run dev` serves the app with Vite on port 5173 and passes `/api` to the server
started with `bun run start`.

## What to know

- **Light and dark themes.** Komposer follows your system's light or dark setting until you
  choose one with the theme button at the right of the top bar; that choice is kept in the browser.
- **Edits are kept as a working copy** in the project's `.konductor/editor/` folder, which git
  ignores, until you choose Save. Save either updates the original file or saves a new one. Save is
  offered only once fuse-flow's checks of the current text have answered and found no error; until
  then the Save button's tooltip says the workflow is being checked, or why it cannot be. **Save as
  new** writes each review guide, workflow gate and hand-off given as a relative path again, so it
  names the same file from the new folder, checks the file at the new place with fuse-flow, refuses
  to save on an error, and shows warnings once before saving. If the file changed on disk in the
  meantime, Komposer asks before overwriting it. While a save writes the file, the editor takes
  no edits; once the save is done, editing continues on the saved text. A working copy written by an older Komposer does
  not record which version of the file it was made from, so Komposer treats the file as possibly
  changed and asks whether to keep the edits or load the disk version before it saves. Two tabs on
  one workflow do not overwrite each other's working copy. A tab without edits of its own loads the
  other tab's copy when it regains focus. A tab with edits of its own, when it next writes its copy
  and finds that the other tab changed it, holds its edits back and asks whether to load the other
  tab's edits or keep its own. A working-copy write that fails for another reason, such as a
  folder Komposer cannot write, keeps the edits, shows "not written" with the reason in the
  header, and is tried again. While a working-copy write is still being sent, a failed write or
  another tab's change holds this tab's edits back, the browser asks before the page closes. A working copy, or a
  working-copy folder, that cannot be read is listed at the end of its location's section with the
  reason and left as it is; the other workflows load as usual.
- **The address shows the page and the workflow,** such as
  `/edit/project/release/ship.yml` for a workflow of the project's folder,
  `/present/fuse-flow/fuse/fuse-bug-bash.yml` for a shipped one, or `/edit/run/<path>` for another
  project's file. The browser's back and forward buttons move between pages and workflows, and a
  reload or a link opens the same view. A tab that does not hold the token yet needs it added to the
  link (`#token=...`, from the printed URL). An address naming a workflow that is not listed opens
  the first one. Going back while a save writes a file keeps the page where it is.
- **Saving a workflow that a workstream is following** affects that workstream, because fuse-flow
  reads the workflow again on every command. Komposer warns you when a save moves or renames
  steps that a workstream in progress depends on.
- **Workstreams from all your projects.** The Workstreams page lists the project Komposer was
  started on and every project in `~/.konductor/projects.yml`, each with its workstreams. fuse-flow
  adds a project to that list when it writes a workstream there. For workstreams from before that,
  **Add projects** adds every project with workstreams in a folder and up to four folder levels
  below it. A workstream whose workflow is the project's own file, outside the three folders above,
  opens that file read-only. A hand-off or workflow gate in such a workstream's workflow names a
  workflow of that project, as fuse-flow reads it, by its name or by a path relative to the file,
  and following it opens that file read-only too, also before that file has a workstream of its own.
  If that project's file of that name cannot be read, or its workflow folder cannot be searched, the
  link shows it as unavailable with the reason, as fuse-flow would fail there, rather than leading
  to a shared workflow of the same name. A project whose workstreams cannot be read says why in the
  list. Removing a project from the list removes every path it is registered under, such as one
  through a link, and leaves its workstreams where they are. A workstream's workflow is opened by
  the path fuse-flow reads its relative references from. When a workflow folder is reached through a
  link and a relative reference would name another file from the path the workstream recorded, that
  path is listed as a second, read-only entry beside the editable one, which saves the same file. As
  `fuse-flow status` does, a workstream lists the steps its state records that its workflow no
  longer has, and one whose workflow file is not a valid workflow says that it cannot be read.
- **The server is for your machine only.** It listens on 127.0.0.1, requires the token from the
  printed URL, refuses requests that come with another host name, and writes only `.yml` and `.yaml`
  files in the three workflow folders, files in its own working-copy folder, and the projects list.
  A write to a workflow file or a working copy is judged by the real path it leads to, with links
  resolved, so a workflow file that a link leads outside the three folders opens read-only, saying
  where it leads, and saving it is refused. A workflow file that cannot be read, a link whose target
  is missing and a folder that cannot be searched are listed at the end of their location's section
  with the reason. It shows a review guide that a workflow names, or a file of a library entry, only
  when the file lies in the project, a library or a workflow folder, or is a file shipped with the
  package library; any other is reported as outside, without its text, and the Library tab names the
  real path such a file leads to. A review guide opened from a gate that may be shown but cannot be
  read says why, not that the file does not exist.
- **Known limitation:** when an edit changes a flow list (`[...]`) that spans several lines,
  Komposer writes that list again in its own layout, with each bracket on a line of its own. Each
  comment inside the list goes with an item: the item on its line or the next one below it, the
  first item for a comment on the opening bracket's line, and the last item for one after the last
  item. The comment moves when its item moves and is lost when its item is removed. No shipped
  workflow uses that form.

## Tests

```bash
bun test          # the server's API and the YAML editing, end to end
bun run typecheck
```
