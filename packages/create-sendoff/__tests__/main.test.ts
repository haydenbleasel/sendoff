import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { AwsLogin } from "../src/aws";
import { DEFAULT_REPO, USAGE } from "../src/cli";
import { main } from "../src/main";
import type { Deps } from "../src/main";
import type { RunResult } from "../src/run";

const CANCELLED = Symbol("cancelled");
const ARN = "arn:aws:iam::123456789012:user/hayden";

let cwd = "";

beforeEach(() => {
  cwd = mkdtempSync(path.join(tmpdir(), "create-sendoff-main-"));
});

afterEach(() => {
  rmSync(cwd, { force: true, recursive: true });
});

interface Options {
  argv?: string[];
  confirm?: boolean | typeof CANCELLED;
  handOff?: number;
  installed?: string[];
  login?: AwsLogin;
  /** Results by command name; anything else succeeds. */
  results?: Record<string, Partial<RunResult>>;
}

/** Fakes for everything main() touches, recording what happened. */
const harness = (options: Options = {}) => {
  const events: string[] = [];
  const runs: { args: string[]; command: string; options: unknown }[] = [];
  const handOffs: { args: string[]; command: string; cwd: string }[] = [];
  const output = { stderr: "", stdout: "" };
  const installed = options.installed ?? ["git", "bun"];

  const deps: Deps = {
    argv: options.argv ?? [],
    awsLogin: () =>
      Promise.resolve(options.login ?? { arn: ARN, status: "logged-in" }),
    cwd,
    handOff: (command, args, dir) => {
      handOffs.push({ args, command, cwd: dir });

      return Promise.resolve(options.handOff ?? 0);
    },
    installed: (command) => installed.includes(command),
    prompts: {
      cancel: (message) => events.push(`cancel: ${message}`),
      confirm: () => Promise.resolve(options.confirm ?? true),
      intro: (message) => events.push(`intro: ${message}`),
      isCancel: (value: unknown): value is symbol => value === CANCELLED,
      log: {
        info: (message) => events.push(`info: ${message}`),
        message: (message) => events.push(`message: ${message}`),
        warn: (message) => events.push(`warn: ${message}`),
      },
      outro: (message) => events.push(`outro: ${message}`),
      spinner: () => ({
        clear: () => events.push("spinner cleared"),
        error: (message) => events.push(`failed: ${message}`),
        start: (message) => events.push(`started: ${message}`),
        stop: (message) => events.push(`done: ${message}`),
      }),
    },
    run: (command, args, runOptions) => {
      runs.push({ args, command, options: runOptions });

      return Promise.resolve({
        missing: false,
        ok: true,
        output: "",
        stdout: "",
        ...options.results?.[command],
      });
    },
    stderr: (text) => {
      output.stderr += text;
    },
    stdout: (text) => {
      output.stdout += text;
    },
  };

  return { deps, events, handOffs, output, runs };
};

/** An earlier clone in `dir`, as inspectTarget recognizes it. */
const checkout = (dir: string) => {
  mkdirSync(path.join(dir, "apps", "app", "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "apps", "app", "scripts", "setup.ts"), "");
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "sendoff" })
  );
};

describe("arguments", () => {
  it("prints help", async () => {
    const run = harness({ argv: ["--help"] });

    expect(await main(run.deps)).toBe(0);
    expect(run.output.stdout).toBe(USAGE);
    expect(run.events).toStrictEqual([]);
  });

  it("explains arguments it doesn't understand", async () => {
    const run = harness({ argv: ["--yes"] });

    expect(await main(run.deps)).toBe(1);
    expect(run.output.stderr).toContain("--yes");
    expect(run.output.stderr).toContain(USAGE);
  });
});

describe("before cloning", () => {
  it("refuses a folder that isn't a Sendoff clone", async () => {
    mkdirSync(path.join(cwd, "taken"));
    writeFileSync(path.join(cwd, "taken", "notes.txt"), "");
    const run = harness({ argv: ["taken"] });

    expect(await main(run.deps)).toBe(1);
    expect(run.events).toContain(
      "cancel: ./taken already exists and isn't a Sendoff clone. Choose another folder: bun create sendoff <folder>"
    );
    expect(run.runs).toStrictEqual([]);
  });

  it("names the tools that are missing", async () => {
    const noGit = harness({ installed: ["bun"] });
    const neither = harness({ installed: [] });

    expect(await main(noGit.deps)).toBe(1);
    expect(await main(neither.deps)).toBe(1);
    expect(noGit.events).toContain(
      "cancel: Sendoff needs Git (https://git-scm.com/downloads). Install it, then run this again."
    );
    expect(neither.events).toContain(
      "cancel: Sendoff needs Git (https://git-scm.com/downloads) and Bun (https://bun.sh). Install them, then run this again."
    );
  });

  it("stops without the AWS CLI unless the person carries on", async () => {
    const declined = harness({ confirm: false, login: { status: "missing" } });

    const cancelled = harness({
      confirm: CANCELLED,
      login: { status: "logged-out" },
    });

    expect(await main(declined.deps)).toBe(1);
    expect(await main(cancelled.deps)).toBe(1);
    expect(declined.events).toContain("spinner cleared");
    expect(declined.events.join("\n")).toContain(
      "The AWS CLI isn't installed."
    );
    expect(declined.events.join("\n")).toContain(
      "Install it from https://aws.amazon.com/cli/ and log in."
    );
    expect(cancelled.events.join("\n")).toContain(
      "The AWS CLI isn't logged in."
    );
    expect(cancelled.events).toContain(
      "cancel: Log in to the AWS CLI, then run this again."
    );
    expect(declined.runs).toStrictEqual([]);
  });
});

describe("cloning and setup", () => {
  it("clones, installs and hands off to setup", async () => {
    const run = harness();
    const dir = path.join(cwd, "sendoff");

    expect(await main(run.deps)).toBe(0);
    expect(run.events).toContain(`done: AWS CLI logged in as ${ARN}`);
    expect(run.runs).toStrictEqual([
      {
        args: ["clone", DEFAULT_REPO, dir],
        command: "git",
        options: { env: { GIT_TERMINAL_PROMPT: "0" } },
      },
      { args: ["install"], command: "bun", options: { cwd: dir } },
    ]);
    expect(run.handOffs).toStrictEqual([
      { args: ["run", "setup"], command: "bun", cwd: dir },
    ]);
    expect(run.events).toContain("outro: Starting setup");
    expect(run.output.stdout).toContain("Sendoff lives in ./sendoff.");
    expect(run.output.stdout).toContain(
      "Run setup again   cd sendoff && bun run setup"
    );
  });

  it("carries on without the AWS CLI when the person says so", async () => {
    const run = harness({ confirm: true, login: { status: "logged-out" } });

    expect(await main(run.deps)).toBe(0);
    expect(run.events.join("\n")).toContain("`aws sso login`");
    expect(run.handOffs).toHaveLength(1);
  });

  it("resumes an earlier clone instead of cloning again", async () => {
    checkout(path.join(cwd, "sendoff"));
    const run = harness();

    expect(await main(run.deps)).toBe(0);
    expect(run.events).toContain(
      "info: ./sendoff already has Sendoff, so setup picks up where it stopped."
    );
    expect(run.runs.map((entry) => entry.command)).toStrictEqual(["bun"]);
  });

  it("shows git's output when the clone fails", async () => {
    const run = harness({
      results: { git: { ok: false, output: "fatal: repository not found\n" } },
    });

    expect(await main(run.deps)).toBe(1);
    expect(run.events).toContain("failed: Couldn't clone Sendoff");
    expect(run.events).toContain("message: fatal: repository not found");
    expect(run.handOffs).toStrictEqual([]);
  });

  it("shows the output when installing fails", async () => {
    const run = harness({
      results: { bun: { ok: false, output: "error: lockfile\n" } },
    });

    expect(await main(run.deps)).toBe(1);
    expect(run.events).toContain("failed: Couldn't install dependencies");
    expect(run.handOffs).toStrictEqual([]);
  });

  it("says how to pick up when setup stops", async () => {
    const run = harness({ handOff: 2 });

    expect(await main(run.deps)).toBe(2);
    expect(run.output.stdout).toContain("Setup didn't finish.");
    expect(run.output.stdout).toContain("cd sendoff && bun run setup");
  });
});
