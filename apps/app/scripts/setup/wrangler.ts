import { spawnSync } from "node:child_process";

import { APP_DIR } from "./files";

export interface WranglerResult {
  ok: boolean;
  output: string;
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
  };
};

export const wranglerJson = <T>(
  args: string[],
  options: WranglerOptions = {}
): T | null => {
  const result = wrangler([...args, "--json"], options);

  if (!result.ok) {
    return null;
  }

  try {
    // SAFETY: Wrangler's --json output; callers read only the fields they need.
    return JSON.parse(result.output.slice(result.output.search(/[[{]/u))) as T;
  } catch {
    return null;
  }
};
