// SPDX-License-Identifier: Apache-2.0
// The Present page's model: what the Show toggles leave in the legend, which
// workflows the "Side by side with" picker offers, which second workflow is
// shown, when a drawer is open, and what Escape does on each page.

import { describe, expect, test } from "bun:test";
import {
  ALL_SHOWN,
  STEPS_ONLY,
  drawerOpen,
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
