import { spawnSync } from "node:child_process";

import { APP_DIR } from "./files";

export interface WranglerResult {
  ok: boolean;
  /** stdout and stderr together, for showing on failure. */
  output: string;
  stdout: string;
}

export interface WranglerOptions {
  /** For commands with no config file to name the account, like `pages`. */
  accountId?: string | undefined;
  input?: string;
  interactive?: boolean;
}

/**
 * Run the project's Wrangler. Interactive commands (login, migrations that
 * ask to confirm) inherit the terminal; the rest capture output.
 */
export const wrangler = (
  args: string[],
  { accountId, input, interactive = false }: WranglerOptions = {}
): WranglerResult => {
  const result = spawnSync("bunx", ["wrangler", ...args], {
    cwd: APP_DIR,
    encoding: "utf-8",
    env: accountId
      ? { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId }
      : process.env,
    input,
    stdio: interactive ? "inherit" : "pipe",
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
  };
};

/** The JSON a command printed to stdout (a warning on stderr would break parsing), or null. */
export const parseJsonOutput = <T>(stdout: string): T | null => {
  try {
    // SAFETY: Wrangler's JSON output; callers read only the fields they need.
    return JSON.parse(stdout.slice(stdout.search(/[[{]/u))) as T;
  } catch {
    return null;
  }
};

export const wranglerJson = <T>(
  args: string[],
  options: WranglerOptions = {}
): T | null => {
  const result = wrangler([...args, "--json"], options);

  return result.ok ? parseJsonOutput<T>(result.stdout) : null;
};
