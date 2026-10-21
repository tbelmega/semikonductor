// SPDX-License-Identifier: Apache-2.0
// Start Komposer on one project:
//
//   bun run start -- [<project directory>] [--port <n>] [--kanvas <dir>]
//
// The project is the git repository at or above the directory given (the
// current one by default). The command prints the URL to open. --kanvas names
// the folder whose design/ folder the Kanvas page shows, the project by
// default (prototype).

import { resolve } from "node:path";
import { findRepoRoot } from "../../flow/src/project.ts";
import { startServer } from "./app.ts";

const DEFAULT_PORT = 4807;

function parseArgs(argv: string[]): { dir: string; port: number; kanvas?: string } {
  let dir = process.cwd();
  let port = DEFAULT_PORT;
  let kanvas: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port needs a port number");
    } else if (arg === "--kanvas") {
      kanvas = argv[++i];
      if (!kanvas) throw new Error("--kanvas needs a folder");
    } else if (arg.startsWith("-")) {
      throw new Error(`unknown option ${arg}; usage: bun run start -- [<project directory>] [--port <n>] [--kanvas <dir>]`);
    } else {
      dir = arg;
    }
  }
  return { dir, port, ...(kanvas ? { kanvas: resolve(kanvas) } : {}) };
}

try {
  const { dir, port, kanvas } = parseArgs(process.argv.slice(2));
  const root = findRepoRoot(dir);
  const server = startServer({
    root,
    port,
    appDir: resolve(import.meta.dir, "..", "dist"),
    ...(kanvas ? { kanvasDir: kanvas } : {}),
  });
  console.log(`Komposer for ${root}`);
  console.log(`open ${server.url}`);
  console.log(`with \`bun run dev\`, open http://127.0.0.1:5173`);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
