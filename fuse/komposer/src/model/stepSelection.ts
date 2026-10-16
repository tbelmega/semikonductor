// SPDX-License-Identifier: Apache-2.0
// Which index the selected step has after a step moves from one position to
// another. The selection follows the step it named, so moving any step across
// it shifts it by one.

export function selectionAfterMove(selected: number | null, from: number, to: number): number | null {
  if (selected === null) return null;
  if (selected === from) return to;
  if (from < to && selected > from && selected <= to) return selected - 1;
  if (to < from && selected >= to && selected < from) return selected + 1;
  return selected;
}
