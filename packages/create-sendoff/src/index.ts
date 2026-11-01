#!/usr/bin/env node
// `bun create sendoff [folder]`: clone Sendoff, install it, and hand off to
// `bun run setup`, which deploys it into your Cloudflare and AWS accounts.
// A clone (not a copy) keeps `git pull` working for updates.

import path from "node:path";

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
import { USAGE, parseCommand } from "./cli";
import type { Command } from "./cli";
import { handOff, installed, run } from "./run";
import { commandIn, displayPath, inspectTarget } from "./target";

const TOOLS = [
  { command: "git", install: "https://git-scm.com/downloads", name: "Git" },
  { command: "bun", install: "https://bun.sh", name: "Bun" },
];

const AWS_CLI = "https://aws.amazon.com/cli/";
const UPDATING_DOCS = "https://sendoff.dev/docs/guides/updating";

const stop = (message: string) => {
  cancel(message);
  process.exitCode = 1;
};

const readCommand = (): Command | undefined => {
  try {
    return parseCommand(process.argv.slice(2));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    process.stderr.write(`${reason}\n\n${USAGE}`);
    process.exitCode = 1;

    return undefined;
  }
};

/** Git and Bun are required. Says which are missing, if any. */
const checkTools = (): boolean => {
  const missing = TOOLS.filter((tool) => !installed(tool.command));

  if (missing.length === 0) {
    return true;
  }

  const list = missing
    .map((tool) => `${tool.name} (${tool.install})`)
    .join(" and ");

  stop(
    `Sendoff needs ${list}. Install ${missing.length > 1 ? "them" : "it"}, then run this again.`
  );

  return false;
};

/**
 * Setup is much easier with the AWS CLI logged in, so check before cloning
 * and give people the chance to log in first. Returns whether to carry on.
 */
const checkAws = async (): Promise<boolean> => {
  const check = spinner();

  check.start("Checking your AWS CLI login");
  const login = await awsLogin();

  if (login.status === "logged-in") {
    check.stop(`AWS CLI logged in as ${login.arn}`);

    return true;
  }

  check.clear();

  const fix =
    login.status === "missing"
      ? `Install it from ${AWS_CLI} and log in`
      : "Log in with `aws login`, `aws sso login` or a profile";

  log.warn(
    `The AWS CLI isn't ${login.status === "missing" ? "installed" : "logged in"}. Setup uses its login to create the SES resources and a send-only key for the Worker; without it, you create an IAM user and keys by hand. ${fix}.`
  );

  const proceed = await confirm({
    initialValue: false,
    message: "Continue without the AWS CLI?",
  });

  if (isCancel(proceed) || !proceed) {
    cancel("Log in to the AWS CLI, then run this again.");

    return false;
  }

  return true;
};

/** Runs a command under a spinner, showing its output only if it fails. */
const task = async (
  labels: { done: string; failed: string; start: string },
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> => {
  const progress = spinner();

  progress.start(labels.start);
  const result = await run(command, args, options);

  if (result.ok) {
    progress.stop(labels.done);

    return true;
  }

  progress.error(labels.failed);
  log.message(result.output.trim());
  process.exitCode = 1;

  return false;
};

const finished = (cwd: string, dir: string, shown: string) =>
  [
    "",
    `Sendoff lives in ${shown}. Keep that folder: apps/app/.sendoff holds your`,
    "instance's settings, and updates deploy from it.",
    "",
    `  Run setup again   ${commandIn(cwd, dir, "bun run setup")}`,
    `  Ship an update    ${commandIn(cwd, dir, "git pull && bun install && bun run deploy")}`,
    "",
    `More: ${UPDATING_DOCS}`,
    "",
  ].join("\n");

const stopped = (cwd: string, dir: string) =>
  [
    "",
    "Setup didn't finish. Pick up where it stopped with:",
    "",
    `  ${commandIn(cwd, dir, "bun run setup")}`,
    "",
  ].join("\n");

const main = async () => {
  const command = readCommand();

  if (command === undefined) {
    return;
  }

  if (command.kind === "help") {
    process.stdout.write(USAGE);

    return;
  }

  const cwd = process.cwd();
  const dir = path.resolve(cwd, command.folder);
  const shown = displayPath(cwd, dir);
  const target = inspectTarget(dir);

  intro("create-sendoff");

  if (target === "taken") {
    stop(
      `${shown} already exists and isn't a Sendoff clone. Choose another folder: bun create sendoff <folder>`
    );

    return;
  }

  if (!checkTools() || !(await checkAws())) {
    return;
  }

  if (target === "sendoff") {
    log.info(
      `${shown} already has Sendoff, so setup picks up where it stopped.`
    );
  } else {
    const cloned = await task(
      {
        done: `Cloned Sendoff into ${shown}`,
        failed: "Couldn't clone Sendoff",
        start: `Cloning Sendoff into ${shown}`,
      },
      "git",
      ["clone", command.repo, dir],
      // Fail with git's message instead of prompting for a password under the spinner.
      { env: { GIT_TERMINAL_PROMPT: "0" } }
    );

    if (!cloned) {
      return;
    }
  }

  const ready = await task(
    {
      done: "Installed dependencies",
      failed: "Couldn't install dependencies",
      start: "Installing dependencies",
    },
    "bun",
    ["install"],
    { cwd: dir }
  );

  if (!ready) {
    return;
  }

  outro("Starting setup");

  const code = await handOff("bun", ["run", "setup"], dir);

  process.stdout.write(
    code === 0 ? finished(cwd, dir, shown) : stopped(cwd, dir)
  );
  process.exitCode = code;
};

await main();
