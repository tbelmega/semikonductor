// SPDX-License-Identifier: Apache-2.0
// The open workflows after the server's listing is read again, as when the
// window regains focus, after a save, or when a project is added to the
// projects list or removed from it. A workflow of the three locations with
// unsaved edits keeps its text and the version they were made from: the
// same object while nothing about its file changed, so nothing that watches
// it starts over, and a new workflow that was never written stays too. What
// the listing says about its file is taken up all the same: a file that is
// gone (the listing has only its working copy, or nothing) is no longer on
// disk, so Save makes a new file and links do not lead to it, and one whose
// file changed on disk is reported to `changedUnder`, for the disk-change
// banner. One without edits follows the listing when its file or its
// working copy changed (in a text editor, by fuse-flow, in another tab), and
// is dropped when its file is gone. An edited one whose file now holds
// exactly its edits (saved by another tab, or by hand) follows the listing
// too: it is saved, and the edits' base is that file. Another project's
// files, which are only read, follow the listing.
// No React, no DOM, no Node APIs.

export interface Listed {
  location: string;
  path: string;
  hash: string;
  onDisk?: boolean;
  workingCopy?: string;
  // Where a link the file is leads, outside the workflow locations.
  leadsTo?: string;
  // The file's text, when it is on disk.
  text?: string;
}

export interface Open extends Listed {
  onDisk: boolean;
  text: string;
  openText: string;
}

export function mergeListed<O extends Open, L extends Listed>(
  open: O[],
  listed: L[],
  toOpen: (file: L) => O,
): O[] {
  const byPath = new Map(open.map((w) => [w.path, w]));
  const listedPaths = new Set(listed.map((w) => w.path));
  const edited = (w: O) => w.openText !== w.text;
  // An edited workflow with what the listing says about its file.
  const withFile = (current: O, onDisk: boolean, leadsTo: string | undefined): O => {
    if (current.onDisk === onDisk && current.leadsTo === leadsTo) return current;
    const next = { ...current, onDisk };
    if (leadsTo === undefined) delete next.leadsTo;
    else next.leadsTo = leadsTo;
    return next;
  };
  const fromListing = listed.map((file) => {
    const current = byPath.get(file.path);
    if (!current || current.location !== file.location) return toOpen(file);
    // Another project's file has no watcher: a changed one is read again.
    if (current.location === "run") return current.hash !== file.hash ? toOpen(file) : current;
    if (edited(current)) {
      const onDisk = file.onDisk ?? true;
      if (onDisk && file.text === current.openText) return toOpen(file);
      return withFile(current, onDisk, file.leadsTo);
    }
    const copyChanged = file.workingCopy !== undefined && file.workingCopy !== current.openText;
    return current.hash !== file.hash || copyChanged ? toOpen(file) : current;
  });
  const keptLocal = open
    .filter((w) => w.location !== "run" && !listedPaths.has(w.path) && (!w.onDisk || edited(w)))
    .map((w) => withFile(w, false, undefined));
  return [...fromListing, ...keptLocal];
}

// The file on disk of each open workflow with unsaved edits, where it is
// not the version the edits were made from: the disk-change banner's file,
// and what the Workstreams page shows as saved. Worked out again from every
// listing that is taken up, so a file that went back to the edits' base, or
// that is gone, has no record left. `found` holds the records of workflows
// this listing opened (restoredWorkingCopy); a record whose file did not
// change since is kept as it is, with when it was first seen.
export interface DiskRecord {
  text: string;
  hash: string;
  at?: string;
  unknownBase?: true;
}
export function diskRecords<D extends DiskRecord>(
  records: Record<string, D>,
  merged: Open[],
  listed: Listed[],
  keyOf: (open: Open) => string,
  found: Record<string, D>,
  at: string,
): Record<string, D> {
  const byPath = new Map(listed.map((file) => [file.path, file]));
  const next: Record<string, D> = {};
  for (const open of merged) {
    if (open.location === "run") continue;
    const key = keyOf(open);
    if (found[key]) {
      next[key] = found[key];
      continue;
    }
    const file = byPath.get(open.path);
    if (open.openText === open.text || !file || file.onDisk === false || file.hash === open.hash) continue;
    const kept = records[key];
    next[key] = kept && kept.hash === file.hash ? kept : ({ text: file.text ?? "", hash: file.hash, at } as D);
  }
  return next;
}

// Tells the answer to the newest request of each kind (the workflows
// listing, the workstreams, ...) apart from an older one: each request asks
// begin(kind) before it is sent, and its answer is taken up only while
// current(kind, id) holds. invalidate(kind) says something newer than every
// request of that kind so far was installed, as the watcher, a save, a
// discard or a load does for the workflows.
export function requestSequencer<K extends string>() {
  let last = 0;
  const newest = new Map<K, number>();
  return {
    begin(kind: K): number {
      newest.set(kind, ++last);
      return last;
    },
    invalidate(kind: K): void {
      newest.set(kind, ++last);
    },
    current: (kind: K, id: number): boolean => newest.get(kind) === id,
  };
}
