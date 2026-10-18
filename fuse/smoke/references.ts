// SPDX-License-Identifier: Apache-2.0
// The files a workflow names by relative path, which must be copied with it:
// agent gates' review guides, and child and hand-off workflows given by path,
// with the files those name in turn. run.sh copies a workflow that does not
// ship with fuse-flow into the test project, and copies these next to it.
//
// usage: bun references.ts <workflow file>
// Prints each file relative to the workflow's folder, one per line, and warns
// on stderr about a named file that does not exist, which is the workflow's
// own defect and is left for the run to show.
// Exit codes: 0 listed, 1 a named file is outside the workflow's folder or a
// workflow cannot be read; 64 usage error.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { formatIssue, parseWorkflowText } from "../flow/src/parse.ts";
import { isWorkflowPath } from "../flow/src/project.ts";

const [file, ...rest] = process.argv.slice(2);
if (!file || rest.length > 0) {
  console.error("usage: bun references.ts <workflow file>");
  process.exit(64);
}
const top = dirname(resolve(file));
const found = new Set<string>();
const problems: string[] = [];
const missing = (rel: string) => console.error(`warning: ${rel}, named by the workflow, does not exist`);

function visit(path: string): void {
  const parsed = parseWorkflowText(readFileSync(path, "utf8"));
  if (!parsed.ok) {
    problems.push(`${path}: ${parsed.issues.map(formatIssue).join("; ")}`);
    return;
  }
  const named = (ref: string, workflow: boolean) => {
    if (isAbsolute(ref) || (workflow && !isWorkflowPath(ref))) return;
    const target = resolve(dirname(path), ref);
    const rel = relative(top, target);
    if (rel === ".." || rel.startsWith("../")) {
      problems.push(`${relative(top, path) || path} names ${ref}, which is outside the folder of ${file}`);
      return;
    }
    if (found.has(rel)) return;
    if (!existsSync(target)) return missing(rel);
    found.add(rel);
    if (workflow) visit(target);
  };
  for (const step of parsed.workflow.steps) {
    for (const gate of step.gates) {
      if (gate.guide) named(gate.guide, false);
      if (gate.kind === "workflow") named(gate.text, true);
    }
  }
  for (const handOff of parsed.workflow.hands_off_to) named(handOff.workflow, true);
}

visit(resolve(file));
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
for (const rel of [...found].sort()) console.log(rel);
