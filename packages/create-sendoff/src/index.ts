#!/usr/bin/env node
// The entry point. `bunx` runs it with whatever Node is installed, and on a
// Node too old for the CLI's dependencies the bundle fails to load with an
// error about a missing export, before it can say anything. So this checks
// first, then loads the rest (a separate chunk; see the build script).

import { MIN_NODE, supportsNode } from "./node-version";

if (supportsNode(process.versions.node)) {
  await import("./start");
} else {
  process.stderr.write(
    `create-sendoff needs Node.js ${MIN_NODE} or newer, and this is ${process.versions.node}. Update Node.js (https://nodejs.org), then run it again.\n`
  );
  process.exitCode = 1;
}
