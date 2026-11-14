// Wires main() to the real process (arguments, terminal, commands and exit
// code). index.ts loads it once Node is new enough. The flow itself is in
// main.ts, which is tested.

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

// The shell's code for Ctrl+C.
const EXIT_CANCELLED = 130;

let finished = false;

// clack's spinner exits with 0 itself when Ctrl+C is pressed while it spins,
// which would report a cancelled run as a success.
process.once("exit", (code) => {
  if (!finished && code === 0) {
    process.exitCode = EXIT_CANCELLED;
  }
});

process.exitCode = await main({
  argv: process.argv.slice(2),
  awsLogin,
  cwd: process.cwd(),
  handOff,
  installed,
  interactive: process.stdin.isTTY === true,
  prompts: { cancel, confirm, intro, isCancel, log, outro, spinner },
  run,
  stderr: (text) => process.stderr.write(text),
  stdout: (text) => process.stdout.write(text),
});

finished = true;
