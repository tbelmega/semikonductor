// SPDX-License-Identifier: Apache-2.0
// The tooltip texts Komposer writes itself, held to the mechanical parts of
// AGENTS.md rule 5: sentence case, few words, not repeating the field's label.

import { describe, expect, test } from "bun:test";
import { GATE_FIELD_DOCS } from "../src/docs.ts";

const labels = {
  forEach: ["for_each", "for-each"],
  accept: ["acceptance criteria", "accept"],
  rerun: ["re-run on send-back", "rerun"],
  rerunOverride: ["owner may choose items", "rerun_override"],
  retries: ["automatic retries", "retries"],
} as const;

describe("a workflow gate's for_each and outcome settings have Komposer's own tooltip text", () => {
  for (const [key, names] of Object.entries(labels)) {
    test(key, () => {
      const doc = GATE_FIELD_DOCS[key as keyof typeof labels];
      expect(doc.description.length).toBeGreaterThan(0);
      expect(doc.description.length).toBeLessThan(160);
      expect(doc.description[0]).toBe(doc.description[0].toUpperCase());
      for (const name of names) expect(doc.description.toLowerCase()).not.toContain(name);
    });
  }
});
