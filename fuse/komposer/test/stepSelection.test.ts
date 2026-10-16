// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { selectionAfterMove } from "../src/model/stepSelection.ts";

// Moves the step at `from` to `to` in a list of step names, as moveStep does.
const moved = (steps: string[], from: number, to: number) => {
  const next = [...steps];
  const [step] = next.splice(from, 1);
  next.splice(to, 0, step);
  return next;
};

describe("selectionAfterMove", () => {
  test("no selection stays no selection", () => {
    expect(selectionAfterMove(null, 0, 2)).toBeNull();
  });

  test("the moved step stays selected at its new position", () => {
    expect(selectionAfterMove(1, 1, 3)).toBe(3);
    expect(selectionAfterMove(3, 3, 0)).toBe(0);
  });

  test("moving another step down across the selected step keeps the same step selected", () => {
    // Select B, move A down: the list becomes B, A, and B is now at 0.
    expect(selectionAfterMove(1, 0, 1)).toBe(0);
  });

  test("moving another step up across the selected step keeps the same step selected", () => {
    expect(selectionAfterMove(0, 1, 0)).toBe(1);
  });

  test("a selected step outside the moved range keeps its index", () => {
    expect(selectionAfterMove(0, 1, 3)).toBe(0);
    expect(selectionAfterMove(4, 1, 3)).toBe(4);
    expect(selectionAfterMove(2, 2, 2)).toBe(2);
  });

  test("every move and selection keeps naming the same step", () => {
    const steps = ["a", "b", "c", "d", "e"];
    for (let from = 0; from < steps.length; from++)
      for (let to = 0; to < steps.length; to++)
        for (let selected = 0; selected < steps.length; selected++) {
          const after = selectionAfterMove(selected, from, to);
          expect(moved(steps, from, to)[after as number]).toBe(steps[selected]);
        }
  });
});
