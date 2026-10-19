// SPDX-License-Identifier: Apache-2.0
// When Komposer's tooltip opens, which tip it shows and when it closes, on a
// fake page: anchors with a text, a pointer that is on an anchor, on the tip
// or elsewhere, keyboard focus, and a clock that moves only when told.

import { describe, expect, test } from "bun:test";
import { CLOSE_DELAY, createTooltip, OPEN_DELAY, WARM_MS } from "../src/model/tooltip.ts";

type Anchor = { name: string; text: string | null; connected: boolean };

function page() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const state = {
    pointer: null as Anchor | "tip" | null,
    focused: null as Anchor | null,
  };
  const tip = createTooltip<Anchor, string>({
    now: () => time,
    setTimer: (run, ms) => {
      timers.set(nextId, { at: time + ms, run });
      return nextId++;
    },
    clearTimer: (id) => {
      if (id !== undefined) timers.delete(id);
    },
    connected: (a) => a.connected,
    text: (a) => a.text,
    pointerHolds: (a) => state.pointer === a || state.pointer === "tip",
    focusHolds: (a) => state.focused === a,
    render: () => {},
  });
  const wait = (ms: number) => {
    const until = time + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((x, y) => x[1].at - y[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      time = due[1].at;
      due[1].run();
    }
    time = until;
  };
  const anchor = (name: string, text: string | null = name): Anchor => ({ name, text, connected: true });
  // The pointer moves onto an anchor, onto the tip, or onto plain content.
  const move = (to: Anchor | "tip" | null) => {
    state.pointer = to;
    tip.pointerOver(to === "tip" ? null : to, to === "tip");
  };
  const showing = () => tip.shown()?.content ?? null;
  return { tip, state, wait, anchor, move, showing };
}

describe("opening", () => {
  test("hover opens after the delay; leaving before it opens nothing", () => {
    const p = page();
    const a = p.anchor("Move up");
    p.move(a);
    p.wait(OPEN_DELAY - 1);
    expect(p.showing()).toBeNull();
    p.wait(1);
    expect(p.showing()).toBe("Move up");

    const q = page();
    q.move(q.anchor("b"));
    q.wait(OPEN_DELAY / 2);
    q.move(null);
    q.wait(OPEN_DELAY * 4);
    expect(q.showing()).toBeNull();
  });

  test("a press and keyboard focus open at once", () => {
    const p = page();
    p.tip.press(p.anchor("pressed"), false);
    expect(p.showing()).toBe("pressed");
    const q = page();
    q.tip.focus(q.anchor("focused"));
    expect(q.showing()).toBe("focused");
  });

  test("just after a tip closed, the next one opens at once; later it waits again", () => {
    const p = page();
    const [a, b, c] = [p.anchor("a"), p.anchor("b"), p.anchor("c")];
    p.tip.press(a, false);
    p.move(null);
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
    p.move(b);
    expect(p.showing()).toBe("b");
    p.move(null);
    p.wait(CLOSE_DELAY + WARM_MS);
    p.move(c);
    expect(p.showing()).toBeNull();
    p.wait(OPEN_DELAY);
    expect(p.showing()).toBe("c");
  });

  test("a tip reads its text when it opens: changed, removed or gone during the delay", () => {
    const p = page();
    const a = p.anchor("old");
    p.move(a);
    a.text = "new";
    p.wait(OPEN_DELAY);
    expect(p.showing()).toBe("new");

    for (const change of [(x: Anchor) => (x.text = null), (x: Anchor) => (x.connected = false)]) {
      const q = page();
      const b = q.anchor("b");
      q.move(b);
      change(b);
      q.wait(OPEN_DELAY);
      expect(q.showing()).toBeNull();
    }
  });

  test("moving from a waiting anchor onto one without a text opens nothing", () => {
    for (const text of ["", null]) {
      const p = page();
      p.move(p.anchor("a"));
      p.wait(OPEN_DELAY / 3);
      p.move(p.anchor("empty", text));
      p.wait(OPEN_DELAY);
      expect(p.showing()).toBeNull();
      p.wait(OPEN_DELAY * 4);
      expect(p.showing()).toBeNull();
    }
  });

  test("a tip opened at once that nothing holds closes a moment later", () => {
    const p = page();
    p.tip.press(p.anchor("pressed"), false);
    expect(p.showing()).toBe("pressed");
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
  });

  test("an element without a text opens nothing", () => {
    const p = page();
    p.move(p.anchor("x", ""));
    p.tip.press(p.anchor("y", null), false);
    p.wait(OPEN_DELAY * 2);
    expect(p.showing()).toBeNull();
  });
});

describe("staying open and closing", () => {
  test("the tip closes a moment after the pointer leaves its anchor", () => {
    const p = page();
    p.tip.press(p.anchor("a"), false);
    p.move(null);
    p.wait(CLOSE_DELAY - 1);
    expect(p.showing()).toBe("a");
    p.wait(1);
    expect(p.showing()).toBeNull();
  });

  test("the pointer can cross onto the tip and stay there, and the tip closes when it leaves", () => {
    const p = page();
    const a = p.anchor("a");
    p.tip.press(a, false);
    p.move(null);
    p.wait(CLOSE_DELAY / 2);
    p.move("tip");
    p.wait(CLOSE_DELAY * 5);
    expect(p.showing()).toBe("a");
    p.move(null);
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
  });

  test("on its way onto the tip, the pointer may cross another anchor without switching", () => {
    const p = page();
    const [a, b] = [p.anchor("a"), p.anchor("b")];
    p.tip.press(a, false);
    p.move(b);
    p.wait(CLOSE_DELAY / 2);
    p.move("tip");
    p.wait(CLOSE_DELAY * 5);
    expect(p.showing()).toBe("a");
  });

  test("resting on another anchor switches to its tip", () => {
    const p = page();
    const [a, b] = [p.anchor("a"), p.anchor("b")];
    p.tip.press(a, false);
    p.move(b);
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBe("b");
  });

  test("keyboard focus holds the tip when the pointer leaves, and losing it closes the tip", () => {
    const p = page();
    const a = p.anchor("a");
    p.state.focused = a;
    p.tip.focus(a);
    p.move(a);
    p.move(null);
    p.wait(CLOSE_DELAY * 5);
    expect(p.showing()).toBe("a");
    p.state.focused = null;
    p.tip.blur();
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
  });

  test("losing focus keeps a tip the pointer is on, the anchor or the tip", () => {
    for (const where of ["anchor", "tip"] as const) {
      const p = page();
      const a = p.anchor("a");
      p.state.focused = a;
      p.tip.focus(a);
      p.move(where === "anchor" ? a : "tip");
      p.state.focused = null;
      p.tip.blur();
      p.wait(CLOSE_DELAY * 5);
      expect(p.showing()).toBe("a");
    }
  });

  test("a rich tip hidden by its anchor stays while the pointer is on it, and closes after", () => {
    const p = page();
    const icon = p.anchor("icon", null);
    p.state.pointer = icon;
    p.tip.show(icon, "field info");
    p.move("tip");
    p.tip.hide(icon);
    p.wait(CLOSE_DELAY * 5);
    expect(p.showing()).toBe("field info");
    p.move(null);
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
  });

  test("a rich tip closes when a switch to another anchor is abandoned", () => {
    const p = page();
    const [icon, b] = [p.anchor("icon", null), p.anchor("b")];
    p.state.pointer = icon;
    p.tip.show(icon, "field info");
    p.tip.hide(icon);
    p.move(b);
    p.wait(CLOSE_DELAY / 3);
    p.move(null);
    p.wait(CLOSE_DELAY * 5);
    expect(p.showing()).toBeNull();
  });

  test("leaving the window closes the tip a moment later", () => {
    const p = page();
    p.tip.press(p.anchor("a"), false);
    p.state.pointer = null;
    p.tip.pointerLeftWindow();
    p.wait(CLOSE_DELAY);
    expect(p.showing()).toBeNull();
  });

  test("Escape and scrolling close the tip at once, even with focus on the anchor", () => {
    const p = page();
    const a = p.anchor("a");
    p.state.focused = a;
    p.tip.focus(a);
    p.tip.dismiss();
    expect(p.showing()).toBeNull();
  });
});

describe("the page changing under a shown tip", () => {
  test("the tip closes when its anchor leaves the page, and follows its text", () => {
    const p = page();
    const a = p.anchor("Save");
    p.state.pointer = a;
    p.tip.press(a, false);
    a.text = "Save failed";
    p.tip.pageChanged();
    expect(p.showing()).toBe("Save failed");
    a.text = null;
    p.tip.pageChanged();
    expect(p.showing()).toBeNull();

    const q = page();
    const b = q.anchor("Delete step");
    q.state.pointer = b;
    q.tip.press(b, false);
    b.connected = false;
    q.tip.pageChanged();
    expect(q.showing()).toBeNull();
  });
});
