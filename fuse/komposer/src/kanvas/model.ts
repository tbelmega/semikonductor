// SPDX-License-Identifier: Apache-2.0
// What Kanvas's server and page exchange: the boards read from design/, the
// state of the design build, and the comments and selection the owner makes
// on built designs. Shared by server/kanvas/ and src/kanvas/.
//
// Prototype (workstream kanvas): the board view and comments only.

// Where an element of a built design comes from: its file relative to the
// project root, with the line and column of its opening tag, and what the
// page saw of it when it was selected.
export interface Anchor {
  file: string;
  line: number;
  column: number;
  tag: string;
  selector: string;
  text: string;
}

export type CommentState = "open" | "addressed" | "resolved";

export interface KanvasComment {
  id: number;
  // A target name of the design workflows: <app>/<feature>/<label>.
  target: string;
  anchor: Anchor;
  body: string;
  state: CommentState;
  // The agent's note when it marks the comment addressed.
  note?: string;
  created: string;
  updated: string;
}

export interface BoardOption {
  label: string;
  title: string;
  direction: string;
  target: string;
  // The built option's address under /kanvas/frame/, or null while the
  // option has no Option.tsx.
  frame: string | null;
}

export interface BoardRound {
  n: number;
  question: string;
  fidelity: string;
  outcome: string;
  options: BoardOption[];
}

export interface Board {
  app: string;
  feature: string;
  title: string;
  // board.md relative to the project root.
  file: string;
  // Newest first.
  rounds: BoardRound[];
}

export interface BuildState {
  // Counts up with every finished build; frames reload when it changes.
  id: number;
  ok: boolean;
  error?: string;
  // When it finished, as an ISO time, and how long it took from the first
  // file change it covers to the end of the build.
  finished?: string;
  ms?: number;
  changed?: string[];
}

export interface KanvasState {
  // False when the project has no design/ folder.
  hasDesign: boolean;
  root: string;
  boards: Board[];
  build: BuildState;
  comments: KanvasComment[];
}

// The folders Kanvas can show: the --kanvas folder when Komposer was started
// with one, then the projects of the Workstreams page. `first` is shown
// until the owner picks another.
export interface KanvasProjects {
  first: string;
  projects: { path: string; hasDesign: boolean }[];
}

// Messages between Kanvas and a design's frame. The frame sends the first
// three; Kanvas sends "kanvas:show".
export type FrameMessage =
  | { type: "kanvas:ready" }
  | { type: "kanvas:select"; anchor: Anchor }
  | { type: "kanvas:pin"; id: number };

export interface FramePin {
  id: number;
  n: number;
  state: CommentState;
  selector: string;
  src: string;
}

export interface ShowMessage {
  type: "kanvas:show";
  pins: FramePin[];
  selected: { selector: string; src: string } | null;
}

// "design/apps/x/y.tsx:12:5", the value of an element's data-kanvas-src.
export const anchorSrc = (a: Pick<Anchor, "file" | "line" | "column">) => `${a.file}:${a.line}:${a.column}`;
