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
// was never saved. A file that cannot be read still counts: fuse-flow picks a
// name by the files that exist and reads the one it picked afterwards, so a
// name that leads to it fails there, and it makes a name ambiguous like any
// other file. A folder that cannot be searched fails every name looked up in
// its location, because fuse-flow's search stops there. The server lists both
// as unavailable. No React, no DOM, no Node APIs.

export interface ListedWorkflow {
  location: string;
  path: string;
  // The file's path with links resolved, when it differs from `path`.
  realPath?: string;
  onDisk: boolean;
}

// What the server lists as unusable: a workflow file that cannot be read, a
// workflow location with a folder that cannot be searched, a link whose
// target is missing, or a working copy that cannot be read. `path` is the
// file, link or working copy, or the location's folder; `reason` is the
// error. Only files and folders take part in resolving a reference: fuse-flow
// skips a broken link without a word and never reads a working copy.
export interface UnavailableWorkflow {
  location: string;
  path: string;
  kind: "file" | "folder" | "link" | "working-copy";
  reason: string;
}

export type Resolution<T> = { ok: true; target: T } | { ok: false; reason: string; unavailable?: UnavailableWorkflow };

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

// A reference written in the workflow file `from`, written again so that it
// names the same file when it is written in the workflow file `to`. An
// absolute path stays as it is, and so does a relative one that already
// names that file from `to`. Any other relative path is written relative to
// `to`, and one that would then have no "/" is written ./<file>, so that it
// stays a path: fuse-flow reads "child" as a name, and "child.yml" in another
// folder may be another file. Only paths are given: a reference by name is
// looked up by fuse-flow wherever the file is, and is not rewritten.
export function rebaseRef(ref: string, from: string, to: string): string {
  if (ref.startsWith("/")) return ref;
  const named = normalizePath(`${dirOf(from)}/${ref}`);
  if (normalizePath(`${dirOf(to)}/${ref}`) === named) return ref;
  const target = named.split("/").filter(Boolean);
  const base = normalizePath(dirOf(to)).split("/").filter(Boolean);
  let common = 0;
  while (common < target.length && common < base.length && target[common] === base[common]) common++;
  const rebased = [...base.slice(common).map(() => ".."), ...target.slice(common)].join("/");
  return rebased.includes("/") ? rebased : `./${rebased}`;
}
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

// Where a listed or unavailable workflow is, which is all a lookup level reads.
type Placed = Pick<ListedWorkflow, "location" | "path">;

// `projectDir` is the workflow folder of the run's project.
export function resolveWorkflowRef<T extends ListedWorkflow>(
  ref: string,
  from: string,
  workflows: T[],
  projectDir: string,
  unavailable: UnavailableWorkflow[] = [],
): Resolution<T> {
  const onDisk = workflows.filter((w) => w.onDisk);
  const unreadable = unavailable.filter((u) => u.kind === "file");
  if (isWorkflowPath(ref)) {
    const wanted = normalizePath(ref.startsWith("/") ? ref : `${dirOf(from)}/${ref}`);
    // fuse-flow reads the file at the path, and reads the paths that file
    // names relative to that path. The listed file at that path is it; else
    // the listed file whose real path it is, which the server gives only when
    // the file names the same files read from either path.
    const target =
      onDisk.find((w) => normalizePath(w.path) === wanted) ?? onDisk.find((w) => w.realPath !== undefined && normalizePath(w.realPath) === wanted);
    if (target) return { ok: true, target };
    const locked = unreadable.find((u) => normalizePath(u.path) === wanted);
    if (locked) return { ok: false, reason: `${locked.path} cannot be read: ${locked.reason}`, unavailable: locked };
    return { ok: false, reason: `no workflow at ${wanted} in Komposer's workflow locations` };
  }
  const project = normalizePath(projectDir);
  const levels = [
    (w: Placed) => {
      const path = normalizePath(w.path);
      return path === project || path.startsWith(`${project}/`);
    },
    ...SHARED_LOCATIONS.map((location) => (w: Placed) => w.location === location),
  ];
  for (const level of levels) {
    const folder = unavailable.find((u) => u.kind === "folder" && level(u));
    if (folder) {
      return { ok: false, reason: `the workflows in ${folder.path} cannot be searched: ${folder.reason}`, unavailable: folder };
    }
    const named = (w: Placed) => level(w) && baseOf(w.path) === `${ref}.yml`;
    const found = onDisk.filter(named);
    const locked = unreadable.filter(named);
    if (found.length + locked.length > 1) {
      const paths = [...found, ...locked].map((w) => w.path).join(", ");
      return { ok: false, reason: `workflow name "${ref}" is ambiguous; rename one of: ${paths}` };
    }
    if (found.length === 1) return { ok: true, target: found[0] };
    if (locked.length === 1) {
      return { ok: false, reason: `workflow "${ref}" is ${locked[0].path}, which cannot be read: ${locked[0].reason}`, unavailable: locked[0] };
    }
  }
  return { ok: false, reason: `no workflow named "${ref}"` };
}
