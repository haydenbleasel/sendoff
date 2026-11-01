import { describe, expect, it } from "bun:test";

import { callerArn } from "../src/aws";
import { DEFAULT_FOLDER, DEFAULT_REPO, parseCommand } from "../src/cli";

describe("parseCommand", () => {
  it("defaults to ./sendoff from the upstream repo", () => {
    expect(parseCommand([])).toEqual({
      folder: DEFAULT_FOLDER,
      kind: "create",
      repo: DEFAULT_REPO,
    });
  });

  it("takes a folder and a fork", () => {
    expect(
      parseCommand(["my-news", "--repo", "https://github.com/me/sendoff.git"])
    ).toEqual({
      folder: "my-news",
      kind: "create",
      repo: "https://github.com/me/sendoff.git",
    });
  });

  it("shows help", () => {
    expect(parseCommand(["--help"])).toEqual({ kind: "help" });
    expect(parseCommand(["-h", "my-news"])).toEqual({ kind: "help" });
  });

  it("rejects unknown options and extra folders", () => {
    expect(() => parseCommand(["--yes"])).toThrow("--yes");
    expect(() => parseCommand(["one", "two"])).toThrow("Expected one folder");
  });
});

describe("callerArn", () => {
  it("reads the ARN from get-caller-identity", () => {
    const stdout = JSON.stringify({
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/hayden",
      UserId: "AIDAEXAMPLE",
    });

    expect(callerArn(stdout)).toBe("arn:aws:iam::123456789012:user/hayden");
  });

  it("ignores anything else", () => {
    expect(callerArn("")).toBeUndefined();
    expect(callerArn("Unable to locate credentials")).toBeUndefined();
    expect(callerArn(JSON.stringify({ Account: "123" }))).toBeUndefined();
  });
});
