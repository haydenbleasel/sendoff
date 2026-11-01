import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";

export interface RunResult {
  /** The command isn't installed. */
  missing: boolean;
  ok: boolean;
  /** stdout and stderr together, to show when something fails. */
  output: string;
  stdout: string;
}

/** Whether `command --version` runs, i.e. the tool is installed. */
export const installed = (command: string): boolean => {
  const result = spawnSync(command, ["--version"], { stdio: "ignore" });

  return result.error === undefined && result.status === 0;
};

/**
 * Runs a command with its output captured, so a spinner can animate while it
 * works and the output only shows if it fails.
 */
export const run = async (
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): Promise<RunResult> => {
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  const stdout: string[] = [];

  child.stdout.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
    stdout.push(chunk.toString());
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.push(chunk.toString());
  });

  try {
    // Rejects with the spawn error, such as ENOENT when it isn't installed.
    await once(child, "close");
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";

    const message = error instanceof Error ? error.message : String(error);

    return { missing, ok: false, output: message, stdout: "" };
  }

  return {
    missing: false,
    ok: child.exitCode === 0,
    output: output.join(""),
    stdout: stdout.join(""),
  };
};

/** Ctrl+C reaches the child too; it decides how to exit. */
const waitForChild = () => {
  // Without a listener, Node would quit before the child finishes.
};

/**
 * Hands the terminal to a command (setup's own prompts) and resolves with its
 * exit code.
 */
export const handOff = async (
  command: string,
  args: string[],
  cwd: string
): Promise<number> => {
  const child = spawn(command, args, { cwd, stdio: "inherit" });

  process.on("SIGINT", waitForChild);

  try {
    await once(child, "close");

    return child.exitCode ?? 1;
  } catch {
    return 1;
  } finally {
    process.off("SIGINT", waitForChild);
  }
};
