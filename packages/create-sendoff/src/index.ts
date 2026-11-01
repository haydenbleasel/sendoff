#!/usr/bin/env node
// The entry point: wires main() to the real process (arguments, terminal,
// commands and exit code). The flow itself is in main.ts, which is tested.

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  spinner,
} from "@clack/prompts";

import { awsLogin } from "./aws";
import { main } from "./main";
import { handOff, installed, run } from "./run";

process.exitCode = await main({
  argv: process.argv.slice(2),
  awsLogin,
  cwd: process.cwd(),
  handOff,
  installed,
  prompts: { cancel, confirm, intro, isCancel, log, outro, spinner },
  run,
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
});
