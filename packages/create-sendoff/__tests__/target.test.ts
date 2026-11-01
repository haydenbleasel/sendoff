import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bunRunIn, displayPath, inspectTarget } from "../src/target";

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

  it("is taken by a folder of something else", () => {
    writeFileSync(path.join(root, "notes.txt"), "");
    expect(inspectTarget(root)).toBe("taken");
  });

  it("is taken by a folder with the setup script but no package.json", () => {
    checkout(root, "sendoff");
    rmSync(path.join(root, "package.json"));
    expect(inspectTarget(root)).toBe("taken");
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
    expect(displayPath("/home/me/sendoff", "/home/me")).toBe("/home/me");
    // A name that starts with two dots is still inside.
    expect(displayPath("/home/me", "/home/me/..news")).toBe("./..news");
  });

  it("runs scripts in the folder with --cwd, which any shell can run", () => {
    expect(bunRunIn("/home/me", "/home/me/sendoff", "setup", "darwin")).toBe(
      "bun run --cwd sendoff setup"
    );
    expect(bunRunIn("/home/me", "/home/me", "setup", "darwin")).toBe(
      "bun run setup"
    );
    expect(bunRunIn("/home/me", "/home/me/my news", "setup", "darwin")).toBe(
      "bun run --cwd 'my news' setup"
    );
  });

  it("quotes for cmd and PowerShell on Windows", () => {
    expect(bunRunIn("/home/me", "/home/me/my news", "update", "win32")).toBe(
      'bun run --cwd "my news" update'
    );
  });
});
