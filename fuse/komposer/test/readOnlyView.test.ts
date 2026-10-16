// SPDX-License-Identifier: Apache-2.0
// When the open workflow gives way to the first workflow of the three
// locations: when it is no longer listed, or when it is another project's
// file shown only for its run and that run is closed or gone.

import { describe, expect, test } from "bun:test";
import { givesWay } from "../src/model/readOnlyView.ts";

const foreign = { listed: true, readOnly: true, hasRun: false, openedByLink: false };

describe("givesWay", () => {
  test("another project's file opened by a link stays open without a run", () => {
    expect(givesWay({ ...foreign, openedByLink: true })).toBe(false);
  });

  test("another project's file opened with its run gives way when the run is closed or gone", () => {
    expect(givesWay({ ...foreign, hasRun: true })).toBe(false);
    expect(givesWay(foreign)).toBe(true);
  });

  test("a workflow that is no longer listed gives way, even one opened by a link", () => {
    expect(givesWay({ ...foreign, listed: false, openedByLink: true })).toBe(true);
    expect(givesWay({ listed: false, readOnly: false, hasRun: false, openedByLink: false })).toBe(true);
  });

  test("a workflow of the three locations stays open without a run", () => {
    expect(givesWay({ listed: true, readOnly: false, hasRun: false, openedByLink: false })).toBe(false);
  });
});
