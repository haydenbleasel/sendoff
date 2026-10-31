import { spawnSync } from "node:child_process";

import { APP_DIR } from "./files";

export interface WranglerResult {
  ok: boolean;
  output: string;
}

/**
 * Run the project's Wrangler. Interactive commands (login, migrations that
 * ask to confirm) inherit the terminal; the rest capture output.
 */
export const wrangler = (
  args: string[],
  { input, interactive = false }: { input?: string; interactive?: boolean } = {}
): WranglerResult => {
  const result = spawnSync("bunx", ["wrangler", ...args], {
    cwd: APP_DIR,
    encoding: "utf-8",
    input,
    stdio: interactive ? "inherit" : "pipe",
  });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
};

export const wranglerJson = <T>(args: string[]): T | null => {
  const result = wrangler([...args, "--json"]);

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
