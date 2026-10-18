// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  diskChangeAction,
  diskChangeWatcher,
  editorTakesEdits,
  restoredWorkingCopy,
  workingCopySaver,
} from "../src/model/diskChange.ts";

const saved = { text: "steps: [a]\n", hash: "h-saved" };

describe("editorTakesEdits", () => {
  test("a save that is writing the file makes the editor read-only, since its completion replaces the text", () => {
    expect(editorTakesEdits({ readOnly: false, dialog: { type: "save", saving: true } })).toBe(false);
  });

  test("edits resume once the save is done, and while its checks still run", () => {
    expect(editorTakesEdits({ readOnly: false, dialog: null })).toBe(true);
    expect(editorTakesEdits({ readOnly: false, dialog: { type: "save", saving: false } })).toBe(true);
    expect(editorTakesEdits({ readOnly: false, dialog: { type: "new" } })).toBe(true);
  });

  test("a read-only workflow takes no edits whatever the dialog", () => {
    expect(editorTakesEdits({ readOnly: true, dialog: null })).toBe(false);
  });
});

describe("diskChangeAction", () => {
  test("the editor's own save, reported before the editor recorded it, needs no banner", () => {
    // The file was "steps: [a]", the edit made it "steps: [b]", and Save
    // wrote that; the watcher's event arrives while the editor still holds
    // the old hash and the edit as unsaved.
    const open = { ...saved, openText: "steps: [b]\n" };
    expect(diskChangeAction(open, { text: "steps: [b]\n", hash: "h-b" })).toBe("adopt");
  });

  test("the editor's own save, reported after the editor recorded it, is ignored", () => {
    const open = { text: "steps: [b]\n", hash: "h-b", openText: "steps: [b]\n" };
    expect(diskChangeAction(open, { text: "steps: [b]\n", hash: "h-b" })).toBe("ignore");
  });

  test("an outside change to the text the editor already has is adopted without asking", () => {
    const open = { ...saved, openText: "steps: [c]\n" };
    expect(diskChangeAction(open, { text: "steps: [c]\n", hash: "h-c" })).toBe("adopt");
  });

  test("an outside change with no unsaved edits reloads the file", () => {
    const open = { ...saved, openText: saved.text };
    expect(diskChangeAction(open, { text: "steps: [c]\n", hash: "h-c" })).toBe("reload");
  });

  test("an outside change that differs from unsaved edits is a conflict", () => {
    const open = { ...saved, openText: "steps: [b]\n" };
    expect(diskChangeAction(open, { text: "steps: [c]\n", hash: "h-c" })).toBe("conflict");
  });
});

// The watcher's events each ask the server for the file; the answers can
// arrive in another order than the events.
describe("diskChangeWatcher", () => {
  type Disk = { text: string; hash: string };
  const B = { text: "steps: [b]\n", hash: "h-b" };
  const C = { text: "steps: [c]\n", hash: "h-c" };

  function setup() {
    let open = { ...saved, openText: saved.text };
    const pending: ((disk: Disk) => void)[] = [];
    const applied: [string, Disk][] = [];
    const watcher = diskChangeWatcher({
      open: () => open,
      fetch: () => new Promise<Disk>((answer) => pending.push(answer)),
      apply: (action, _open, disk) => {
        applied.push([action, disk]);
        open = { text: disk.text, hash: disk.hash, openText: disk.text };
      },
    });
    return { watcher, pending, applied };
  }

  test("an older answer that arrives after a newer one is dropped", async () => {
    const { watcher, pending, applied } = setup();
    const first = watcher.change(B.hash);
    const second = watcher.change(C.hash);
    pending[1](C);
    await second;
    pending[0](B);
    await first;
    expect(applied).toEqual([["reload", C]]);
  });

  test("an answer that arrives after the watch was closed is dropped", async () => {
    const { watcher, pending, applied } = setup();
    const change = watcher.change(B.hash);
    watcher.close();
    pending[0](B);
    await change;
    expect(applied).toEqual([]);
  });

  test("an event for the hash the editor already has still makes an earlier answer stale", async () => {
    const { watcher, pending, applied } = setup();
    const first = watcher.change(B.hash);
    // The editor's own save of the text it holds: nothing to ask the server.
    await watcher.change(saved.hash);
    expect(pending).toHaveLength(1);
    pending[0](B);
    await first;
    expect(applied).toEqual([]);
  });

  test("answers in order are each applied", async () => {
    const { watcher, pending, applied } = setup();
    const first = watcher.change(B.hash);
    pending[0](B);
    await first;
    const second = watcher.change(C.hash);
    pending[1](C);
    await second;
    expect(applied).toEqual([
      ["reload", B],
      ["reload", C],
    ]);
  });
});

// A working copy restored after a reload, made from the file as it was then.
describe("restoredWorkingCopy", () => {
  const listed = { onDisk: true, text: "steps: [c]\n", hash: "h-c", workingCopy: "steps: [b]\n" };

  test("a copy made from another version of the file than the one on disk is a conflict", () => {
    const restored = restoredWorkingCopy({ ...listed, workingCopyBase: "h-a" });
    // Save then sends the hash the edits were made from, and is refused.
    expect(restored.file.hash).toBe("h-a");
    expect(restored.disk).toEqual({ text: "steps: [c]\n", hash: "h-c" });
  });

  test("a copy made from the file on disk, or one that already holds its text, is restored as it is", () => {
    expect(restoredWorkingCopy({ ...listed, workingCopyBase: "h-c" })).toEqual({ file: { ...listed, workingCopyBase: "h-c" } });
    const same = { ...listed, workingCopy: listed.text, workingCopyBase: "h-a" };
    expect(restoredWorkingCopy(same)).toEqual({ file: same });
  });

  test("a copy without a recorded base, written before bases were kept, is a conflict whose base is unknown", () => {
    const restored = restoredWorkingCopy(listed);
    // No file on disk has the empty hash, so Save is refused and the copy's
    // own base does not take the file on disk until the user chooses.
    expect(restored.file.hash).toBe("");
    expect(restored.file.workingCopy).toBe(listed.workingCopy);
    expect(restored.disk).toEqual({ text: "steps: [c]\n", hash: "h-c", unknownBase: true });
    // One that already holds the file's text has no edits to lose.
    const same = { ...listed, workingCopy: listed.text };
    expect(restoredWorkingCopy(same)).toEqual({ file: same });
  });

  test("a new workflow's copy is restored as it is", () => {
    const created = { ...listed, onDisk: false, text: "", hash: "", workingCopyBase: "h-x" };
    expect(restoredWorkingCopy(created)).toEqual({ file: created });
  });
});

describe("workingCopySaver", () => {
  class Conflict extends Error {}
  // A server holding one working copy per path, which refuses a write from a
  // tab that saw another copy than the one it holds.
  function setup(held: Record<string, string> = {}) {
    const server = new Map(Object.entries(held));
    const timers: (() => void)[] = [];
    const conflicts: string[] = [];
    const check = (path: string, expected: string | null) => {
      if ((server.get(path) ?? null) !== expected) throw new Conflict();
    };
    const saver = workingCopySaver({
      put: async (path, write, expected) => {
        check(path, expected);
        server.set(path, `hash of ${write.text}`);
        return { hash: `hash of ${write.text}` };
      },
      remove: async (path, expected) => {
        check(path, expected);
        server.delete(path);
      },
      isConflict: (e) => e instanceof Conflict,
      conflict: (path) => conflicts.push(path),
      error: (e) => {
        throw e;
      },
      delay: 350,
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    const fire = async () => {
      for (const run of timers.splice(0)) run();
      await saver.flush();
    };
    return { saver, server, timers, conflicts, fire };
  }

  test("an edit is written although another workflow was selected before the delay ran out", async () => {
    const { saver, server, fire } = setup();
    saver.want("/a.yml", { text: "a edited", base: "h-a" });
    // Selecting b: its text has no edits, and it has no copy.
    saver.want("/b.yml", null);
    await fire();
    expect(server.get("/a.yml")).toBe("hash of a edited");
    expect(server.has("/b.yml")).toBe(false);
  });

  test("the saver is busy while a request is in flight, so an edit flushed on unload would wait behind it", async () => {
    let release = () => {};
    const sent: string[] = [];
    const saver = workingCopySaver({
      put: (_path, write) => {
        sent.push(write.text);
        return new Promise((done) => (release = () => done({ hash: `hash of ${write.text}` })));
      },
      remove: async () => {},
      isConflict: () => false,
      conflict: () => {},
      error: (e) => {
        throw e;
      },
      delay: 350,
      setTimer: () => 0,
      clearTimer: () => {},
    });
    expect(saver.busy()).toBe(false);
    saver.want("/a.yml", { text: "first", base: "h-a" });
    // A pending write alone is sent at once on unload.
    expect(saver.busy()).toBe(false);
    const first = saver.flush();
    await Promise.resolve();
    expect(sent).toEqual(["first"]);
    // The latest edit, flushed as the page unloads, waits behind the first.
    saver.want("/a.yml", { text: "latest", base: "h-a" });
    const latest = saver.flush(true);
    expect(saver.busy()).toBe(true);
    release();
    await first;
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["first", "latest"]);
    expect(saver.busy()).toBe(true);
    release();
    await latest;
    expect(saver.busy()).toBe(false);
  });

  test("a write that fails for another reason than a conflict keeps the edit pending, reported, until a retry writes it", async () => {
    let refuse = true;
    const timers: (() => void)[] = [];
    const errors: string[] = [];
    const failures: [string, string | null][] = [];
    const server = new Map<string, string>();
    const saver = workingCopySaver({
      put: async (path, write) => {
        if (refuse) throw new Error("EACCES: permission denied");
        server.set(path, write.text);
        return { hash: `hash of ${write.text}` };
      },
      remove: async () => {},
      isConflict: () => false,
      conflict: () => {},
      error: (e) => errors.push((e as Error).message),
      failed: (path, reason) => failures.push([path, reason]),
      delay: 350,
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    saver.want("/a.yml", { text: "edit", base: "h-a" });
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(errors).toEqual(["EACCES: permission denied"]);
    expect(failures).toEqual([["/a.yml", "EACCES: permission denied"]]);
    // The edit is not lost: the page asks before it unloads, and a retry is due.
    expect(saver.busy()).toBe(true);
    expect(timers.length).toBe(1);
    // A retry that fails again for the same reason does not report it again.
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(errors.length).toBe(1);
    refuse = false;
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(server.get("/a.yml")).toBe("edit");
    expect(failures).toEqual([
      ["/a.yml", "EACCES: permission denied"],
      ["/a.yml", null],
    ]);
    expect(saver.busy()).toBe(false);
  });

  test("the saver is busy while a conflict holds edits back", async () => {
    const { saver, fire } = setup({ "/a.yml": "hash of tab A" });
    saver.known("/a.yml", null);
    saver.want("/a.yml", { text: "tab B", base: "h-a" });
    await fire();
    expect(saver.busy()).toBe(true);
    await saver.resolve("/a.yml", "hash of tab A", false);
    expect(saver.busy()).toBe(false);
  });

  test("pending edits are written at once when the page is hidden", async () => {
    const { saver, server } = setup();
    saver.want("/a.yml", { text: "a edited", base: "h-a" });
    await saver.flush(true);
    expect(server.get("/a.yml")).toBe("hash of a edited");
  });

  test("a tab without edits leaves alone a copy it does not know, as one another tab wrote", async () => {
    const { saver, server, conflicts, fire } = setup({ "/a.yml": "hash of tab A" });
    saver.known("/a.yml", null);
    saver.want("/a.yml", null);
    await fire();
    expect(server.get("/a.yml")).toBe("hash of tab A");
    expect(conflicts).toEqual([]);
  });

  test("an edit over a copy another tab wrote is a conflict, held until the user keeps it", async () => {
    const { saver, server, conflicts, fire } = setup({ "/a.yml": "hash of tab A" });
    saver.known("/a.yml", null);
    saver.want("/a.yml", { text: "tab B", base: "h-a" });
    await fire();
    expect(conflicts).toEqual(["/a.yml"]);
    expect(server.get("/a.yml")).toBe("hash of tab A");
    // Further edits wait while the conflict stands.
    saver.want("/a.yml", { text: "tab B again", base: "h-a" });
    await fire();
    expect(server.get("/a.yml")).toBe("hash of tab A");
    await saver.resolve("/a.yml", "hash of tab A", true);
    expect(server.get("/a.yml")).toBe("hash of tab B again");
  });

  test("loading the other tab's copy gives up this tab's pending edits", async () => {
    const { saver, server, fire } = setup({ "/a.yml": "hash of tab A" });
    saver.known("/a.yml", null);
    saver.want("/a.yml", { text: "tab B", base: "h-a" });
    await fire();
    await saver.resolve("/a.yml", "hash of tab A", false);
    expect(server.get("/a.yml")).toBe("hash of tab A");
  });

  test("after a save the tab's own copy is removed, and another tab's newer copy stays", async () => {
    const { saver, server, fire } = setup();
    saver.want("/a.yml", { text: "mine", base: "h-a" });
    await fire();
    await saver.drop("/a.yml");
    expect(server.has("/a.yml")).toBe(false);

    saver.want("/a.yml", { text: "mine", base: "h-a" });
    await fire();
    server.set("/a.yml", "hash of the other tab");
    await saver.drop("/a.yml");
    expect(server.get("/a.yml")).toBe("hash of the other tab");
  });

  test("a save cancels a pending write of the same workflow", async () => {
    const { saver, server, fire } = setup();
    saver.want("/a.yml", { text: "mine", base: "h-a" });
    await saver.drop("/a.yml");
    await fire();
    expect(server.has("/a.yml")).toBe(false);
    expect(saver.writes()).toBe(0);
  });

  test("a listing read during a save does not let the save's cleanup remove another tab's copy", async () => {
    const { saver, server, fire } = setup();
    saver.want("/a.yml", { text: "mine", base: "h-a" });
    await fire();
    // The save is confirmed; then another tab writes its copy and a refresh
    // reads it while the save is still writing the file.
    saver.hold("/a.yml");
    server.set("/a.yml", "hash of the other tab");
    saver.known("/a.yml", "hash of the other tab");
    await saver.drop("/a.yml");
    expect(server.get("/a.yml")).toBe("hash of the other tab");
    // The hold ends with the drop: later listings are taken up again.
    saver.known("/a.yml", "hash of the other tab");
    await saver.drop("/a.yml");
    expect(server.has("/a.yml")).toBe(false);
  });

  test("the tab's own write after a save was confirmed is still removed by its cleanup", async () => {
    const { saver, server, timers } = setup();
    saver.want("/a.yml", { text: "mine", base: "h-a" });
    saver.hold("/a.yml");
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(server.get("/a.yml")).toBe("hash of mine");
    await saver.drop("/a.yml");
    expect(server.has("/a.yml")).toBe(false);
  });

  test("a released hold takes up listings again", async () => {
    const { saver, server } = setup({ "/a.yml": "hash of the other tab" });
    saver.hold("/a.yml");
    saver.release("/a.yml");
    saver.known("/a.yml", "hash of the other tab");
    await saver.drop("/a.yml");
    expect(server.has("/a.yml")).toBe(false);
  });

  // A saver whose writes wait until the test answers them.
  function deferred() {
    const server = new Map<string, string>();
    const answers: { ok: () => void; no: (e: Error) => void }[] = [];
    const conflicts: string[] = [];
    const errors: string[] = [];
    const timers: (() => void)[] = [];
    let hold = true;
    const saver = workingCopySaver({
      put: (path, write) => {
        const apply = () => {
          server.set(path, `hash of ${write.text}`);
          return { hash: `hash of ${write.text}` };
        };
        if (!hold) return Promise.resolve(apply());
        return new Promise((ok, no) => answers.push({ ok: () => ok(apply()), no }));
      },
      remove: async (path) => {
        server.delete(path);
      },
      isConflict: (e) => e instanceof Conflict,
      conflict: (path) => conflicts.push(path),
      error: (e) => errors.push((e as Error).message),
      delay: 350,
      setTimer: (run) => timers.push(run),
      clearTimer: () => {},
    });
    const answer = () => answers.shift()!;
    return { saver, server, conflicts, errors, timers, answer, release: () => (hold = false) };
  }

  test("dropping a copy cancels the recovery of a write already sent that then fails", async () => {
    const { saver, server, errors, timers, answer, release } = deferred();
    saver.want("/a.yml", { text: "discarded", base: "h-a" });
    timers.splice(0);
    const pending = saver.flush();
    await Promise.resolve();
    const dropped = saver.drop("/a.yml");
    answer().no(new Error("EACCES"));
    await pending;
    await dropped;
    expect(errors).toEqual([]);
    expect(saver.busy()).toBe(false);
    expect(saver.failure("/a.yml")).toBeUndefined();
    release();
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(server.has("/a.yml")).toBe(false);
  });

  test("dropping a copy cancels the recovery of a write already sent that then conflicts", async () => {
    const { saver, server, conflicts, timers, answer, release } = deferred();
    saver.want("/a.yml", { text: "discarded", base: "h-a" });
    timers.splice(0);
    const pending = saver.flush();
    await Promise.resolve();
    const dropped = saver.drop("/a.yml");
    answer().no(new Conflict());
    await pending;
    await dropped;
    expect(conflicts).toEqual([]);
    expect(saver.inConflict("/a.yml")).toBe(false);
    expect(saver.busy()).toBe(false);
    release();
    await saver.flush();
    expect(server.has("/a.yml")).toBe(false);
  });

  test("giving up a tab's edits cancels the recovery of a write already sent that then fails", async () => {
    const { saver, server, errors, timers, answer, release } = deferred();
    saver.want("/a.yml", { text: "given up", base: "h-a" });
    timers.splice(0);
    const pending = saver.flush();
    await Promise.resolve();
    const resolved = saver.resolve("/a.yml", "hash of the other tab", false);
    answer().no(new Error("EACCES"));
    await pending;
    await resolved;
    expect(errors).toEqual([]);
    expect(saver.busy()).toBe(false);
    release();
    for (const run of timers.splice(0)) run();
    await saver.flush();
    expect(server.has("/a.yml")).toBe(false);
  });

  test("a new edit after a drop is still recovered when its own write fails", async () => {
    const { saver, errors, timers, answer } = deferred();
    saver.want("/a.yml", { text: "discarded", base: "h-a" });
    await saver.drop("/a.yml");
    saver.want("/a.yml", { text: "new edit", base: "h-b" });
    timers.splice(0);
    const pending = saver.flush();
    await Promise.resolve();
    answer().no(new Error("EACCES"));
    await pending;
    expect(errors).toEqual(["EACCES"]);
    expect(saver.busy()).toBe(true);
  });
});
