import { readInstance, withSecretsFile, writeDeployConfig } from "./files";
import { wrangler } from "./wrangler";

const WORKERS_DEV_URL = /https:\/\/[\w.-]+\.workers\.dev/u;

export interface DeployResult {
  output: string;
  /** The workers.dev URL Wrangler printed, if the Worker has one. */
  workersDevUrl: string | undefined;
}

/**
 * Apply D1 migrations and deploy the Worker using the instance config.
 * Secrets are uploaded with the version; omitted ones are left as they are.
 */
export type SecretName =
  | "AWS_ACCESS_KEY_ID"
  | "AWS_SECRET_ACCESS_KEY"
  | "MCP_TOKEN"
  | "TOKEN_SECRET"
  | "TURNSTILE_SECRET_KEY";

export type Secrets = Partial<Record<SecretName, string>>;

export const deploy = (secrets: Secrets = {}): DeployResult => {
  const config = writeDeployConfig(readInstance());

  const migrations = wrangler(
    ["d1", "migrations", "apply", "DB", "--remote", "-c", config],
    {
      input: "y\n",
    }
  );

  if (!migrations.ok) {
    throw new Error(
      `Applying database migrations failed:\n${migrations.output}`
    );
  }

  const result =
    Object.keys(secrets).length > 0
      ? withSecretsFile(secrets, (file) =>
          wrangler(["deploy", "-c", config, "--secrets-file", file])
        )
      : wrangler(["deploy", "-c", config]);

  if (!result.ok) {
    throw new Error(`Deploy failed:\n${result.output}`);
  }

  return {
    output: result.output,
    workersDevUrl: WORKERS_DEV_URL.exec(result.output)?.[0],
  };
};
