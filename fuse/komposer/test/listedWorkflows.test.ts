// SPDX-License-Identifier: Apache-2.0
// What the open workflows become when the projects list changes and the
// server's listing is read again.

import { describe, expect, test } from "bun:test";
import { mergeListed } from "../src/model/listedWorkflows.ts";
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

  test("a local file missing from a listing read before it was saved is kept", () => {
    const saved = openWorkflow(file("/p/saved-just-now.yml"));
    expect(mergeListed([saved], [], openWorkflow)).toEqual([saved]);
  });
});
