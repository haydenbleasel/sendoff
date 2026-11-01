import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { z } from "zod/mini";

import { parseJsonWith } from "./json";

/**
 * What's already at the folder Sendoff goes in: nothing, an empty folder, an
 * earlier clone (so setup can resume), or something else.
 */
export type Target = "empty" | "missing" | "sendoff" | "taken";

const SETUP_SCRIPT = path.join("apps", "app", "scripts", "setup.ts");
const SHELL_SAFE = /^[\w./-]+$/u;

const manifestSchema = z.object({ name: z.string() });

const isSendoffCheckout = (dir: string): boolean => {
  if (!existsSync(path.join(dir, SETUP_SCRIPT))) {
    return false;
  }

  const manifestFile = path.join(dir, "package.json");

  if (!existsSync(manifestFile)) {
    return false;
  }

  const manifest = parseJsonWith(
    manifestSchema,
    readFileSync(manifestFile, "utf-8")
  );

  return manifest.data?.name === "sendoff";
};

export const inspectTarget = (dir: string): Target => {
  if (!existsSync(dir)) {
    return "missing";
  }

  if (!statSync(dir).isDirectory()) {
    return "taken";
  }

  if (readdirSync(dir).length === 0) {
    return "empty";
  }

  return isSendoffCheckout(dir) ? "sendoff" : "taken";
};

/**
 * Quote for the shell the command gets pasted into: cmd and Windows
 * PowerShell take double quotes (and Windows paths can't contain one), while
 * POSIX shells keep single-quoted text literal.
 */
const quote = (value: string, platform: NodeJS.Platform) => {
  if (SHELL_SAFE.test(value)) {
    return value;
  }

  return platform === "win32"
    ? `"${value}"`
    : `'${value.replaceAll("'", String.raw`'\''`)}'`;
};

/** How to show `dir` to someone standing in `from`, like `./sendoff`. */
export const displayPath = (from: string, dir: string): string => {
  const relative = path.relative(from, dir);

  if (relative === "") {
    return ".";
  }

  // On Windows, a folder on another drive comes back absolute (D:\news).
  const outside =
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`);

  return outside ? dir : `./${relative}`;
};

/**
 * The command to run one of Sendoff's scripts in `dir`, for someone standing
 * in `from`. `--cwd` instead of `cd … &&`, which Windows PowerShell 5.1 can't
 * run, so it works in any shell.
 */
export const bunRunIn = (
  from: string,
  dir: string,
  script: string,
  platform: NodeJS.Platform = process.platform
): string => {
  const relative = path.relative(from, dir);

  return relative === ""
    ? `bun run ${script}`
    : `bun run --cwd ${quote(relative, platform)} ${script}`;
};
