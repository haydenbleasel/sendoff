import {
  readInstance,
  withSecretsFile,
  writeDeployConfig,
  writePagesProject,
} from "./files";
import { PAGES_BRANCH } from "./pages";
import { wrangler } from "./wrangler";

const WORKERS_DEV_URL = /https:\/\/[\w.-]+\.workers\.dev/u;

export interface DeployResult {
  output: string;
  /** The workers.dev URL Wrangler printed, if the Worker has one. */
  workersDevUrl: string | undefined;
}

export type SecretName =
  | "AWS_ACCESS_KEY_ID"
  | "AWS_SECRET_ACCESS_KEY"
  | "MCP_TOKEN"
  | "TOKEN_SECRET"
  | "TURNSTILE_SECRET_KEY";

export type Secrets = Partial<Record<SecretName, string>>;

/**
 * Apply D1 migrations and deploy the Worker using the instance config, then
 * the Pages project in front of it, if it has one. Secrets are uploaded with
 * the version; omitted ones are left as they are.
 */
export const deploy = (secrets: Secrets = {}): DeployResult => {
  const instance = readInstance();
  const config = writeDeployConfig(instance);

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

  let { output } = result;

  // Its service binding needs the Worker to exist, so it always goes second.
  if (instance.pagesProject) {
    const pages = wrangler(
      [
        "pages",
        "deploy",
        "--cwd",
        writePagesProject(instance, instance.pagesProject),
        "--branch",
        PAGES_BRANCH,
        "--commit-dirty",
      ],
      { accountId: instance.accountId }
    );

    if (!pages.ok) {
      throw new Error(`Deploying the Pages project failed:\n${pages.output}`);
    }

    output += pages.output;
  }

  return {
    output,
    workersDevUrl: WORKERS_DEV_URL.exec(result.output)?.[0],
  };
};
