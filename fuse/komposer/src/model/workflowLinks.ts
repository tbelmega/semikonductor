// SPDX-License-Identifier: Apache-2.0
// Which workflow file a hand-off or a workflow gate names, found the way
// fuse-flow finds it (findWorkflow in flow/src/project.ts, loadWorkflow in
// flow/src/workflow.ts), among the files Komposer lists. fuse-flow's own code
// reads the disk, so it cannot run in the browser; this follows it:
//
// - A reference that contains "/" or ends in .yml or .yaml is a path,
//   relative to the workflow file that names it, or absolute.
// - Any other reference is a name: <name>.yml at any depth in the workflows
//   of the run's project, then the user's, then fuse-flow's. The first
//   location that holds one wins; two in one location are ambiguous. The
//   run's project is the one of the open run, or of the open workflow when it
//   belongs to another project; Komposer lists that project's workflow files.
//
// Only files on disk count, since fuse-flow does not see a working copy that
// was never saved. No React, no DOM, no Node APIs.

export interface ListedWorkflow {
  location: string;
  path: string;
  onDisk: boolean;
}

export type Resolution<T> = { ok: true; target: T } | { ok: false; reason: string };

// The locations fuse-flow looks up a name in after the project's own
// workflow folder (workflowDirs).
export const SHARED_LOCATIONS = ["personal", "fuse-flow"] as const;

export const isWorkflowPath = (ref: string): boolean => ref.includes("/") || /\.ya?ml$/.test(ref);

// A POSIX path with "." and ".." segments and repeated slashes removed.
export function normalizePath(path: string): string {
  const absolute = path.startsWith("/");
  const out: string[] = [];
  for (const part of path.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  return (absolute ? "/" : "") + out.join("/");
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1) || ".";
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// `projectDir` is the workflow folder of the run's project.
export function resolveWorkflowRef<T extends ListedWorkflow>(
  ref: string,
  from: string,
  workflows: T[],
  projectDir: string,
): Resolution<T> {
  const onDisk = workflows.filter((w) => w.onDisk);
  if (isWorkflowPath(ref)) {
    const wanted = normalizePath(ref.startsWith("/") ? ref : `${dirOf(from)}/${ref}`);
    const target = onDisk.find((w) => normalizePath(w.path) === wanted);
    return target ? { ok: true, target } : { ok: false, reason: `no workflow at ${wanted} in Komposer's workflow locations` };
  }
  const inProject = `${normalizePath(projectDir)}/`;
  const levels = [
    (w: T) => normalizePath(w.path).startsWith(inProject),
    ...SHARED_LOCATIONS.map((location) => (w: T) => w.location === location),
  ];
  for (const level of levels) {
    const found = onDisk.filter((w) => level(w) && baseOf(w.path) === `${ref}.yml`);
    if (found.length > 1) {
      return { ok: false, reason: `workflow name "${ref}" is ambiguous; rename one of: ${found.map((w) => w.path).join(", ")}` };
    }
    if (found.length === 1) return { ok: true, target: found[0] };
  }
  return { ok: false, reason: `no workflow named "${ref}"` };
}
