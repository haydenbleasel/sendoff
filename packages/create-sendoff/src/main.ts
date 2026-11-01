// `bun create sendoff [folder]`: clone Sendoff, install it, and hand off to
// `bun run setup`, which deploys it into your Cloudflare and AWS accounts.
// A clone (not a copy) keeps `git pull` working for updates.
//
// Everything that touches the outside world comes in through `Deps`, so
// tests can run the whole flow; index.ts wires it to the real process.

import path from "node:path";

import type { cancel, intro, log, outro, spinner } from "@clack/prompts";

import type { awsLogin } from "./aws";
import { USAGE, parseCommand } from "./cli";
import type { handOff, installed, run } from "./run";
import { commandIn, displayPath, inspectTarget } from "./target";

export interface Deps {
  argv: string[];
  awsLogin: typeof awsLogin;
  cwd: string;
  handOff: typeof handOff;
  installed: typeof installed;
  prompts: {
    cancel: typeof cancel;
    confirm: (options: {
      initialValue: boolean;
      message: string;
    }) => Promise<boolean | symbol>;
    intro: typeof intro;
    isCancel: (value: unknown) => value is symbol;
    log: Pick<typeof log, "info" | "message" | "warn">;
    outro: typeof outro;
    spinner: () => Pick<
      ReturnType<typeof spinner>,
      "clear" | "error" | "start" | "stop"
    >;
  };
  run: typeof run;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
}

const TOOLS = [
  { command: "git", install: "https://git-scm.com/downloads", name: "Git" },
  { command: "bun", install: "https://bun.sh", name: "Bun" },
];

const AWS_CLI = "https://aws.amazon.com/cli/";
const UPDATING_DOCS = "https://sendoff.dev/docs/guides/updating";

const FAILED = 1;
const OK = 0;

/** Git and Bun are required. Says which are missing, if any. */
const missingTools = (deps: Deps): string | undefined => {
  const missing = TOOLS.filter((tool) => !deps.installed(tool.command));

  if (missing.length === 0) {
    return undefined;
  }

  const list = missing
    .map((tool) => `${tool.name} (${tool.install})`)
    .join(" and ");

  return `Sendoff needs ${list}. Install ${missing.length > 1 ? "them" : "it"}, then run this again.`;
};

/**
 * Setup is much easier with the AWS CLI logged in, so check before cloning
 * and give people the chance to log in first. Returns whether to carry on.
 */
const checkAws = async ({ awsLogin, prompts }: Deps): Promise<boolean> => {
  const check = prompts.spinner();

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

  prompts.log.warn(
    `The AWS CLI isn't ${login.status === "missing" ? "installed" : "logged in"}. Setup uses its login to create the SES resources and a send-only key for the Worker; without it, you create an IAM user and keys by hand. ${fix}.`
  );

  const proceed = await prompts.confirm({
    initialValue: false,
    message: "Continue without the AWS CLI?",
  });

  if (prompts.isCancel(proceed) || !proceed) {
    prompts.cancel("Log in to the AWS CLI, then run this again.");

    return false;
  }

  return true;
};

/** Runs a command under a spinner, showing its output only if it fails. */
const task = async (
  { prompts, run }: Deps,
  labels: { done: string; failed: string; start: string },
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<boolean> => {
  const progress = prompts.spinner();

  progress.start(labels.start);
  const result = await run(command, args, options);

  if (result.ok) {
    progress.stop(labels.done);

    return true;
  }

  progress.error(labels.failed);
  prompts.log.message(result.output.trim());

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

/** Clone (unless resuming), install, then hand off to setup. Resolves with the exit code. */
export const main = async (deps: Deps): Promise<number> => {
  const { cwd, prompts } = deps;
  let command: ReturnType<typeof parseCommand>;

  try {
    command = parseCommand(deps.argv);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    deps.stderr(`${reason}\n\n${USAGE}`);

    return FAILED;
  }

  if (command.kind === "help") {
    deps.stdout(USAGE);

    return OK;
  }

  const dir = path.resolve(cwd, command.folder);
  const shown = displayPath(cwd, dir);
  const target = inspectTarget(dir);

  prompts.intro("create-sendoff");

  if (target === "taken") {
    prompts.cancel(
      `${shown} already exists and isn't a Sendoff clone. Choose another folder: bun create sendoff <folder>`
    );

    return FAILED;
  }

  const missing = missingTools(deps);

  if (missing) {
    prompts.cancel(missing);

    return FAILED;
  }

  if (!(await checkAws(deps))) {
    return FAILED;
  }

  if (target === "sendoff") {
    prompts.log.info(
      `${shown} already has Sendoff, so setup picks up where it stopped.`
    );
  } else {
    const cloned = await task(
      deps,
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
      return FAILED;
    }
  }

  const ready = await task(
    deps,
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
    return FAILED;
  }

  prompts.outro("Starting setup");

  const code = await deps.handOff("bun", ["run", "setup"], dir);

  deps.stdout(code === OK ? finished(cwd, dir, shown) : stopped(cwd, dir));

  return code;
};
