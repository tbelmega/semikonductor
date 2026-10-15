// SPDX-License-Identifier: Apache-2.0
// A lock file around one read and write of a small state file, so two
// fuse-flow processes never overwrite each other's change.

import { rmSync, writeFileSync } from "node:fs";
import { FlowError } from "./errors.ts";

const LOCK_WAIT_MS = 2000;

// The lock is held only for the few milliseconds of one read and write, never
// while a check command runs. A lock file left behind by a killed process is
// not removed automatically; the error names the file to delete.
export function withLock(lockFile: string, fn: () => void): void {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      writeFileSync(lockFile, `${process.pid}\n`, { flag: "wx" });
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (Date.now() > deadline) {
        throw new FlowError(`another fuse-flow process holds ${lockFile}; if none is running, delete that file`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20); // sleep 20 ms
    }
  }
  try {
    fn();
  } finally {
    rmSync(lockFile, { force: true });
  }
}
