// SPDX-License-Identifier: Apache-2.0
// The app's state rules (src/model/appState.ts), driven through the races and
// navigations that review rounds found in App.tsx.

import { describe, expect, test } from "bun:test";
import {
  abandoned,
  answered,
  changed,
  checkedAs,
  closed,
  compareSelection,
  confirmedAs,
  failedRequest,
  loaded,
  namesResolveIn,
  readingFrom,
  savingAs,
  stillConfirmed,
  textChanged,
  type Loaded,
  type SaveDialog,
} from "../src/model/appState.ts";
import { requestSequencer } from "../src/model/listedWorkflows.ts";
import { comparePick } from "../src/model/compare.ts";

// A list of workstream slugs stands for the workstreams in progress.
type Runs = string[];

describe("loaded data and the save dialog's workstreams", () => {
  test("an older answer that arrives last neither replaces the list nor unlocks a dialog (rvk3-client-2)", () => {
    const requests = requestSequencer<"workstreams">();
    let list: Loaded<Runs> = loaded([]);
    const take = (at: number, value: Runs) => (list = answered(list, at, value, requests.current("workstreams", at)));

    // The dialog opens and asks; a focus refresh asks again before either answers.
    const dialogAsked = requests.begin("workstreams");
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "waiting" });
    const refreshAsked = requests.begin("workstreams");
    // The refresh answers first: a workstream started in between.
    take(refreshAsked, ["gated-run"]);
    // The dialog's own, older answer arrives last and is not taken up.
    take(dialogAsked, []);
    expect(list.value).toEqual(["gated-run"]);
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "ready", value: ["gated-run"] });
  });

  test("a dialog waits for an answer to a request made no earlier than it opened", () => {
    const requests = requestSequencer<"workstreams">();
    let list: Loaded<Runs> = loaded([]);
    const refreshAsked = requests.begin("workstreams");
    const dialogAsked = requests.begin("workstreams");
    // The refresh asked before the dialog opened: its answer is not the newest, and not the dialog's.
    list = answered(list, refreshAsked, ["old"], requests.current("workstreams", refreshAsked));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "waiting" });
    list = answered(list, dialogAsked, ["new"], requests.current("workstreams", dialogAsked));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "ready", value: ["new"] });
  });

  test("a failure shows only while no answer as new as the dialog's request was taken up", () => {
    const requests = requestSequencer<"workstreams">();
    let list: Loaded<Runs> = loaded(["earlier"]);
    const dialogAsked = requests.begin("workstreams");
    list = failedRequest(list, dialogAsked, "server down", requests.current("workstreams", dialogAsked));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "failed", error: "server down" });
    // The list keeps its last value for the rest of the app.
    expect(list.value).toEqual(["earlier"]);
    // A newer request answers: the dialog reads it.
    const later = requests.begin("workstreams");
    list = answered(list, later, ["now"], requests.current("workstreams", later));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "ready", value: ["now"] });
    // A failure of a request that is no longer the newest is not taken up.
    const stale = requests.begin("workstreams");
    const newest = requests.begin("workstreams");
    list = failedRequest(list, stale, "late failure", requests.current("workstreams", stale));
    expect(list.failed).toBeUndefined();
    expect(readingFrom(list, newest)).toEqual({ state: "waiting" });
  });

  test("a failure superseded by a newer request keeps the dialog waiting for that one", () => {
    const requests = requestSequencer<"workstreams">();
    let list: Loaded<Runs> = loaded([]);
    const dialogAsked = requests.begin("workstreams");
    const refreshAsked = requests.begin("workstreams");
    list = failedRequest(list, dialogAsked, "timeout", requests.current("workstreams", dialogAsked));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "waiting" });
    list = failedRequest(list, refreshAsked, "server down", requests.current("workstreams", refreshAsked));
    expect(readingFrom(list, dialogAsked)).toEqual({ state: "failed", error: "server down" });
  });
});

describe("the save dialog", () => {
  const open: SaveDialog = { type: "save", asked: 1, asNew: true, location: "project", folder: "", name: "w" };

  test("a change drops a pressed Save, and a change of destination drops the warnings given for the old one", () => {
    const warned = { ...confirmedAs(open, 7), warnings: ["name differs"], checked: "/p/w.yml\ntext" };
    const renamed = changed(warned, { name: "v" });
    expect(renamed).toMatchObject({ name: "v", confirmed: undefined, warnings: undefined, checked: undefined });
    const other = changed(warned, { error: "x" });
    expect(other).toMatchObject({ confirmed: undefined, warnings: ["name differs"] });
  });

  test("nothing changes, and the dialog does not close, while the file is being written", () => {
    const writing = savingAs(confirmedAs(open, 3), 3)!;
    expect(writing).toMatchObject({ saving: true, confirmed: 3 });
    expect(changed(writing as SaveDialog, { name: "v" })).toBe(writing as SaveDialog);
    expect(closed(writing)).toBe(writing);
    expect(closed(open)).toBeNull();
  });

  test("an answer for a Save the user has since cancelled, changed or pressed again does nothing", () => {
    const pressed = confirmedAs(open, 4);
    expect(stillConfirmed(pressed, 4)).toBe(true);
    // Pressed again as 5: the answer for 4 is ignored.
    const again = confirmedAs(pressed, 5);
    expect(checkedAs(again, 4, { error: "refused" })).toBe(again);
    expect(savingAs(again, 4)).toBe(again);
    expect(abandoned(again, 4)).toBe(again);
    // Cancelled: no dialog to answer.
    expect(checkedAs(closed(again), 5, { error: "refused" })).toBeNull();
    // Changed: the press no longer holds.
    expect(stillConfirmed(changed(again, { folder: "team" }), 5)).toBe(false);
    // The answer for the current press is shown, and Save can be pressed again.
    expect(checkedAs(again, 5, { error: "refused" })).toMatchObject({ error: "refused", confirmed: undefined, saving: false });
    expect(abandoned(again, 5)).toMatchObject({ confirmed: undefined });
  });

  test("a change of the open text drops the warnings and a pressed Save", () => {
    const warned = { ...confirmedAs(open, 2), warnings: ["w"], checked: "c" };
    expect(textChanged(warned)).toMatchObject({ confirmed: undefined, warnings: undefined, checked: undefined });
    expect(textChanged(null)).toBeNull();
  });
});

describe("where the open workflow's names resolve", () => {
  test("a shared personal workflow opened from another project's workstream resolves names in that project (rvk3-client-3)", () => {
    expect(
      namesResolveIn({
        context: { key: "personal/common-personal.yml", project: "/work/project-b" },
        currentKey: "personal/common-personal.yml",
        ownProject: undefined,
        root: "/work/project",
      }),
    ).toBe("/work/project-b");
  });

  test("another project's file resolves in its project, and this project's in this project, without a recorded navigation", () => {
    expect(namesResolveIn({ context: null, currentKey: "run:/work/b/x.yml", ownProject: "/work/b", root: "/work/a" })).toBe("/work/b");
    expect(namesResolveIn({ context: null, currentKey: "project/x.yml", ownProject: undefined, root: "/work/a" })).toBe("/work/a");
  });

  test("a recorded navigation counts only for the workflow it opened", () => {
    expect(
      namesResolveIn({
        context: { key: "personal/a.yml", project: "/work/b" },
        currentKey: "project/x.yml",
        ownProject: undefined,
        root: "/work/a",
      }),
    ).toBe("/work/a");
  });
});

describe("which workflow a Compare choice selects", () => {
  const shared = "personal/common-personal.yml";
  const pair: [string, string] = [shared, "project/local-target.yml"];

  test("choosing only the right side keeps the left workflow and the project its names resolve in (rvk-state-1)", () => {
    const pick = comparePick(pair, "right", "project/alpha.yml");
    expect(pick.right).toBe("project/alpha.yml");
    expect(compareSelection("right", pick.select, shared)).toBeNull();
    // Nothing is selected, so the context recorded when the link was followed still applies.
    expect(
      namesResolveIn({
        context: { key: shared, project: "/work/project-b" },
        currentKey: shared,
        ownProject: undefined,
        root: "/work/project",
      }),
    ).toBe("/work/project-b");
  });

  test("choosing the right side as the left workflow swaps, and selects the old right one", () => {
    const pick = comparePick(pair, "right", shared);
    expect(compareSelection("right", pick.select, shared)).toBe("project/local-target.yml");
  });

  test("choosing the left side, or swapping, selects, even the workflow already selected", () => {
    expect(compareSelection("left", comparePick(pair, "left", shared).select, shared)).toBe(shared);
    expect(compareSelection("swap", comparePick(pair, "swap").select, shared)).toBe("project/local-target.yml");
  });

  test("a right choice while the selected workflow is one Compare does not offer selects the left side", () => {
    const pick = comparePick(pair, "right", "project/alpha.yml");
    expect(compareSelection("right", pick.select, "run:/work/b/x.yml")).toBe(shared);
  });
});
