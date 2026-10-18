// SPDX-License-Identifier: Apache-2.0
// What the open workflows become when the projects list changes and the
// server's listing is read again.

import { describe, expect, test } from "bun:test";
import { diskRecords, mergeListed, requestSequencer } from "../src/model/listedWorkflows.ts";
import { workflowKey } from "../src/workflowView.ts";
import { openWorkflow, type OpenWorkflow, type WorkflowFile } from "../src/workflowView.ts";

const SAVED = "version: 1\nname: x\nsteps:\n  - id: a\n    instruction: Do it.\n";
const EDITED = SAVED.replace("Do it.", "Do it twice.");

const file = (path: string, fields: Partial<WorkflowFile> = {}): WorkflowFile => ({
  location: "project",
  dir: "",
  file: path.slice(path.lastIndexOf("/") + 1),
  path,
  onDisk: true,
  text: SAVED,
  hash: "h1",
  ...fields,
});
const paths = (all: OpenWorkflow[]) => all.map((w) => w.path);

describe("mergeListed", () => {
  test("an edit whose working copy was not yet written survives a listing without it", () => {
    const open = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    const merged = mergeListed([open], [file("/p/a.yml")], openWorkflow);
    // The same object, so the timer that writes the working copy is not reset.
    expect(merged[0]).toBe(open);
    expect(merged[0].openText).toBe(EDITED);
  });

  test("a new workflow that was never written survives a listing without it", () => {
    const created = openWorkflow(file("/p/new.yml", { onDisk: false, text: "", hash: "", workingCopy: SAVED }));
    const merged = mergeListed([openWorkflow(file("/p/a.yml")), created], [file("/p/a.yml")], openWorkflow);
    expect(paths(merged)).toEqual(["/p/a.yml", "/p/new.yml"]);
    expect(merged[1]).toBe(created);
  });

  test("another project's files come and go with the listing; the ones kept are not reopened", () => {
    const kept = openWorkflow(file("/o/.konductor/workflows/one.yml", { location: "run", project: "/o" }));
    const gone = openWorkflow(file("/g/.konductor/workflows/one.yml", { location: "run", project: "/g" }));
    const local = openWorkflow(file("/p/a.yml"));
    const merged = mergeListed(
      [local, kept, gone],
      [file("/p/a.yml"), file("/o/.konductor/workflows/one.yml", { location: "run", project: "/o" }), file("/n/x.yml", { location: "run", project: "/n" })],
      openWorkflow,
    );
    expect(paths(merged)).toEqual(["/p/a.yml", "/o/.konductor/workflows/one.yml", "/n/x.yml"]);
    expect(merged[0]).toBe(local);
    expect(merged[1]).toBe(kept);
  });

  test("another project's file that changed on disk is read again", () => {
    const path = "/o/.konductor/workflows/one.yml";
    const old = openWorkflow(file(path, { location: "run", project: "/o" }));
    const merged = mergeListed([old], [file(path, { location: "run", project: "/o", text: EDITED, hash: "h2" })], openWorkflow);
    expect(merged[0].openText).toBe(EDITED);
  });

  test("a local file without edits follows the listing when it changed on disk", () => {
    const old = openWorkflow(file("/p/a.yml"));
    const merged = mergeListed([old], [file("/p/a.yml", { text: EDITED, hash: "h2" })], openWorkflow);
    expect(merged[0].openText).toBe(EDITED);
    expect(merged[0].hash).toBe("h2");
  });

  test("a local file without edits takes up a working copy another tab wrote", () => {
    const old = openWorkflow(file("/p/a.yml"));
    const merged = mergeListed([old], [file("/p/a.yml", { workingCopy: EDITED })], openWorkflow);
    expect(merged[0].openText).toBe(EDITED);
  });

  test("a local file without edits that is gone from disk is dropped; one with edits is kept", () => {
    const gone = openWorkflow(file("/p/gone.yml"));
    const edited = openWorkflow({ ...openWorkflow(file("/p/edited.yml")), workingCopy: EDITED });
    expect(paths(mergeListed([gone, edited], [], openWorkflow))).toEqual(["/p/edited.yml"]);
  });

  test("an edited file whose original was deleted keeps its edits and is no longer on disk", () => {
    const edited = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    // The listing has only the working copy now.
    const onlyCopy = mergeListed([edited], [file("/p/a.yml", { onDisk: false, text: "", hash: "e3", workingCopy: EDITED })], openWorkflow);
    expect(onlyCopy[0].onDisk).toBe(false);
    expect(onlyCopy[0].openText).toBe(EDITED);
    expect(onlyCopy[0].text).toBe(SAVED);
    // The listing has nothing at that path.
    const gone = mergeListed([edited], [], openWorkflow);
    expect(gone[0].onDisk).toBe(false);
    expect(gone[0].openText).toBe(EDITED);
  });

  test("an edited file that changed on disk keeps its edits and gets a disk record", () => {
    const edited = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    const listing = [file("/p/a.yml", { text: "other", hash: "h2", workingCopy: EDITED })];
    const merged = mergeListed([edited], listing, openWorkflow);
    expect(merged[0]).toBe(edited);
    const records = diskRecords({}, merged, listing, workflowKey, {}, "10:00");
    expect(records[workflowKey(edited)]).toEqual({ text: "other", hash: "h2", at: "10:00" });
    // Unchanged on disk: no record.
    const quiet = [file("/p/a.yml", { workingCopy: EDITED })];
    expect(diskRecords({}, mergeListed([edited], quiet, openWorkflow), quiet, workflowKey, {}, "10:00")).toEqual({});
  });

  test("a disk record is dropped when the file goes back to the version the edits were made from", () => {
    const edited = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    const key = workflowKey(edited);
    const changed = [file("/p/a.yml", { text: "other", hash: "h2", workingCopy: EDITED })];
    const first = diskRecords({}, mergeListed([edited], changed, openWorkflow), changed, workflowKey, {}, "10:00");
    expect(first[key]?.hash).toBe("h2");
    // A later listing of the same change keeps the record as first seen.
    const again = diskRecords(first, mergeListed([edited], changed, openWorkflow), changed, workflowKey, {}, "10:05");
    expect(again[key]).toBe(first[key]);
    const restored = [file("/p/a.yml", { workingCopy: EDITED })];
    expect(diskRecords(first, mergeListed([edited], restored, openWorkflow), restored, workflowKey, {}, "10:10")).toEqual({});
  });

  test("an edited file whose file now holds exactly its edits is saved", () => {
    const edited = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    const listing = [file("/p/a.yml", { text: EDITED, hash: "h2", workingCopy: EDITED })];
    const merged = mergeListed([edited], listing, openWorkflow);
    expect(merged[0].text).toBe(EDITED);
    expect(merged[0].hash).toBe("h2");
    expect(merged[0].openText).toBe(EDITED);
    expect(diskRecords({ [workflowKey(edited)]: { text: "older", hash: "h9", at: "9:00" } }, merged, listing, workflowKey, {}, "10:00")).toEqual({});
  });

  test("an edited file takes up where its link leads", () => {
    const edited = openWorkflow({ ...openWorkflow(file("/p/a.yml")), workingCopy: EDITED });
    const merged = mergeListed([edited], [file("/p/a.yml", { leadsTo: "/elsewhere/a.yml", workingCopy: EDITED })], openWorkflow);
    expect(merged[0].leadsTo).toBe("/elsewhere/a.yml");
    expect(merged[0].openText).toBe(EDITED);
  });
});

// An answer to a request of one kind is taken up only while no newer request
// of that kind was begun and nothing newer of that kind was installed.
describe("requestSequencer", () => {
  test("only the newest request of a kind is current, also when an older one answers last", () => {
    const requests = requestSequencer<"workflows" | "workstreams">();
    const first = requests.begin("workflows");
    const second = requests.begin("workflows");
    expect(requests.current("workflows", second)).toBe(true);
    expect(requests.current("workflows", first)).toBe(false);
  });

  test("a version installed while a request was out makes its answer stale", () => {
    const requests = requestSequencer<"workflows">();
    const mine = requests.begin("workflows");
    requests.invalidate("workflows");
    expect(requests.current("workflows", mine)).toBe(false);
    expect(requests.current("workflows", requests.begin("workflows"))).toBe(true);
  });

  test("kinds are independent: a newer workstreams request does not make a workflows answer stale", () => {
    const requests = requestSequencer<"workflows" | "workstreams">();
    const listing = requests.begin("workflows");
    const old = requests.begin("workstreams");
    const newer = requests.begin("workstreams");
    expect(requests.current("workflows", listing)).toBe(true);
    expect(requests.current("workstreams", old)).toBe(false);
    expect(requests.current("workstreams", newer)).toBe(true);
  });
});
