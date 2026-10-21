// SPDX-License-Identifier: Apache-2.0
// The exploration boards of a project's design/ folder, read from each
// feature's board.md:
//
//   # <title>
//   ## Round <n>
//   Question: <text>
//   Fidelity: <text>
//   Outcome: <text>           (optional)
//   ### <label>: <title>
//   Direction: <text, to the next heading>
//
// Prototype: a lenient reader of the hand-made fixture's format, not the
// exploration board guide's final format.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Board, BoardOption, BoardRound } from "../../src/kanvas/model.ts";

const dirs = (path: string) =>
  existsSync(path) ? readdirSync(path, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name) : [];

export function parseBoard(text: string, at: { app: string; feature: string; file: string }, optionFrame: (round: number, label: string) => string | null): Board {
  const board: Board = { app: at.app, feature: at.feature, title: at.feature, file: at.file, rounds: [] };
  let round: BoardRound | undefined;
  let option: BoardOption | undefined;
  const field = (line: string, name: string) => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, "i").exec(line);
    return m ? m[1].trim() : undefined;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      board.title = m[1].trim();
    } else if ((m = /^##\s+Round\s+(\d+)/i.exec(line))) {
      round = { n: Number(m[1]), question: "", fidelity: "", outcome: "", options: [] };
      option = undefined;
      board.rounds.push(round);
    } else if (round && (m = /^###\s+([0-9]+[a-z])\s*[:.-]?\s*(.*)$/i.exec(line))) {
      const label = m[1].toLowerCase();
      option = { label, title: m[2].trim(), direction: "", target: `${at.app}/${at.feature}/${label}`, frame: optionFrame(round.n, label) };
      round.options.push(option);
    } else if (round && !option && field(line, "Question") !== undefined) {
      round.question = field(line, "Question")!;
    } else if (round && !option && field(line, "Fidelity") !== undefined) {
      round.fidelity = field(line, "Fidelity")!;
    } else if (round && field(line, "Outcome") !== undefined) {
      round.outcome = field(line, "Outcome")!;
      option = undefined;
    } else if (option && line) {
      const text = field(line, "Direction") ?? line;
      option.direction = option.direction ? `${option.direction} ${text}` : text;
    }
  }
  board.rounds.sort((a, b) => b.n - a.n);
  return board;
}

// Every board under design/apps/<app>/boards/<feature>/board.md.
export function readBoards(root: string, optionFrame: (rel: string) => string | null): Board[] {
  const apps = join(root, "design", "apps");
  return dirs(apps).flatMap((app) =>
    dirs(join(apps, app, "boards")).flatMap((feature) => {
      const path = join(apps, app, "boards", feature, "board.md");
      if (!existsSync(path)) return [];
      const file = relative(root, path);
      return [
        parseBoard(readFileSync(path, "utf8"), { app, feature, file }, (n, label) =>
          optionFrame(join("apps", app, "boards", feature, `round-${n}`, label)),
        ),
      ];
    }),
  );
}
