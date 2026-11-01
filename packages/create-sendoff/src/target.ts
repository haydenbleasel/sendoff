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

const quote = (value: string) =>
  SHELL_SAFE.test(value)
    ? value
    : `'${value.replaceAll("'", String.raw`'\''`)}'`;

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

/** A shell command to run inside `dir`, prefixed with the `cd` to get there. */
export const commandIn = (
  from: string,
  dir: string,
  command: string
): string => {
  const relative = path.relative(from, dir);

  return relative === "" ? command : `cd ${quote(relative)} && ${command}`;
};
