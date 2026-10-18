// SPDX-License-Identifier: Apache-2.0
// fuse-flow command line: parse the arguments, run one command from
// commands.ts, print its lines. Exit codes: 0 success, 1 refused, 64 usage.

import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as commands from "./commands.ts";
import { FlowError, UsageError } from "./errors.ts";
import { ignoreLocalPolicy } from "./policy.ts";
import { checkSlug, findRepoRoot, isDirectory, isWorkflowPath } from "./project.ts";

// The most review rounds one --more-rounds grants, so that the rounds a step
// is granted in total stay a number the state file can hold.
const MAX_MORE_ROUNDS = 100;

const USAGE = `usage:
  fuse-flow start <slug> [--workflow <name or path>] [--from <step>]
                         [--after <earlier slug>] [--input <artifact-id>=<path>]...
                                                mint a workstream that follows the workflow, or resume it;
                                                prints what to do now. --from starts a new workstream at a
                                                later step, as the owner's decision. --after binds the
                                                workflow's inputs to the earlier workstream's documents of
                                                the same id; --input binds one to a file, and wins.
                                                A relative path is read from the current directory, else
                                                from the repository root
  fuse-flow continue <slug> [--updated [<artifact>=]<file>]... [--unchanged <artifact> <reason>]...
                            [--not-produced <artifact> <reason>]... [--waived <the owner's reason>]
                                                the current step's work is done: refused until every artifact
                                                it produces exists or is reported --not-produced, every
                                                artifact it updates is accounted for, every review has a
                                                findings file in this pass, and its checks pass.
                                                --waived records that the owner waived the reviews that have
                                                not run.
                                                An <artifact> is its id or its path. --updated names a file
                                                the step wrote; a file in the paths of two of its artifacts
                                                takes the id of the one it counts for, <artifact>=<file>.
                                                A relative path is read from the current directory, else
                                                from the repository root, as the step block prints it
  fuse-flow continue <slug> --blocked <why> [--gate <n>] [--updated [<artifact>=]<file>]...
                                                the agent cannot finish the step, for example at the review
                                                round cap; the owner decides. --gate names the review it is
                                                blocked at, by its number in the step's list. What the step
                                                wrote so far is recorded as draft; --updated names files
                                                beyond its produces paths, or inside a produces folder
  fuse-flow continue <slug> --skip <why>        skip the step: its condition does not hold, or the owner asked
  fuse-flow continue <slug> --owner-approved [--gate <n>] [--note <text>]
                                                the owner approved a step that awaits the owner or is blocked.
                                                With --gate, the owner accepts only the review the step is
                                                blocked at, and the step goes back to the agent for the gates
                                                still ahead
  fuse-flow continue <slug> --more-rounds <n> [--note <text>]
                                                the owner grants the step's agent gates n more review rounds,
                                                1 to 100 at a time
  fuse-flow continue <slug> --back-to <step> [--updated [<artifact>=]<file>]... [--note <text>]
                                                the owner sends the work back from the current step, whatever
                                                its status, to <step>, it or an earlier one. --updated records
                                                the files the current step wrote so far, for its next pass
  fuse-flow continue <slug> --forward-to <step> [--note <text>]
                                                the owner jumps forward; the steps passed over are skipped
  fuse-flow status <slug>                       show every step's state. A file shows once, under the latest
                                                step that records it.
                                                done means the step's gates passed and it has no owner gate;
                                                approved means an owner gate approved it
  fuse-flow list                                list this project's workstreams with their current step, and
                                                every workflow a workstream can follow, with its description
  fuse-flow validate <name, file or directory>...
                                                check workflows without starting a workstream; a
                                                directory stands for every .yml and .yaml file below
                                                it, so \`fuse-flow validate .konductor/workflows\` checks
                                                the project's workflows

workflows: a name is looked up as <name>.yml in .konductor/workflows/, ~/.konductor/workflows/,
           then the workflows that ship with fuse-flow; in each, at any depth (examples/,
           personal/, team/)
library:   artifact guides in .konductor/library/artifacts/<id>/, ~/.konductor/library/artifacts/<id>/,
           then the library that ships with fuse-flow
policy:    ~/.konductor/policy-overrides.yml, .konductor/policy-overrides.yml,
           .konductor/policy-overrides.local.yml; each overrides the ones before it
state:     .konductor/workstreams/<slug>.yml`;

// The options each command accepts. Anything else is a usage error.
// --unchanged and --not-produced take two values each and are read before
// these, by takePairs.
const OPTIONS = {
  start: { workflow: { type: "string" }, from: { type: "string" }, after: { type: "string" }, input: { type: "string", multiple: true } },
  continue: {
    updated: { type: "string", multiple: true },
    "owner-approved": { type: "boolean" },
    blocked: { type: "string" },
    gate: { type: "string" },
    skip: { type: "string" },
    waived: { type: "string" },
    "more-rounds": { type: "string" },
    "back-to": { type: "string" },
    "forward-to": { type: "string" },
    note: { type: "string" },
  },
  status: {},
} as const;

// Remove every `--<name> <artifact> <reason>` from args, and return them by
// artifact. A reason that is a lone option, such as --owner-approved, is that
// option given without the reason, not the reason.
function takePairs(args: string[], name: string): Record<string, string> {
  const pairs: Record<string, string> = {};
  for (let i = args.indexOf(`--${name}`); i >= 0; i = args.indexOf(`--${name}`)) {
    const [artifact, reason] = [args[i + 1], args[i + 2]];
    if (!artifact || !reason || artifact.startsWith("--") || !reason.trim() || /^--[a-z][a-z-]*(=.*)?$/.test(reason)) {
      throw new UsageError(`--${name} takes an artifact and a reason, for example --${name} code "only the docs changed"`);
    }
    pairs[artifact] = reason.trim();
    args.splice(i, 3);
  }
  return pairs;
}

type Command = keyof typeof OPTIONS;

function parse(command: Command, args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({ args, options: OPTIONS[command], allowPositionals: true, strict: true, tokens: true });
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (parsed.positionals.length !== 1) throw new UsageError(`${command} takes <slug>`);
  checkSlug(parsed.positionals[0]);
  // parseArgs keeps the last of a repeated option; one that takes a single
  // value is refused instead, so a second value is never silently dropped.
  const options = OPTIONS[command] as Record<string, { type: string; multiple?: boolean }>;
  const seen = new Set<string>();
  for (const token of parsed.tokens as { kind: string; name?: string }[]) {
    if (token.kind !== "option" || token.name === undefined || options[token.name]?.multiple) continue;
    if (seen.has(token.name)) throw new UsageError(`--${token.name} is given twice; give it once`);
    seen.add(token.name);
  }
  for (const [name, value] of Object.entries(parsed.values)) {
    if (value === "" || (Array.isArray(value) && value.includes(""))) throw new UsageError(`--${name} needs a value`);
  }
  return { slug: parsed.positionals[0], values: parsed.values as Record<string, string | string[] | boolean> };
}

// A file the agent names, as an absolute path. A relative path is read from
// the current directory; when nothing is there but there is at the
// repository root, it is read from the root, since the step block prints
// paths relative to the root. A file found in neither place, such as one the
// step deleted, is read where more of its path is still there: a deleted
// file's folder usually is.
function fromHere(root: string, path: string): string {
  const here = resolve(path);
  if (isAbsolute(path) || existsSync(here)) return here;
  const atRoot = resolve(root, path);
  if (existsSync(atRoot)) return atRoot;
  return missingParts(atRoot) < missingParts(here) ? atRoot : here;
}

// A file the agent named with --updated, as fromHere finds it. When it is in
// neither place, the other place is passed on too, so the step's declared
// paths, which the CLI does not know, can decide which one the agent meant.
function namedHere(root: string, path: string, artifact?: string): commands.Named {
  const file = fromHere(root, path);
  const other = [resolve(path), resolve(root, path)].find((p) => p !== file);
  const absent = !isAbsolute(path) && !existsSync(file) && other !== undefined && !existsSync(other);
  return { ...(artifact === undefined ? {} : { artifact }), file, ...(absent ? { alternative: other } : {}) };
}

// How many trailing parts of `path` are not on disk.
function missingParts(path: string): number {
  let n = 0;
  for (let p = path; !existsSync(p) && dirname(p) !== p; p = dirname(p)) n += 1;
  return n;
}

// The artifact names given with --unchanged and --not-produced. A name that
// can only be a path, as an artifact id holds no "/" or ".", is found as
// fromHere finds a file; one found nowhere is passed on as it was given.
function namesFromHere(root: string, given: Record<string, string>): Record<string, string> {
  const named = (name: string) => {
    const found = fromHere(root, name);
    return /^[a-z0-9][a-z0-9-]*$/.test(name) || !existsSync(found) ? name : found;
  };
  return Object.fromEntries(Object.entries(given).map(([name, why]) => [named(name), why]));
}

function run(argv: string[]): string[] {
  const [command, ...args] = argv;
  const unchanged = command === "continue" ? takePairs(args, "unchanged") : {};
  const notProduced = command === "continue" ? takePairs(args, "not-produced") : {};
  if (command === "help" || command === "--help" || command === "-h") return [USAGE];
  if (command === "validate") return validate(args);
  if (command === "list") {
    if (args.length) throw new UsageError("list takes no arguments");
    const root = findRepoRoot(process.cwd());
    ignoreLocalPolicy(root);
    return commands.list(root);
  }
  if (!command || !Object.hasOwn(OPTIONS, command)) throw new UsageError(command ? `unknown command "${command}"` : "no command");

  const { slug, values } = parse(command as Command, args);
  const root = findRepoRoot(process.cwd());
  ignoreLocalPolicy(root);
  switch (command as Command) {
    case "start": {
      // A path is made absolute here, so the workstream still finds it when
      // a later command runs from another directory. A relative path is read
      // as continue reads one: from the current directory, else from the root.
      const workflow = values.workflow as string | undefined;
      const resolved = workflow && isWorkflowPath(workflow) ? fromHere(root, workflow) : workflow;
      const after = values.after as string | undefined;
      if (after !== undefined) checkSlug(after);
      const inputs: Record<string, string> = {};
      for (const pair of (values.input as string[] | undefined) ?? []) {
        const m = /^([a-z0-9][a-z0-9-]*)=(.+)$/.exec(pair);
        if (!m) throw new UsageError(`--input takes <artifact-id>=<path>, for example --input product-brief=docs/brief.md; got "${pair}"`);
        if (Object.hasOwn(inputs, m[1])) throw new UsageError(`--input ${m[1]} is given twice`);
        inputs[m[1]] = fromHere(root, m[2]);
      }
      return commands.start(root, slug, resolved, values.from as string | undefined, { ...(after !== undefined ? { after } : {}), inputs });
    }
    case "continue": {
      const ownerApproved = Boolean(values["owner-approved"]);
      const moreRounds = values["more-rounds"] as string | undefined;
      const backTo = values["back-to"] as string | undefined;
      const forwardTo = values["forward-to"] as string | undefined;
      // The owner's decisions, and the agent's reports, are one each.
      const decisions = [
        ownerApproved && "--owner-approved",
        moreRounds !== undefined && "--more-rounds",
        backTo !== undefined && "--back-to",
        forwardTo !== undefined && "--forward-to",
      ].filter(Boolean) as string[];
      const reports = [values.blocked !== undefined && "--blocked", values.skip !== undefined && "--skip"].filter(Boolean) as string[];
      const work = [
        values.updated !== undefined && "--updated",
        Object.keys(unchanged).length > 0 && "--unchanged",
        Object.keys(notProduced).length > 0 && "--not-produced",
      ].filter(Boolean) as string[];
      const actions = [...decisions, ...reports];
      if (actions.length > 1) throw new UsageError(`${actions.join(" and ")} are different decisions; give one`);
      // A waiver goes with the agent's report that the work is done.
      if (values.waived !== undefined && actions.length) throw new UsageError(`--waived goes with the report that the work is done; it does not go with ${actions[0]}`);
      // A send-back, and a block, may record what the current step wrote so far.
      const recordsWork = (backTo !== undefined || values.blocked !== undefined) && work.every((w) => w === "--updated");
      if (actions.length && work.length && !recordsWork) {
        const recording = backTo !== undefined || values.blocked !== undefined;
        throw new UsageError(`${work.find((w) => !recording || w !== "--updated")} reports the agent's work; it does not go with ${actions[0]}`);
      }
      if (values.note !== undefined && decisions.length === 0) {
        throw new UsageError("--note goes with --owner-approved, --more-rounds, --back-to or --forward-to");
      }
      const gate = values.gate as string | undefined;
      if (gate !== undefined && values.blocked === undefined && !ownerApproved) {
        throw new UsageError("--gate goes with --blocked or --owner-approved");
      }
      if (gate !== undefined && !/^[1-9][0-9]*$/.test(gate)) throw new UsageError("--gate takes the number of a gate in the step's list, 1 or more");
      if (moreRounds !== undefined && !(/^[1-9][0-9]*$/.test(moreRounds) && Number(moreRounds) <= MAX_MORE_ROUNDS)) {
        throw new UsageError(`--more-rounds takes a whole number of rounds, 1 or more and at most ${MAX_MORE_ROUNDS}`);
      }
      return commands.continueWorkstream(root, slug, {
        ownerApproved,
        note: values.note as string | undefined,
        blocked: values.blocked as string | undefined,
        gate: gate === undefined ? undefined : Number(gate),
        skip: values.skip as string | undefined,
        waived: values.waived as string | undefined,
        moreRounds: moreRounds === undefined ? undefined : Number(moreRounds),
        backTo,
        forwardTo,
        updated: ((values.updated as string[] | undefined) ?? []).map((value) => {
          // --updated <artifact>=<file> names the artifact the file counts for.
          const m = /^([a-z0-9][a-z0-9-]*)=(.+)$/.exec(value);
          return m ? namedHere(root, m[2], m[1]) : namedHere(root, value);
        }),
        unchanged: namesFromHere(root, unchanged),
        notProduced: namesFromHere(root, notProduced),
      });
    }
    case "status":
      return commands.status(root, slug);
  }
}

// `validate` takes references rather than a slug. A path or a directory is
// made absolute against the current directory; a directory wins over a
// workflow name that happens to be spelled the same.
function validate(args: string[]): string[] {
  let refs: string[];
  try {
    refs = parseArgs({ args, options: {}, allowPositionals: true, strict: true }).positionals;
  } catch (e) {
    throw new UsageError((e as Error).message);
  }
  if (refs.length === 0) throw new UsageError("validate takes workflow names, files or directories, for example: validate .konductor/workflows");
  const root = findRepoRoot(process.cwd());
  ignoreLocalPolicy(root);
  return commands.validate(root, refs.map((ref) => (isWorkflowPath(ref) || isDirectory(ref) ? resolve(ref) : ref)));
}

function main(argv: string[]): number {
  try {
    for (const line of run(argv)) console.log(line);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      console.log(`error: ${e.message}\n\n${USAGE}`);
      return 64;
    }
    if (e instanceof FlowError) {
      console.log(`REFUSED: ${e.message}`);
      return 1;
    }
    // A file fuse-flow cannot read or write. Node's message names the
    // operation and the path, which is all the user needs.
    if (e instanceof Error && "syscall" in e) {
      console.log(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
