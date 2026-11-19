// SPDX-License-Identifier: Apache-2.0
// The reviewer setup that install.sh runs: it asks the user which harness and
// model they develop with and which ones review, and writes the pairing to
// their policy file, ~/.konductor/policy-overrides.yml, as review.reviewers
// rows. Without --force it asks only while that file sets no reviewer yet.
//
//   bun reviewer-setup.ts [--force]
//   bun reviewer-setup.ts --check
//
// The answers are read line by line from stdin, so a test can pipe them in.
// Exit status: 0 when the setup was written, skipped or not needed, 1 when the
// policy file could not be read, changed while the user answered, or the
// merged file would not be valid. --check asks nothing: it exits 0 when the
// policy file sets a reviewer or cannot be read, and 3 when it sets none.
//
// The file is replaced the way install.sh replaces an instruction file: a
// symlink is followed and kept, the permissions are kept, the new version is
// written to a fresh temporary name beside the target and renamed into place,
// and nothing is written if the file changed since it was read.
//
// Invariants, all of which the code keeps:
//   1. Without --force it asks nothing while the policy, read as YAML, sets
//      review.reviewers or review.launch; install.sh asks only in a terminal.
//   2. It writes only rows the user gave or confirmed. Every other key and
//      comment stays; an existing row is replaced only after a yes.
//   3. It never writes a file that fails the policy schema.
//   4. It writes nothing when the file changed between the read and the
//      write: present or absent, the file it resolves to with every symlink on
//      its path followed, and its text.
//   5. The write is one rename of a file created exclusively in a fresh folder
//      beside the resolved target, with the target's permissions; a symlink at
//      the path stays a symlink.
//   6. A policy file that uses YAML anchors or aliases is not edited: the
//      setup says so and the user adds the pairing by hand.
//   7. It takes no lock, like install.sh, which is run by hand: two setups at
//      once can lose one write.
// Invariant 6 replaces an earlier attempt to keep aliases intact while
// replacing an anchored row. Each fix there exposed another case (anchor names
// reused later, anchors nested in a row, aliases inside the copies), and a
// policy file with anchors is rare enough that refusing it costs nothing.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { isAlias, parseDocument, visit, type Node } from "yaml";
import { PolicySchema } from "./schemas/policy.ts";

export type HarnessId = "claude" | "codex" | "opencode" | "kiro" | "other";

interface Harness {
  id: HarnessId;
  name: string;
  example?: string;
  // The command that starts one review in this harness. {model}, {effort} and
  // {prompt_file} are filled in by the agent when a review starts; the review
  // prompt names the findings file. Path placeholders are quoted.
  template?: string;
}

export const HARNESSES: Harness[] = [
  {
    id: "claude",
    name: "Claude Code",
    example: "claude-opus-5-5",
    template: 'claude -p --model {model} --effort {effort} --permission-mode acceptEdits < "{prompt_file}"',
  },
  {
    id: "codex",
    name: "Codex",
    example: "gpt-6.1-sol",
    template: 'codex exec --skip-git-repo-check -s workspace-write -m {model} -c model_reasoning_effort={effort} < "{prompt_file}"',
  },
  {
    id: "opencode",
    name: "OpenCode",
    example: "openai/gpt-6.1-sol",
    template: 'opencode run -m {model}#{effort} "$(cat "{prompt_file}")"',
  },
  {
    id: "kiro",
    name: "Kiro CLI",
    example: "claude-opus-5.5",
    template:
      'kiro-cli chat --no-interactive --trust-tools=fs_read,fs_write --model {model} --effort {effort} "$(cat "{prompt_file}")"',
  },
  { id: "other", name: "another harness" },
];

export type Launch = "subagent" | { command: string };
export interface Row {
  model: string;
  launch: Launch;
}

// The model family a model name belongs to, from its usual names; undefined
// when the name is not recognised.
export function family(model: string): string | undefined {
  const m = model.toLowerCase();
  const families: [RegExp, string][] = [
    [/claude|opus|sonnet|haiku|fable/, "Claude"],
    [/gpt|codex|\bo[1-9]\b/, "GPT"],
    [/gemini/, "Gemini"],
    [/grok/, "Grok"],
    [/deepseek/, "DeepSeek"],
    [/qwen/, "Qwen"],
    [/llama/, "Llama"],
    [/mistral|mixtral|devstral/, "Mistral"],
    [/kimi/, "Kimi"],
  ];
  return families.find(([re]) => re.test(m))?.[1];
}

export function harness(answer: string): Harness | undefined {
  const a = answer.trim().toLowerCase();
  const n = Number(a);
  if (Number.isInteger(n) && n >= 1 && n <= HARNESSES.length) return HARNESSES[n - 1];
  return HARNESSES.find((h) => h.id === a || h.name.toLowerCase() === a || (h.id === "other" && a === "other"));
}

// Whether the policy text already sets a reviewer: review.reviewers or review.launch.
export function setsReviewer(text: string): boolean {
  const doc = parseDocument(text);
  if (doc.errors.length) return true; // a file we cannot read is not ours to fill in
  return doc.getIn(["review", "reviewers"]) != null || doc.getIn(["review", "launch"]) != null;
}

// The row the policy text holds for `author`, as plain data with aliases
// resolved, if any.
export function existingRow(text: string, author: string): unknown {
  try {
    const data = parseDocument(text).toJS() as { review?: { reviewers?: Record<string, unknown> } } | null;
    const table = data?.review?.reviewers;
    return table && Object.hasOwn(table, author) ? table[author] : undefined;
  } catch {
    return undefined;
  }
}

// The policy text with `rows` set under review.reviewers, every other key and
// comment kept, or why it cannot be written: the file does not parse, a key in
// the way is not a mapping, the file uses YAML anchors or aliases, or the
// result fails the policy schema.
export function merge(text: string, rows: Map<string, Row>): { text: string } | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { error: `it is not valid YAML: ${doc.errors[0]!.message}` };
  let shared = false;
  visit(doc, {
    Node(_, n) {
      if (isAlias(n) || (n as Node & { anchor?: string }).anchor) return ((shared = true), visit.BREAK);
    },
  });
  if (shared) return { error: "it uses YAML anchors or aliases; add the pairing to it by hand" };
  try {
    for (const [author, row] of rows) {
      doc.setIn(["review", "reviewers", author], doc.createNode(row));
    }
  } catch (e) {
    return { error: `review or review.reviewers in it is not a mapping (${(e as Error).message})` };
  }
  const checked = PolicySchema.safeParse(doc.toJS());
  if (!checked.success) {
    const issue = checked.error.issues[0]!;
    return { error: `the result would not be a valid policy file: ${issue.path.join(".") || "(top)"}: ${issue.message}` };
  }
  return { text: doc.toString() };
}

export interface Io {
  // The next line of input, or undefined at the end of the input.
  ask(prompt: string): Promise<string | undefined>;
  say(text: string): void;
}

const yes = (a: string | undefined, dflt: boolean) => {
  const t = (a ?? "").trim().toLowerCase();
  return t === "" ? dflt : t === "y" || t === "yes";
};

const SKIPPED = "No reviewer was set up. Run install.sh --reviewer-setup to set one up later.";

async function askHarness(io: Io, question: string): Promise<Harness | undefined> {
  const list = HARNESSES.map((h, i) => `${i + 1}) ${h.name}`).join("  ");
  for (;;) {
    const a = await io.ask(`${question}\n  ${list}\n> `);
    if (a === undefined || a.trim() === "") return undefined;
    const h = harness(a);
    if (h) return h;
    io.say(`Answer with a number from 1 to ${HARNESSES.length}.`);
  }
}

async function askModel(io: Io, question: string, h: Harness): Promise<string | undefined> {
  const hint = h.example ? ` (the model id as ${h.name} names it, such as ${h.example})` : "";
  const a = await io.ask(`${question}${hint}\n> `);
  const t = a?.trim();
  return t ? t : undefined;
}

// How `reviewerModel` in harness `to` is started for an author in harness
// `from`. Undefined when the user gave no command where one is needed.
async function chooseLaunch(io: Io, from: Harness, to: Harness, reviewerModel: string): Promise<Launch | undefined> {
  if (from.id === to.id && from.id !== "other") return "subagent";
  if (!to.template) {
    const sameOther = from.id === "other";
    const a = await io.ask(
      `Type the command that starts a review by ${reviewerModel}. When a review starts, the agent fills in ` +
        `{model}, {effort} and {prompt_file}, the file that holds the review request.` +
        (sameOther ? " Press Enter to start the reviewer as a subagent in the same harness instead." : "") +
        "\n> ",
    );
    const t = a?.trim();
    if (t) return { command: t };
    return sameOther && a !== undefined ? "subagent" : undefined;
  }
  io.say(
    `Reviews by ${reviewerModel} will start with this command; the agent fills in {effort} and {prompt_file} when a review starts:\n` +
      `  ${to.template.replaceAll("{model}", reviewerModel)}`,
  );
  const a = await io.ask("Use this command? [Y/n, or type your own command]\n> ");
  if (a === undefined) return undefined;
  const t = a.trim();
  if (t === "" || /^(y|yes)$/i.test(t)) return { command: to.template };
  if (/^(n|no)$/i.test(t)) {
    const own = (await io.ask("Type your command:\n> "))?.trim();
    return own ? { command: own } : undefined;
  }
  return { command: t };
}

const describe = (row: Row) => `${row.model}, ${row.launch === "subagent" ? "as a subagent" : `with: ${row.launch.command}`}`;

// The whole conversation. Returns the exit status.
export async function setup(io: Io, policyPath: string, force: boolean): Promise<number> {
  let snapshot: Snapshot;
  try {
    snapshot = take(policyPath);
  } catch (e) {
    io.say(`Cannot read ${policyPath}: ${(e as Error).message}`);
    return 1;
  }
  const text = snapshot.text;
  if (!force && setsReviewer(text)) return 0;

  io.say(
    "Set up who reviews your work. fuse-konductor's workflows hand every change to a fresh reviewer before you\n" +
      "see it. A reviewer from a different model family than the one that wrote the work catches more of its\n" +
      "mistakes, so we recommend one: for example, develop with Opus and review with GPT Sol.\n" +
      "Press Enter at the first question to skip this for now.",
  );
  const devH = await askHarness(io, "Which harness do you mainly develop with?");
  if (!devH) return (io.say(SKIPPED), 0);
  const devM = await askModel(io, "Which model do you develop with?", devH);
  if (!devM) return (io.say(SKIPPED), 0);
  const revH = await askHarness(io, "Which harness runs your reviewer?");
  if (!revH) return (io.say(SKIPPED), 0);
  const revM = await askModel(io, "Which model reviews your work?", revH);
  if (!revM) return (io.say(SKIPPED), 0);

  const fam = family(devM);
  if (fam && fam === family(revM)) {
    const keep = await io.ask(`Both are ${fam} models; a reviewer from another family is recommended. Keep this pairing? [y/N]\n> `);
    if (!yes(keep, false)) return (io.say(SKIPPED), 0);
  }

  const rows = new Map<string, Row>();
  const forward = await chooseLaunch(io, devH, revH, revM);
  if (!forward) return (io.say(SKIPPED), 0);
  rows.set(devM, { model: revM, launch: forward });

  if (devM !== revM) {
    const reverse = await io.ask(`Also have ${devM} review work written on ${revM}? [Y/n]\n> `);
    if (reverse !== undefined && yes(reverse, true)) {
      const launch = await chooseLaunch(io, revH, devH, devM);
      if (launch) rows.set(revM, { model: devM, launch });
      else io.say(`The reverse pairing was not written: no command to start ${devM}.`);
    }
  }

  for (const [author, row] of [...rows]) {
    const old = existingRow(text, author);
    if (old === undefined || isDeepStrictEqual(old, row)) continue;
    const replace = await io.ask(
      `${policyPath} already says who reviews ${author}: ${JSON.stringify(old)}. Replace it with ${describe(row)}? [y/N]\n> `,
    );
    if (!yes(replace, false)) rows.delete(author);
  }
  if (!rows.size) return (io.say(`Nothing was changed in ${policyPath}.`), 0);

  const merged = merge(text, rows);
  if ("error" in merged) {
    io.say(`${policyPath} was not changed, because ${merged.error}.`);
    return 1;
  }
  const failed = write(policyPath, snapshot, merged.text);
  if (failed) {
    io.say(`${policyPath} was not changed, because ${failed}.`);
    return 1;
  }
  io.say(`Wrote to ${policyPath}:`);
  for (const [author, row] of rows) io.say(`  work by ${author} is reviewed by ${describe(row)}`);
  return 0;
}

// Whether something is at `path`, a dangling symlink included.
function isPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// `path` with every symlink in its existing folders followed: the nearest
// existing folder above it, resolved, with the rest of the path appended.
function resolved(path: string): string {
  let dir = dirname(path);
  const rest = [basename(path)];
  while (!isPresent(dir) && dirname(dir) !== dir) {
    rest.unshift(basename(dir));
    dir = dirname(dir);
  }
  return join(realpathSync(dir), ...rest);
}

// What the policy file was when the setup read it: whether it existed, the
// file it resolves to, with every symlink on its path followed, and its text.
interface Snapshot {
  existed: boolean;
  target: string;
  text: string;
}

// Throws when the file is there but cannot be read, such as a dangling link.
function take(policyPath: string): Snapshot {
  if (!isPresent(policyPath)) return { existed: false, target: resolved(policyPath), text: "" };
  const target = lstatSync(policyPath).isSymbolicLink() ? realpathSync(policyPath) : resolved(policyPath);
  return { existed: true, target, text: readFileSync(target, "utf8") };
}

// Replaces the policy file with `next`, or says why it did not. The file
// written is the one the snapshot resolved to, and only while the path still
// resolves to it with the same text.
function write(policyPath: string, before: Snapshot, next: string): string | undefined {
  const changed = "it changed while the questions were answered; run the setup again";
  let tmpDir: string | undefined;
  try {
    let now: Snapshot;
    try {
      now = take(policyPath);
    } catch {
      return changed;
    }
    if (now.existed !== before.existed || now.target !== before.target || now.text !== before.text) return changed;
    const target = before.target;
    mkdirSync(dirname(target), { recursive: true });
    tmpDir = mkdtempSync(join(dirname(target), ".policy-overrides-"));
    const tmp = join(tmpDir, "policy-overrides.yml");
    writeFileSync(tmp, next, { flag: "wx" });
    if (before.existed) chmodSync(tmp, statSync(target).mode & 0o7777);
    renameSync(tmp, target);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  } finally {
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  }
}

// Reads stdin line by line, keeping lines that arrive before they are asked for.
function stdinIo(): Io & { close(): void } {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  const waiting: ((l: string | undefined) => void)[] = [];
  let ended = false;
  rl.on("line", (l) => (waiting.length ? waiting.shift()!(l) : lines.push(l)));
  rl.on("close", () => {
    ended = true;
    while (waiting.length) waiting.shift()!(undefined);
  });
  return {
    ask(prompt) {
      process.stdout.write(prompt);
      if (lines.length) return Promise.resolve(lines.shift());
      if (ended) return Promise.resolve(undefined);
      return new Promise((resolve) => waiting.push(resolve));
    },
    say: (t) => process.stdout.write(`${t}\n`),
    close: () => rl.close(),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const policyPath = join(process.env.HOME ?? homedir(), ".konductor", "policy-overrides.yml");
  if (args.length === 1 && args[0] === "--check") {
    let text = "";
    try {
      if (isPresent(policyPath)) text = readFileSync(policyPath, "utf8");
    } catch {
      process.exit(0);
    }
    process.exit(setsReviewer(text) ? 0 : 3);
  }
  const force = args.includes("--force");
  if (args.some((a) => a !== "--force")) {
    process.stderr.write("usage: bun reviewer-setup.ts [--force] | --check\n");
    process.exit(64);
  }
  const io = stdinIo();
  const status = await setup(io, policyPath, force);
  io.close();
  process.exit(status);
}
