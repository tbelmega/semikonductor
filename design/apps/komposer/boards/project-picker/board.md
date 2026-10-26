# Project picker

How the user picks the project they look at on the Workstreams and Kanvas pages, and decides which folders on their computer Komposer treats as projects. Today Workstreams reuses the Workflows rail on the left as a filter and lists projects in a rail on the right, which makes browsing a project's workstreams across workflows clunky; Kanvas has a plain project dropdown.

## Round 1

Question: How should the user switch projects quickly on Workstreams and Kanvas, and declare any folder to be or not be a project?
Fidelity: mockup
Outcome: No pick yet. The owner sharpened the question: Workstreams filters by project and by workflow, either of which can be left at "all" (round 2).

### 1a: Switcher in the top bar

Direction: The project name in the top bar becomes a switcher that opens a searchable palette (also with Ctrl K): pinned and recent projects first, each with its workstream states. Typing a path turns the palette into a folder browser where any folder can be added or hidden. The chosen project applies to every page, so Workstreams drops both rails and lists the project's workstreams across all workflows, with the workflows as filter chips.

### 1b: Projects rail

Direction: Workstreams and Kanvas get their own left rail of projects instead of the Workflows rail, always visible, so switching is one click. Each row shows the project's workstream states; pinning, hiding and adding folders happen in the rail, and hidden folders stay listed at the bottom so they can be shown again. The main area shows the selected project's workstreams grouped by workflow.

### 1c: Project tabs and a folder map

Direction: The projects the user is working on sit as tabs under the top bar, like browser tabs, switched with a click or Ctrl 1 to 9. A Projects drawer shows the folders under the user's chosen roots as a tree with a switch on each folder, marking what Komposer found there. Workstreams shows the active project's workstreams as columns by state, across all workflows.

## Round 2

Question: How does the user filter workstreams by project and by workflow, each of which can be left at "all", and how would Kanvas look with the workflow that produced each board as a second filter?
Fidelity: mockup

### 2a: Two filter menus

Direction: A bar above the list with two menus, Project and Workflow, each starting at "All" and cleared with its own x. Each menu shows counts under the other filter's choice. The list groups by whichever dimension is left at "all". Kanvas has the same bar, with the second menu reading "Made by" and boards made by hand marked as such. Shown: one workflow across all projects, its menu open.

### 2b: Faceted rail

Direction: A left rail with two stacked lists, Project and Workflow, each topped by an "All" entry. Picking in one recounts the other; entries with nothing left stay listed, greyed. A breadcrumb above the list shows both choices and clears either. Kanvas uses the same rail, with "Made by" and a "Made by hand" entry. Shown: one project across all workflows, and on Kanvas one workflow across all projects.

### 2c: Project by workflow grid

Direction: A grid with projects as rows and workflows as columns, each cell counting workstreams and showing dots for those waiting or blocked. A cell picks both, a row or column header picks one across the other, and the totals row and column cover "all". The list of the selection sits below. Kanvas shows the same grid counting boards, with a column for boards made by hand. Shown: one cell, acme-storefront by feature-development.
