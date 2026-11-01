import { z } from "zod";

import type { JsonObject } from "../../src/json";

// Your deployment's account and resource ids. They live in the gitignored
// .sendoff/ folder so the repo itself stays generic; deploys generate a
// full Wrangler config from the base wrangler.jsonc plus these values.

export const instanceSchema = z.object({
  accountId: z.string(),
  /** The Worker's AWS access key ID (not secret), when setup created it, so re-runs can reuse it. */
  awsAccessKeyId: z.string().optional(),
  databaseId: z.string(),
  databaseName: z.string().default("sendoff"),
  /** Custom domain (e.g. news.example.com). Without one, the Worker uses workers.dev. */
  hostname: z.string().optional(),
  /** KV namespace for OAuth grants and tokens (claude.ai and Claude Desktop connectors). */
  kvNamespaceId: z.string(),
  /** Setup's answers about the newsletter, so re-runs can pre-fill them. */
  newsletter: z
    .object({
      address: z.string().optional(),
      fromEmail: z.string(),
      fromName: z.string(),
      name: z.string(),
      replyTo: z.string().optional(),
      website: z.string(),
    })
    .optional(),
  publicUrl: z.url(),
  queueName: z.string().default("sendoff-send"),
  sesConfigurationSet: z.string().default("sendoff"),
  sesEventsTopicArn: z.string(),
  sesRegion: z.string(),
  turnstileSiteKey: z.string(),
  workerName: z.string().default("sendoff"),
});

export type Instance = z.output<typeof instanceSchema>;

export type BaseConfig = JsonObject & { vars?: Record<string, string> };

/** The base config with this instance's ids, written to .sendoff/wrangler.jsonc. */
export const deployConfig = (
  base: BaseConfig,
  instance: Instance
): BaseConfig => {
  const { $schema: _schema, ...rest } = base;

  return {
    ...rest,
    d1_databases: [
      {
        binding: "DB",
        database_id: instance.databaseId,
        database_name: instance.databaseName,
        migrations_dir: "../migrations",
      },
    ],
    kv_namespaces: [{ binding: "OAUTH_KV", id: instance.kvNamespaceId }],
    main: "../src/index.ts",
    name: instance.workerName,
    queues: {
      consumers: [
        {
          max_batch_size: 1,
          max_concurrency: 1,
          max_retries: 3,
          queue: instance.queueName,
        },
      ],
      producers: [{ binding: "SEND_QUEUE", queue: instance.queueName }],
    },
    routes: instance.hostname
      ? [{ custom_domain: true, pattern: instance.hostname }]
      : [],
    vars: {
      ...base.vars,
      PUBLIC_URL: instance.publicUrl,
      SES_CONFIGURATION_SET: instance.sesConfigurationSet,
      SES_EVENTS_TOPIC_ARN: instance.sesEventsTopicArn,
      SES_REGION: instance.sesRegion,
      TURNSTILE_SITE_KEY: instance.turnstileSiteKey,
    },
    workers_dev: instance.hostname === undefined,
  };
};
