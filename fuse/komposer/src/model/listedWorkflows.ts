// SPDX-License-Identifier: Apache-2.0
// The open workflows after the server's listing is read again, as when a
// project is added to the projects list or removed from it. The listing can
// predate edits whose working copy is still to be written, and new workflows
// that were never written, so a workflow of the three locations that is open
// stays exactly as it is: the same object, so nothing that watches it starts
// over. Another project's files, which are only read, follow the listing.
// No React, no DOM, no Node APIs.

export interface Listed {
  location: string;
  path: string;
  hash: string;
}

export function mergeListed<O extends Listed, L extends Listed>(open: O[], listed: L[], toOpen: (file: L) => O): O[] {
  const byPath = new Map(open.map((w) => [w.path, w]));
  const listedPaths = new Set(listed.map((w) => w.path));
  const fromListing = listed.map((file) => {
    const current = byPath.get(file.path);
    if (!current || current.location !== file.location) return toOpen(file);
    // Another project's file has no watcher: a changed one is read again.
    return current.location === "run" && current.hash !== file.hash ? toOpen(file) : current;
  });
  const keptLocal = open.filter((w) => w.location !== "run" && !listedPaths.has(w.path));
  return [...fromListing, ...keptLocal];
}
