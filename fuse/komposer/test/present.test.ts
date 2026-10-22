// SPDX-License-Identifier: Apache-2.0
// The Present page's model: what the Show toggles leave in the legend, which
// workflows the "Side by side with" picker offers, which second workflow is
// shown, when a drawer is open, and what Escape does on each page.

import { describe, expect, test } from "bun:test";
import {
  ALL_SHOWN,
  DRAWER_CLOSE_DELAY,
  STEPS_ONLY,
  createDrawerHover,
  drawerOpen,
  pointerOnDrawer,
  escapeAction,
  releasesFocus,
  legendEntries,
  secondOptions,
  shownSecond,
} from "../src/model/present.ts";

const wf = (path: string, location = "project") => ({ path, location });

describe("legendEntries", () => {
  test("everything shown lists every legend entry", () => {
    expect(legendEntries(ALL_SHOWN)).toEqual({ consumes: true, routes: true, artifacts: true, gates: true });
  });
  test("each entry follows its own toggle", () => {
    expect(legendEntries({ ...ALL_SHOWN, consumes: false })).toEqual({ consumes: false, routes: true, artifacts: true, gates: true });
    expect(legendEntries({ ...ALL_SHOWN, routes: false }).routes).toBe(false);
    expect(legendEntries({ ...ALL_SHOWN, artifacts: false }).artifacts).toBe(false);
    expect(legendEntries({ ...ALL_SHOWN, gates: false }).gates).toBe(false);
  });
  test("phases, descriptions and conditions have no legend entry", () => {
    expect(legendEntries({ ...STEPS_ONLY, phases: true, descriptions: true, conditions: true })).toEqual({
      consumes: false,
      routes: false,
      artifacts: false,
      gates: false,
    });
  });
});

describe("Show all and Steps only", () => {
  test("Show all turns on all seven toggles, Steps only turns them off", () => {
    expect(Object.keys(ALL_SHOWN).sort()).toEqual(
      ["artifacts", "conditions", "consumes", "descriptions", "gates", "phases", "routes"],
    );
    expect(Object.values(ALL_SHOWN).every((on) => on)).toBe(true);
    expect(Object.keys(STEPS_ONLY).sort()).toEqual(Object.keys(ALL_SHOWN).sort());
    expect(Object.values(STEPS_ONLY).some((on) => on)).toBe(false);
  });
});

describe("secondOptions", () => {
  const list = [wf("/p/a.yml"), wf("/p/b.yml", "personal"), wf("/o/c.yml", "run"), wf("/f/d.yml", "fuse-flow")];
  test("offers every workflow of the three locations except the shown one", () => {
    expect(secondOptions(list, "/p/a.yml").map((w) => w.path)).toEqual(["/p/b.yml", "/f/d.yml"]);
  });
  test("never offers another project's workflow", () => {
    expect(secondOptions(list, null).map((w) => w.path)).toEqual(["/p/a.yml", "/p/b.yml", "/f/d.yml"]);
  });
});

describe("shownSecond", () => {
  const list = [wf("/p/a.yml"), wf("/p/b.yml"), wf("/o/c.yml", "run")];
  test("shows the chosen workflow next to the selected one", () => {
    expect(shownSecond(list, "/p/a.yml", "/p/b.yml")).toBe("/p/b.yml");
  });
  test("shows none when nothing is chosen", () => {
    expect(shownSecond(list, "/p/a.yml", null)).toBeNull();
  });
  test("shows none when the selected workflow became the chosen one", () => {
    expect(shownSecond(list, "/p/b.yml", "/p/b.yml")).toBeNull();
  });
  test("shows none when the chosen workflow is no longer offered", () => {
    expect(shownSecond(list, "/p/a.yml", "/p/gone.yml")).toBeNull();
    expect(shownSecond(list, "/p/a.yml", "/o/c.yml")).toBeNull();
  });
});

describe("drawerOpen", () => {
  test("a drawer is closed unless pinned, hovered or holding focus", () => {
    expect(drawerOpen({ pinned: false, hovered: false, focused: false })).toBe(false);
    expect(drawerOpen({ pinned: true, hovered: false, focused: false })).toBe(true);
    expect(drawerOpen({ pinned: false, hovered: true, focused: false })).toBe(true);
  });
  test("focus inside keeps it open after the pointer leaves, as while a select is open", () => {
    expect(drawerOpen({ pinned: false, hovered: false, focused: true })).toBe(true);
  });
});

// A drawer hover on a fake clock: fire(ms) runs the timers due within ms.
function hoverOnClock() {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  const states: boolean[] = [];
  const hover = createDrawerHover({
    setTimer: (run, ms) => {
      timers.set(next, { at: now + ms, run });
      return next++;
    },
    clearTimer: (id) => {
      if (id !== undefined) timers.delete(id);
    },
    render: (hovered) => states.push(hovered),
  });
  const fire = (ms: number) => {
    now += ms;
    for (const [id, t] of [...timers]) if (t.at <= now) {
      timers.delete(id);
      t.run();
    }
  };
  return { hover, states, fire };
}

describe("createDrawerHover", () => {
  test("opens at once and closes only after the pointer stayed away for the delay", () => {
    const { hover, states, fire } = hoverOnClock();
    hover.pointer(true);
    expect(states).toEqual([true]);
    hover.pointer(false);
    fire(DRAWER_CLOSE_DELAY - 1);
    expect(states).toEqual([true]);
    fire(1);
    expect(states).toEqual([true, false]);
  });
  test("stays open when the pointer goes briefly out and back in", () => {
    const { hover, states, fire } = hoverOnClock();
    hover.pointer(true);
    hover.pointer(false);
    fire(DRAWER_CLOSE_DELAY - 500);
    hover.pointer(true);
    fire(DRAWER_CLOSE_DELAY);
    expect(states).toEqual([true]);
  });
  test("the delay runs from the moment the pointer left, not from its last move outside", () => {
    const { hover, states, fire } = hoverOnClock();
    hover.pointer(true);
    hover.pointer(false);
    fire(2000);
    hover.pointer(false);
    fire(DRAWER_CLOSE_DELAY - 2000);
    expect(states).toEqual([true, false]);
  });
  test("a release closes at once and keeps it closed until the pointer left and came back", () => {
    const { hover, states } = hoverOnClock();
    hover.pointer(true);
    hover.release();
    hover.pointer(true);
    expect(states).toEqual([true, false]);
    hover.pointer(false);
    hover.pointer(true);
    expect(states).toEqual([true, false, true]);
  });
});

describe("pointerOnDrawer", () => {
  test("the tooltip of a row in the drawer counts as the drawer", () => {
    expect(pointerOnDrawer({ inDrawer: false, onTip: true, tipAnchorInDrawer: true })).toBe(true);
  });
  test("another element's tooltip, or the page outside, does not", () => {
    expect(pointerOnDrawer({ inDrawer: false, onTip: true, tipAnchorInDrawer: false })).toBe(false);
    expect(pointerOnDrawer({ inDrawer: false, onTip: false, tipAnchorInDrawer: true })).toBe(false);
  });
  test("the drawer itself does", () => {
    expect(pointerOnDrawer({ inDrawer: true, onTip: false, tipAnchorInDrawer: false })).toBe(true);
  });
});

describe("releasesFocus", () => {
  test("a control clicked with the mouse gives up focus when the drawer would close", () => {
    expect(releasesFocus({ field: false, keyboard: false })).toBe(true);
  });
  test("a field keeps focus, and the drawer with it, as the lane search or an open select", () => {
    expect(releasesFocus({ field: true, keyboard: false })).toBe(false);
  });
  test("a control reached with the keyboard keeps focus, and the drawer with it", () => {
    expect(releasesFocus({ field: false, keyboard: true })).toBe(false);
  });
});

describe("escapeAction", () => {
  const base = { typing: false, railOpen: false, selected: null as number | null, pinned: false };
  test("in a field Escape only leaves the field, on every page with fields", () => {
    for (const page of ["edit", "compare", "present"] as const)
      expect(escapeAction({ ...base, page, typing: true, railOpen: true, pinned: true })).toBe("blur");
  });
  test("on Edit and Compare it closes the rail, then clears the selection", () => {
    expect(escapeAction({ ...base, page: "edit", railOpen: true, selected: 2 })).toBe("close-rail");
    expect(escapeAction({ ...base, page: "compare", selected: 2 })).toBe("clear-selection");
    expect(escapeAction({ ...base, page: "edit" })).toBe("none");
  });
  test("on Present it un-pins the drawers and never touches the hidden rail or the selection", () => {
    expect(escapeAction({ ...base, page: "present", pinned: true, railOpen: true, selected: 1 })).toBe("unpin");
    expect(escapeAction({ ...base, page: "present", railOpen: true, selected: 1 })).toBe("none");
  });
  test("on Edit a pinned Present drawer is not Escape's business", () => {
    expect(escapeAction({ ...base, page: "edit", pinned: true })).toBe("none");
  });
  test("on Workstreams Escape does nothing", () => {
    expect(escapeAction({ ...base, page: "workstreams", typing: true, railOpen: true, selected: 0, pinned: true })).toBe("none");
  });
});
