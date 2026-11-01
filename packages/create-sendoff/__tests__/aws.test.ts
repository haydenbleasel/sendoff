import { describe, expect, it } from "bun:test";

import { awsLogin } from "../src/aws";
import type { RunResult } from "../src/run";

const ARN = "arn:aws:iam::123456789012:user/hayden";

/** A stand-in for running `aws sts get-caller-identity`. */
const answers =
  (result: Partial<RunResult>) =>
  (command: string, args: string[]): Promise<RunResult> => {
    expect([command, ...args]).toStrictEqual([
      "aws",
      "sts",
      "get-caller-identity",
      "--output",
      "json",
    ]);

    return Promise.resolve({
      missing: false,
      ok: true,
      output: "",
      stdout: "",
      ...result,
    });
  };

describe("awsLogin", () => {
  it("is logged in when the CLI returns an identity", async () => {
    const stdout = JSON.stringify({ Arn: ARN });

    expect(await awsLogin(answers({ stdout }))).toStrictEqual({
      arn: ARN,
      status: "logged-in",
    });
  });

  it("is missing when the CLI isn't installed", async () => {
    expect(await awsLogin(answers({ missing: true, ok: false }))).toStrictEqual(
      { status: "missing" }
    );
  });

  it("is logged out when the CLI fails or answers with something else", async () => {
    const failed = answers({
      ok: false,
      stdout: JSON.stringify({ Arn: ARN }),
    });

    expect(await awsLogin(failed)).toStrictEqual({ status: "logged-out" });
    expect(await awsLogin(answers({ stdout: "not json" }))).toStrictEqual({
      status: "logged-out",
    });
  });
});
