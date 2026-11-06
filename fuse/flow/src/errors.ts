// SPDX-License-Identifier: Apache-2.0
// The ways a command can fail. cli.ts turns them into exit codes.

// The command was understood but cannot be carried out: a refused `continue`, a
// missing file, an invalid workflow. Exit code 1.
export class FlowError extends Error {}

// The command line itself is wrong: unknown command, missing argument,
// unknown option. Exit code 64.
export class UsageError extends Error {}

// A command that ran and reports a failure in its output, such as a check
// that failed under `fuse-flow check`. Its lines are printed as they are.
// Exit code 1.
export class FailedResult extends Error {
  readonly lines: string[];
  constructor(lines: string[]) {
    super(lines.join("\n"));
    this.lines = lines;
  }
}
