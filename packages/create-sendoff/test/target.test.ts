import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commandIn, displayPath, inspectTarget } from "../src/target";

let root = "";

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "create-sendoff-"));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

const checkout = (dir: string, name: string) => {
  mkdirSync(path.join(dir, "apps", "app", "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "apps", "app", "scripts", "setup.ts"), "");
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name }));
};

describe("inspectTarget", () => {
  it("is missing when nothing is there", () => {
    expect(inspectTarget(path.join(root, "sendoff"))).toBe("missing");
  });

  it("is empty for an empty folder", () => {
    expect(inspectTarget(root)).toBe("empty");
  });

  it("recognizes an earlier clone, so setup can resume", () => {
    checkout(root, "sendoff");
    expect(inspectTarget(root)).toBe("sendoff");
  });

  it("is taken by anything else", () => {
    checkout(root, "something-else");
    expect(inspectTarget(root)).toBe("taken");

    const file = path.join(root, "notes.txt");

    writeFileSync(file, "");
    expect(inspectTarget(file)).toBe("taken");
  });
});

describe("paths shown to people", () => {
  it("shows folders relative to where they are", () => {
    expect(displayPath("/home/me", "/home/me/sendoff")).toBe("./sendoff");
    expect(displayPath("/home/me", "/home/me")).toBe(".");
    expect(displayPath("/home/me", "/srv/sendoff")).toBe("/srv/sendoff");
  });

  it("prefixes commands with the cd to get there", () => {
    expect(commandIn("/home/me", "/home/me/sendoff", "bun run setup")).toBe(
      "cd sendoff && bun run setup"
    );
    expect(commandIn("/home/me", "/home/me", "bun run setup")).toBe(
      "bun run setup"
    );
    expect(commandIn("/home/me", "/home/me/my news", "bun run setup")).toBe(
      "cd 'my news' && bun run setup"
    );
  });
});
