import { z } from "zod";

import { createSesClient } from "./ses";
import type { SesClient } from "./ses";

const MIN_SECRET_LENGTH = 32;
const TRAILING_SLASHES = /\/+$/u;

const required = (name: string) =>
  z
    .string({ error: `${name} is not set. Run \`bun run setup\`.` })
    .min(1, `${name} is not set. Run \`bun run setup\`.`);

const configSchema = z.object({
  awsAccessKeyId: required("AWS_ACCESS_KEY_ID"),
  awsSecretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
  mcpToken: required("MCP_TOKEN").pipe(
    z
      .string()
      .min(
        MIN_SECRET_LENGTH,
        `MCP_TOKEN must be at least ${MIN_SECRET_LENGTH} characters.`
      )
  ),
  publicUrl: required("PUBLIC_URL")
    .pipe(z.url({ protocol: /^https?$/u }))
    .transform((url) => url.replace(TRAILING_SLASHES, "")),
  sesConfigurationSet: z.string().optional(),
  /** Empty until setup creates the SNS topic; the webhook rejects everything until then. */
  sesEventsTopicArn: z.string().optional(),
  sesRegion: required("SES_REGION"),
  tokenSecret: required("TOKEN_SECRET").pipe(
    z
      .string()
      .min(
        MIN_SECRET_LENGTH,
        `TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`
      )
  ),
  turnstileSecretKey: required("TURNSTILE_SECRET_KEY"),
  turnstileSiteKey: required("TURNSTILE_SITE_KEY"),
});

export type Config = z.output<typeof configSchema>;

const emptyToUndefined = (value: string | undefined) =>
  value === "" ? undefined : value;

/** Validated runtime configuration. Throws a readable error if setup is incomplete. */
export const getConfig = (env: Env): Config =>
  configSchema.parse({
    awsAccessKeyId: env.AWS_ACCESS_KEY_ID,
    awsSecretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    mcpToken: env.MCP_TOKEN,
    publicUrl: env.PUBLIC_URL,
    sesConfigurationSet: emptyToUndefined(env.SES_CONFIGURATION_SET),
    sesEventsTopicArn: emptyToUndefined(env.SES_EVENTS_TOPIC_ARN),
    sesRegion: env.SES_REGION,
    tokenSecret: env.TOKEN_SECRET,
    turnstileSecretKey: env.TURNSTILE_SECRET_KEY,
    turnstileSiteKey: env.TURNSTILE_SITE_KEY,
  });

export const createSes = (config: Config): SesClient =>
  createSesClient({
    accessKeyId: config.awsAccessKeyId,
    region: config.sesRegion,
    secretAccessKey: config.awsSecretAccessKey,
  });
