#!/usr/bin/env node
// Lists TCP listeners owned by processes running inside the current repo (Linux, macOS, Windows).
// Usage: node ~/.omp/agent/bin/dev-servers.mjs [dir]

import { resolve } from "node:path";

import { projectListeners, projectRoot } from "./lib/system.mjs";

const root = projectRoot(resolve(process.argv[2] ?? process.cwd()));
const listeners = projectListeners(root);

if (listeners.length === 0) {
  console.log(`No listening ports owned by processes inside ${root}.`);
  process.exit(1);
}
for (const { port, pid, cmd } of listeners) {
  const short = cmd.length > 120 ? `${cmd.slice(0, 120)}...` : cmd;
  console.log(`http://localhost:${port}  pid ${pid}  ${short}`);
}
