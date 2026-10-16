// SPDX-License-Identifier: Apache-2.0
// Whether the open workflow gives way to the first workflow of the three
// locations. A workflow file of another project is read-only and has no
// place in the workflow list: it is open either with one of its runs, or
// because a link (a hand-off, a workflow gate) was followed to it. Opened
// with a run, it gives way once that run is closed or no longer listed;
// opened by a link, it stays until something else is opened. Any workflow
// gives way once it is no longer listed. No React, no DOM, no Node APIs.

export function givesWay(view: {
  // The open workflow is still among the listed ones.
  listed: boolean;
  // It is another project's file.
  readOnly: boolean;
  // One of its runs is open.
  hasRun: boolean;
  // It was opened by following a link, not with a run.
  openedByLink: boolean;
}): boolean {
  if (!view.listed) return true;
  return view.readOnly && !view.hasRun && !view.openedByLink;
}
