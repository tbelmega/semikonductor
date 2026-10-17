// SPDX-License-Identifier: Apache-2.0

export interface DiffLine {
  kind: " " | "+" | "-";
  text: string;
}

// The longest common subsequence of two lists of strings, as the edit script
// that turns `a` into `b`: " " keeps an item of both, "-" drops one of `a`,
// "+" adds one of `b`. On a tie the item of `a` is dropped first. Each entry
// carries the item's index in its list (`a` for " " and "-", `b` for "+";
// " " has both).
export interface LcsOp {
  kind: " " | "+" | "-";
  a?: number;
  b?: number;
}

export function lcsDiff(a: readonly string[], b: readonly string[]): LcsOp[] {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--)
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const out: LcsOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ kind: " ", a: i++, b: j++ });
    else if (table[i + 1][j] >= table[i][j + 1]) out.push({ kind: "-", a: i++ });
    else out.push({ kind: "+", b: j++ });
  }
  while (i < a.length) out.push({ kind: "-", a: i++ });
  while (j < b.length) out.push({ kind: "+", b: j++ });
  return out;
}

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  return lcsDiff(a, b).map((op) => ({ kind: op.kind, text: op.kind === "+" ? b[op.b!] : a[op.a!] }));
}

// One run of a text in a word diff: `changed` when it is not in the other
// text (removed from the left one, added in the right one).
export interface WordRun {
  text: string;
  changed: boolean;
}

// The word diff of two texts, as each text's own runs. Texts are split into
// words and the whitespace between them; any whitespace matches any other,
// so only the words decide. Each side keeps its own whitespace, and
// neighbouring runs with the same mark are merged.
export function wordDiff(before: string, after: string): { left: WordRun[]; right: WordRun[] } {
  const tokens = (s: string) => s.trim().split(/(\s+)/).filter(Boolean);
  const key = (t: string) => (/^\s+$/.test(t) ? " " : t);
  const a = tokens(before);
  const b = tokens(after);
  const left: WordRun[] = [];
  const right: WordRun[] = [];
  const push = (runs: WordRun[], text: string, changed: boolean) => {
    const last = runs[runs.length - 1];
    if (last && last.changed === changed) last.text += text;
    else runs.push({ text, changed });
  };
  for (const op of lcsDiff(a.map(key), b.map(key))) {
    if (op.kind !== "+") push(left, a[op.a!], op.kind === "-");
    if (op.kind !== "-") push(right, b[op.b!], op.kind === "+");
  }
  // The whitespace between two changed runs belongs to the change, so a
  // changed phrase reads as one run rather than word by word.
  const join = (runs: WordRun[]) =>
    runs.reduce<WordRun[]>((out, run, i) => {
      const last = out[out.length - 1];
      const gap = !run.changed && /^\s+$/.test(run.text) && last?.changed && runs[i + 1]?.changed;
      if (gap || (last?.changed && run.changed)) last.text += run.text;
      else out.push({ ...run });
      return out;
    }, []);
  return { left: join(left), right: join(right) };
}

export function visibleDiff(lines: DiffLine[]): (DiffLine | { kind: "…"; text: string })[] {
  const near = lines.map((_, i) => lines.slice(Math.max(0, i - 3), i + 4).some((line) => line.kind !== " "));
  const out: (DiffLine | { kind: "…"; text: string })[] = [];
  lines.forEach((line, i) => {
    if (near[i]) out.push(line);
    else if (near[i - 1]) out.push({ kind: "…", text: "…" });
  });
  return out;
}
