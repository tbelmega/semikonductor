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
