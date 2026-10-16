// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { diskChangeAction } from "../src/model/diskChange.ts";

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
