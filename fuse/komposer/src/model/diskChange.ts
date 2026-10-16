// SPDX-License-Identifier: Apache-2.0
// What the editor does when the watcher reports that the open file changed on
// disk. Komposer's own Save also triggers the watcher, and its event can
// arrive before the editor has recorded the save, so a file whose text
// equals the open text is never treated as a conflict.

export type DiskChange =
  // The editor already holds this version of the file.
  | "ignore"
  // The file now holds exactly the open text: take its hash as the new base.
  | "adopt"
  // No unsaved edits: replace the open text with the file's.
  | "reload"
  // Unsaved edits that differ from the file: ask the user.
  | "conflict";

export function diskChangeAction(
  open: { text: string; hash: string; openText: string },
  disk: { text: string; hash: string },
): DiskChange {
  if (disk.hash === open.hash) return "ignore";
  if (disk.text === open.openText) return "adopt";
  if (open.openText === open.text) return "reload";
  return "conflict";
}

// Handles the watcher's change events for one open file. Each event asks the
// server for the file, and the answers can arrive out of order, so only the
// answer to the newest event is acted on, and none after the watch closed.
// An event for the hash the editor already holds asks nothing, but it still
// makes the answers to earlier events stale.
export function diskChangeWatcher<O extends { text: string; hash: string; openText: string }, D extends { text: string; hash: string }>(deps: {
  // The open file as it is now.
  open: () => O | undefined;
  // The file as the server lists it now.
  fetch: () => Promise<D | undefined>;
  apply: (action: Exclude<DiskChange, "ignore">, open: O, disk: D) => void;
}) {
  let generation = 0;
  let closed = false;
  return {
    async change(hash: string | null): Promise<void> {
      const mine = ++generation;
      if (!hash || hash === deps.open()?.hash) return;
      const disk = await deps.fetch();
      if (closed || mine !== generation) return;
      const open = deps.open();
      if (!disk || !open) return;
      const action = diskChangeAction(open, disk);
      if (action !== "ignore") deps.apply(action, open, disk);
    },
    close(): void {
      closed = true;
    },
  };
}
