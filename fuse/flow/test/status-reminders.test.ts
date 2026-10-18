// SPDX-License-Identifier: Apache-2.0
// The reminders to set a document's own status line after the owner approves
// a step or sends the work back: which files they name.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Repo } from "./helpers";

let repo: Repo;
beforeEach(() => {
  repo = new Repo();
});
afterEach(() => repo.cleanup());

describe("status reminders", () => {
  const LANDING = `version: 1
name: landing
steps:
  - id: design
    instruction: Design it.
    produces:
      - artifact: design
        path: design.md
  - id: split
    instruction: Split the design into features, and change the code.
    consumes: [design]
    produces:
      - artifact: build-order
        path: build-order.md
      - artifact: notes
        path: notes.md
    updates:
      - artifact: code
        path: .
    gates:
      - owner-action: approve the design and the build order, then land them
`;

  test("name only plain files that carry a status line, never the code folder, and also the earlier steps the same owner gate approves", () => {
    repo.start("l", LANDING);
    repo.write("design.md", "# Design\n\nStatus: draft\n");
    repo.ok("continue", "l");
    repo.write("build-order.md", "---\nstatus: draft\n---\n# Order\n");
    repo.write("notes.md", "# Notes without a status\n");
    repo.write("src/a.ts");
    repo.ok("continue", "l", "--updated", "code=src/a.ts", "--updated", "build-order=build-order.md", "--updated", "notes=notes.md");
    const out = repo.ok("continue", "l", "--owner-approved");
    expect(out).toContain(
      "If any of design.md, build-order.md records a status of its own, such as a 'Status: draft' line, set it to approved.",
    );
    expect(out).not.toContain("If any of .");
    expect(out).not.toContain("notes.md records");
  });

  test("name an artifact with a guide only when its guide or template defines a status", () => {
    repo.write(".konductor/library/artifacts/design/guide.md", "# Design guide\n\nStart the file with `status: draft` in its front matter.\n");
    repo.write(".konductor/library/artifacts/build-order/guide.md", "# Build order guide\n\nList the features.\n");
    repo.start("l", LANDING);
    repo.write("design.md");
    repo.ok("continue", "l");
    repo.write("build-order.md");
    repo.write("notes.md");
    repo.ok("continue", "l", "--unchanged", "code", "no code yet");
    const out = repo.ok("continue", "l", "--owner-approved");
    expect(out).toContain("If any of design.md keeps a status of its own, as its guide says, set it to approved.");
    expect(out).not.toContain("build-order.md keeps");
    expect(out).not.toContain("build-order.md records");
  });
});
