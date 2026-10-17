// SPDX-License-Identifier: Apache-2.0
// The Present page's model: the seven Show toggles, which legend entries
// they leave, the workflows the "Side by side with" picker offers and the
// one it shows, when a drawer is open, and what Escape does on each page.
// No React, no DOM, no Node APIs.

// What the diagram shows. Edit and Workstreams show everything.
export type FlowShow = {
  phases: boolean;
  descriptions: boolean;
  conditions: boolean;
  artifacts: boolean;
  gates: boolean;
  consumes: boolean;
  routes: boolean;
};

// The Show drawer's toggles, in the drawer's order.
export const SHOW_TOGGLES: { key: keyof FlowShow; label: string }[] = [
  { key: "phases", label: "Phases" },
  { key: "descriptions", label: "Descriptions" },
  { key: "conditions", label: "Conditions" },
  { key: "artifacts", label: "Artifacts" },
  { key: "gates", label: "Gates" },
  { key: "consumes", label: "Consume lines" },
  { key: "routes", label: "Route-back lines" },
];

export const ALL_SHOWN: FlowShow = {
  phases: true,
  descriptions: true,
  conditions: true,
  artifacts: true,
  gates: true,
  consumes: true,
  routes: true,
};
export const STEPS_ONLY: FlowShow = {
  phases: false,
  descriptions: false,
  conditions: false,
  artifacts: false,
  gates: false,
  consumes: false,
  routes: false,
};

// The legend lists only the element types the diagram shows: the consume
// line, the route-back line, the artifact marks (~ updates, id? may produce,
// G T R), and the workflow gate's child.
export function legendEntries(show: FlowShow) {
  return { consumes: show.consumes, routes: show.routes, artifacts: show.artifacts, gates: show.gates };
}

type Listed = { path: string; location: string };

// The workflows the picker offers: those of the three locations, without the
// one shown first. Another project's workflow is shown only as the first.
export const secondOptions = <W extends Listed>(workflows: W[], currentKey: string | null): W[] =>
  workflows.filter((w) => w.location !== "run" && w.path !== currentKey);

// The second workflow shown, by key: the chosen one while the picker offers
// it, else none, as when the selected workflow became the chosen one.
export function shownSecond(workflows: Listed[], currentKey: string | null, chosen: string | null): string | null {
  if (!chosen) return null;
  return secondOptions(workflows, currentKey).some((w) => w.path === chosen) ? chosen : null;
}

// A drawer is open while pinned, while the pointer is over it, and while
// focus is inside it, so a native select's popup or the lane search do not
// close it when the pointer leaves.
export const drawerOpen = (drawer: { pinned: boolean; hovered: boolean; focused: boolean }) =>
  drawer.pinned || drawer.hovered || drawer.focused;

// Whether the focused element gives up focus when its drawer would close,
// because the pointer left it or the mouse un-pinned it. A control clicked
// with the mouse does, so the drawer closes and focus never stays on a
// hidden control. A field (the lane search, the picker) and a control
// reached with the keyboard keep focus, and so keep the drawer open.
export const releasesFocus = (focus: { field: boolean; keyboard: boolean }) => !focus.field && !focus.keyboard;

export type EscapeAction = "blur" | "close-rail" | "clear-selection" | "unpin" | "none";

// Escape, when no dialog is open. In a field it only leaves the field, so a
// field that applies its value on blur keeps it. On Edit and Compare it
// closes the rail, and a second Escape clears the step selection. On Present
// it un-pins the drawers; the rail and the selection, hidden there, stay as
// they are for Edit.
export function escapeAction(state: {
  page: "edit" | "compare" | "present" | "workstreams";
  typing: boolean;
  railOpen: boolean;
  selected: number | null;
  // A Present drawer is pinned open.
  pinned: boolean;
}): EscapeAction {
  if (state.page === "workstreams") return "none";
  if (state.typing) return "blur";
  if (state.page === "present") return state.pinned ? "unpin" : "none";
  if (state.railOpen) return "close-rail";
  if (state.selected !== null) return "clear-selection";
  return "none";
}
