// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { diskChangeAction, diskChangeWatcher } from "../src/model/diskChange.ts";

const saved = { text: "steps: [a]\n", hash: "h-saved" };

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
