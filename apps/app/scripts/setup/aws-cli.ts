import { spawnSync } from "node:child_process";

import { z } from "zod";

import type { AwsCredentials } from "./aws";

// Uses the AWS CLI's own login (SSO, `aws login`, or a profile) for setup, so
// people don't have to create IAM users and keys by hand. The Worker gets a
// separate send-only key.

export const RUNTIME_USER = "sendoff";
const RUNTIME_POLICY_NAME = "sendoff-send";

/** What the Worker's key may do: send, and the three reads `doctor` uses. */
export const RUNTIME_IAM_POLICY = {
  Statement: [
    {
      Action: [
        "ses:GetAccount",
        "ses:GetConfigurationSetEventDestinations",
        "ses:GetEmailIdentity",
        "ses:SendEmail",
      ],
      Effect: "Allow",
      Resource: "*",
      Sid: "SendoffSend",
    },
  ],
  Version: "2012-10-17",
};

const identitySchema = z.object({ Account: z.string(), Arn: z.string() });

const exportedSchema = z.object({
  AccessKeyId: z.string(),
  SecretAccessKey: z.string(),
  SessionToken: z.string().optional(),
});

const accessKeySchema = z.object({
  AccessKey: z.object({ AccessKeyId: z.string(), SecretAccessKey: z.string() }),
});

const keyListSchema = z.object({
  AccessKeyMetadata: z.array(z.object({ AccessKeyId: z.string() })),
});

export interface RuntimeKey {
  accessKeyId: string;
  secretAccessKey: string;
}

export class AwsCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsCliError";
  }
}

const aws = (args: string[]) => {
  const result = spawnSync("aws", [...args, "--output", "json"], {
    encoding: "utf-8",
    env: { ...process.env, AWS_PAGER: "" },
  });

  return {
    ok: result.status === 0,
    stderr: result.stderr ?? "",
    stdout: result.stdout ?? "",
  };
};

const awsJson = <T extends z.ZodType>(
  args: string[],
  schema: T
): z.output<T> => {
  const result = aws(args);

  if (!result.ok) {
    throw new AwsCliError(
      result.stderr.trim() || `aws ${args.join(" ")} failed`
    );
  }

  return schema.parse(JSON.parse(result.stdout));
};

/** Who the AWS CLI is logged in as, or null if it isn't installed or logged in. */
export const cliIdentity = (): z.output<typeof identitySchema> | null => {
  try {
    return awsJson(["sts", "get-caller-identity"], identitySchema);
  } catch {
    return null;
  }
};

/** The CLI's current (often short-lived) credentials, for signing setup's own requests. */
export const cliCredentials = (region: string): AwsCredentials | null => {
  try {
    const exported = awsJson(
      ["configure", "export-credentials", "--format", "process"],
      exportedSchema
    );

    return {
      accessKeyId: exported.AccessKeyId,
      region,
      secretAccessKey: exported.SecretAccessKey,
      sessionToken: exported.SessionToken,
    };
  } catch {
    return null;
  }
};

/** Create the `sendoff` IAM user if needed and (re)attach the send-only policy. */
export const ensureRuntimeUser = (): void => {
  if (!aws(["iam", "get-user", "--user-name", RUNTIME_USER]).ok) {
    awsJson(
      [
        "iam",
        "create-user",
        "--user-name",
        RUNTIME_USER,
        "--tags",
        "Key=app,Value=sendoff",
      ],
      z.object({})
    );
  }

  const put = aws([
    "iam",
    "put-user-policy",
    "--user-name",
    RUNTIME_USER,
    "--policy-name",
    RUNTIME_POLICY_NAME,
    "--policy-document",
    JSON.stringify(RUNTIME_IAM_POLICY),
  ]);

  if (!put.ok) {
    throw new AwsCliError(put.stderr.trim());
  }
};

export const runtimeKeyIds = (): string[] =>
  awsJson(
    ["iam", "list-access-keys", "--user-name", RUNTIME_USER],
    keyListSchema
  ).AccessKeyMetadata.map((key) => key.AccessKeyId);

export const createRuntimeKey = (): RuntimeKey => {
  const { AccessKey } = awsJson(
    ["iam", "create-access-key", "--user-name", RUNTIME_USER],
    accessKeySchema
  );

  return {
    accessKeyId: AccessKey.AccessKeyId,
    secretAccessKey: AccessKey.SecretAccessKey,
  };
};

/** Delete a key setup created earlier (and whose secret it no longer has). */
export const deleteRuntimeKey = (accessKeyId: string): void => {
  const result = aws([
    "iam",
    "delete-access-key",
    "--user-name",
    RUNTIME_USER,
    "--access-key-id",
    accessKeyId,
  ]);

  if (!result.ok) {
    throw new AwsCliError(result.stderr.trim());
  }
};
