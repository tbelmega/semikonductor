// SPDX-License-Identifier: Apache-2.0
// What the editor does when the watcher reports that the open file changed on
// disk. Komposer's own Save also triggers the watcher, and its event can
// arrive before the editor has recorded the save, so a file whose text
// equals the open text is never treated as a conflict. Also how working
// copies are restored and written, since each records the version of the
// file on disk it was made from.

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

// Whether the editor takes edits now. While a confirmed save writes the file,
// it does not: the save's completion removes the working copy and installs
// the text it wrote, so an edit made meanwhile would be lost. Once the save
// is done, edits resume on the saved text.
export function editorTakesEdits(state: { readOnly: boolean; dialog: { type: string; saving?: boolean } | null }): boolean {
  return !state.readOnly && !(state.dialog?.type === "save" && state.dialog.saving);
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

// A working copy restored from the listing, as after a reload. One made from
// another version of the file than the one on disk now is a conflict, as
// when the file changes on disk under unsaved edits: the open workflow keeps
// the hash the copy was made from, so Save asks before overwriting, and the
// file as it is on disk now is returned for the conflict banner. A copy
// without a recorded base, written before bases were kept, may have been
// made from any version of the file, so it is a conflict too: the open
// workflow gets no hash, which no file on disk has, so neither Save nor the
// working copy's own base takes the file on disk as the version the edits
// were made from until the user chooses (unknownBase).
export function restoredWorkingCopy<
  F extends { onDisk: boolean; text: string; hash: string; workingCopy?: string; workingCopyBase?: string },
>(file: F): { file: F; disk?: { text: string; hash: string; unknownBase?: true } } {
  const base = file.workingCopyBase;
  if (!file.onDisk || file.workingCopy === undefined || file.workingCopy === file.text) return { file };
  if (base === undefined) return { file: { ...file, hash: "" }, disk: { text: file.text, hash: file.hash, unknownBase: true } };
  if (base === file.hash) return { file };
  return { file: { ...file, hash: base }, disk: { text: file.text, hash: file.hash } };
}

// Writes the working copies of one tab. Each workflow's copy is written a
// short delay after its last edit, whichever workflow is selected by then,
// and every pending write can be sent at once, as when the page is hidden.
// The tab knows which copy the server holds (its hash, or null for none) and
// sends that along, so a copy another tab wrote is never overwritten or
// removed: the server refuses, and the workflow is reported as a conflict
// until resolve() says which copy the tab now knows. A workflow without
// edits removes the copy only when the tab knows one is there. A write that
// fails for another reason (a folder Komposer cannot write, a full disk)
// keeps the edit pending, reports the reason through failed() until a retry
// writes it, and is tried again after retryDelay.
export interface CopyWrite {
  text: string;
  // The hash of the original the edits were made from.
  base: string;
}
export function workingCopySaver(deps: {
  put: (path: string, write: CopyWrite, expected: string | null, urgent: boolean) => Promise<{ hash: string }>;
  remove: (path: string, expected: string | null, urgent: boolean) => Promise<unknown>;
  // Whether a failed request was refused because another tab changed the copy.
  isConflict: (error: unknown) => boolean;
  conflict: (path: string) => void;
  error: (error: unknown) => void;
  // Why a workflow's edits are not written, or null once they are.
  failed?: (path: string, reason: string | null) => void;
  delay: number;
  retryDelay?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}) {
  const setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = deps.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const known = new Map<string, string | null>();
  const wanted = new Map<string, CopyWrite | null>();
  const timers = new Map<string, unknown>();
  const queues = new Map<string, Promise<void>>();
  const conflicts = new Set<string>();
  const failures = new Map<string, string>();
  // Paths whose save was confirmed: listings read meanwhile do not change
  // what the tab knows, so the save's cleanup removes only the copy the tab
  // knew or wrote itself, never one another tab wrote meanwhile.
  const holds = new Set<string>();
  // Bumped when a workflow's edits are given up (drop, or resolve without
  // keepMine), so a request already sent does not bring them back if it fails.
  const generations = new Map<string, number>();
  const cancel = (path: string) => generations.set(path, (generations.get(path) ?? 0) + 1);
  const unfail = (path: string) => {
    if (failures.delete(path)) deps.failed?.(path, null);
  };
  let writes = 0;
  // Requests sent and not yet answered.
  let inFlight = 0;

  // One request at a time per workflow, each deciding from what the tab
  // knows when it runs.
  const enqueue = (path: string, step: () => Promise<void>) => {
    const next = (queues.get(path) ?? Promise.resolve()).then(step);
    queues.set(path, next);
    return next;
  };
  const send = (path: string, urgent: boolean) =>
    enqueue(path, async () => {
      if (!wanted.has(path) || conflicts.has(path)) return;
      const want = wanted.get(path)!;
      wanted.delete(path);
      const expected = known.get(path) ?? null;
      if (want === null && expected === null) return;
      const generation = generations.get(path) ?? 0;
      inFlight++;
      try {
        if (want === null) {
          await deps.remove(path, expected, urgent);
          known.set(path, null);
        } else known.set(path, (await deps.put(path, want, expected, urgent)).hash);
        writes++;
        unfail(path);
      } catch (e) {
        // Given up while the request was in flight: nothing to recover.
        if ((generations.get(path) ?? 0) !== generation) return;
        // Kept, so the tab's own edits are written once the conflict is
        // resolved or a retry succeeds.
        if (!wanted.has(path)) wanted.set(path, want);
        if (!deps.isConflict(e)) {
          const reason = e instanceof Error ? e.message : String(e);
          if (failures.get(path) !== reason) {
            failures.set(path, reason);
            deps.failed?.(path, reason);
            deps.error(e);
          }
          if (!timers.has(path)) timers.set(path, setTimer(() => void flushOne(path, false), deps.retryDelay ?? 5000));
          return;
        }
        conflicts.add(path);
        deps.conflict(path);
      } finally {
        inFlight--;
      }
    });
  const flushOne = (path: string, urgent: boolean) => {
    clearTimer(timers.get(path));
    timers.delete(path);
    return send(path, urgent);
  };

  return {
    // The copy the server holds, as a listing read it; null for none.
    known(path: string, hash: string | null): void {
      if (!holds.has(path)) known.set(path, hash);
    },
    // A save of the workflow was confirmed: until drop() or release(),
    // listings do not change the copy the tab knows.
    hold(path: string): void {
      holds.add(path);
    },
    // The confirmed save did not write the file: listings count again.
    release(path: string): void {
      holds.delete(path);
    },
    // The working copy a workflow should have: its edits, or null for none.
    want(path: string, write: CopyWrite | null): void {
      wanted.set(path, write);
      clearTimer(timers.get(path));
      timers.set(path, setTimer(() => void flushOne(path, false), deps.delay));
    },
    // Sends every pending write now; urgent ones outlive the page.
    flush(urgent = false): Promise<void> {
      return Promise.all([...wanted.keys()].map((path) => flushOne(path, urgent))).then(() => {});
    },
    // Removes the copy after a Save, Discard or Load disk version. A copy
    // another tab wrote meanwhile stays: it holds that tab's edits.
    drop(path: string): Promise<void> {
      clearTimer(timers.get(path));
      timers.delete(path);
      wanted.delete(path);
      conflicts.delete(path);
      unfail(path);
      cancel(path);
      return enqueue(path, async () => {
        const expected = known.get(path) ?? null;
        holds.delete(path);
        if (expected === null) return;
        inFlight++;
        try {
          await deps.remove(path, expected, false);
          known.set(path, null);
          writes++;
        } catch (e) {
          if (!deps.isConflict(e)) throw e;
        } finally {
          inFlight--;
        }
      });
    },
    // After a conflict: the copy the tab now knows the server holds. With
    // keepMine, the tab's pending edits are written over it; otherwise they
    // are given up, as when the tab loads the other tab's copy.
    resolve(path: string, hash: string | null, keepMine: boolean): Promise<void> {
      known.set(path, hash);
      conflicts.delete(path);
      if (!keepMine) {
        wanted.delete(path);
        unfail(path);
        cancel(path);
      }
      return flushOne(path, false);
    },
    inConflict: (path: string) => conflicts.has(path),
    // Why a workflow's edits could not be written, or undefined.
    failure: (path: string) => failures.get(path),
    // Whether the page would lose an edit if it unloaded now: a request is
    // in flight, so a write sent as the page unloads queues behind it and
    // may never be sent, or a conflict or a failed write holds edits back.
    // The page asks before it unloads while this holds; a pending write
    // alone is sent at once by flush(true).
    busy: () => inFlight > 0 || [...wanted.keys()].some((path) => conflicts.has(path) || failures.has(path)),
    // How many writes completed, so a listing read meanwhile is known to be stale.
    writes: () => writes,
  };
}
