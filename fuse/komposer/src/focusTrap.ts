// SPDX-License-Identifier: Apache-2.0
// Keeping Tab inside a modal dialog: which of its controls a Tab or
// Shift+Tab moves to when the browser's own move would leave it.

// The control to focus instead of the browser's move, or null to let the
// browser move: from the last control Tab wraps to the first, from the
// first Shift+Tab wraps to the last, and from outside the controls (focus
// on the page body, say) either key enters at the matching end.
export function tabTarget<T>(controls: readonly T[], active: T | null, shift: boolean): T | null {
  if (!controls.length) return null;
  const first = controls[0];
  const last = controls[controls.length - 1];
  const at = active === null ? -1 : controls.indexOf(active);
  if (at === -1) return shift ? last : first;
  if (shift && at === 0) return last;
  if (!shift && at === controls.length - 1) return first;
  return null;
}
