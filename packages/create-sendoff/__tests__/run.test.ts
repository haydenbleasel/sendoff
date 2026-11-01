import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { handOff, installed, run } from "../src/run";

// Real processes: Bun itself stands in for git and bun, so these run anywhere.
const BUN = process.execPath;
const MISSING = "sendoff-command-that-does-not-exist";

let dir = "";

beforeEach(() => {
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), "create-sendoff-run-")));
});

afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

describe("installed", () => {
  it("is true for a command that runs, and false otherwise", () => {
    expect(installed(BUN)).toBe(true);
    expect(installed(MISSING)).toBe(false);
  });
});

describe("run", () => {
  it("captures stdout, and both streams for showing on failure", async () => {
    const result = await run(BUN, [
      "-e",
      "console.log('out'); console.error('err')",
    ]);

    expect(result).toMatchObject({ missing: false, ok: true, stdout: "out\n" });
    expect(result.output).toContain("out");
    expect(result.output).toContain("err");
  });

  it("runs in a folder with extra environment variables", async () => {
    const result = await run(
      BUN,
      ["-e", "console.log(process.env.SENDOFF_TEST, process.cwd())"],
      { cwd: dir, env: { SENDOFF_TEST: "yes" } }
    );

    expect(result.stdout).toBe(`yes ${dir}\n`);
  });

  it("reports a failing command", async () => {
    const result = await run(BUN, ["-e", "process.exit(3)"]);

    expect(result).toMatchObject({ missing: false, ok: false });
  });

  it("reports a command that isn't installed", async () => {
    const result = await run(MISSING, []);

    expect(result).toMatchObject({ missing: true, ok: false, stdout: "" });
    // Node says "spawn … ENOENT", Bun "Executable not found"; both name it.
    expect(result.output).toContain(MISSING);
  });
});

describe("handOff", () => {
  it("resolves with the command's exit code", async () => {
    expect(await handOff(BUN, ["-e", "process.exit(3)"], dir)).toBe(3);
  });

  it("resolves with 1 when the command can't start", async () => {
    expect(await handOff(MISSING, [], dir)).toBe(1);
  });

  it("leaves Ctrl+C to the command while it runs", async () => {
    const before = process.listeners("SIGINT");
    const running = handOff(BUN, ["-e", "setTimeout(() => {}, 50)"], dir);

    const added = process
      .listeners("SIGINT")
      .filter((listener) => !before.includes(listener));

    expect(added).toHaveLength(1);

    // The listener only keeps this process alive; calling it does nothing else.
    for (const listener of added) {
      listener("SIGINT");
    }

    expect(await running).toBe(0);
    expect(process.listeners("SIGINT")).toStrictEqual(before);
  });
});
