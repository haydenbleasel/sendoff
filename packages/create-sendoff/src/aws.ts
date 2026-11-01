import { z } from "zod/mini";

import { parseJsonWith } from "./json";
import { run } from "./run";

/** Who the AWS CLI is logged in as, if it's installed and logged in. */
export type AwsLogin =
  | { arn: string; status: "logged-in" }
  | { status: "logged-out" }
  | { status: "missing" };

const identitySchema = z.object({ Arn: z.string() });

/** The `Arn` from `aws sts get-caller-identity` output. */
export const callerArn = (stdout: string): string | undefined =>
  parseJsonWith(identitySchema, stdout).data?.Arn;

/**
 * Setup uses the AWS CLI's login to create the SES resources and the Worker's
 * send-only key. Without one it asks for IAM keys made by hand.
 */
export const awsLogin = async (
  runCommand: typeof run = run
): Promise<AwsLogin> => {
  const result = await runCommand("aws", [
    "sts",
    "get-caller-identity",
    "--output",
    "json",
  ]);

  if (result.missing) {
    return { status: "missing" };
  }

  const arn = result.ok ? callerArn(result.stdout) : undefined;

  return arn === undefined
    ? { status: "logged-out" }
    : { arn, status: "logged-in" };
};
