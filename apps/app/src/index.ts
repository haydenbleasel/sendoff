import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { getConfig } from "./config";
import { createDb } from "./db/client";
import { renderIssue } from "./email/render";
import { sampleIssue, sampleSettings } from "./email/sample";
import { apiRoutes } from "./routes/api";
import { mcpRoutes } from "./routes/mcp";
import { previewRoutes } from "./routes/preview";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
import {
  processSendChunk,
  resumeStalledSends,
  sendMessageSchema,
} from "./sending";
import type { SendDeps } from "./sending";
import { getSettings } from "./settings";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ ok: true }));

// The template rendered with sample content and the saved settings (or
// sample settings before setup). Public: it contains nothing private.
app.get("/preview/sample", async (c) => {
  const settings = (await getSettings(createDb(c.env.DB))) ?? sampleSettings;
  const result = await renderIssue(sampleIssue, settings, "#unsubscribe");

  if (!result.ok) {
    return c.json({ problems: result.problems }, 500);
  }

  if (c.req.query("format") === "text") {
    return c.text(result.text);
  }

  return c.html(result.html);
});

app.route("/", webhookRoutes);

app.route("/", mcpRoutes);

app.route("/", apiRoutes);

// Pages people visit: lock down framing and referrers (URLs carry tokens),
// and don't cache anything personal.
app.use("*", secureHeaders());

app.use("*", (c, next) => {
  c.header("Cache-Control", "no-store");

  return next();
});

app.route("/", previewRoutes);

app.route("/", publicRoutes);

const sendDeps = (env: Env): SendDeps => ({
  config: getConfig(env),
  db: createDb(env.DB),
  queue: env.SEND_QUEUE,
});

const RETRY_DELAY_SECONDS = 30;

export default {
  fetch: app.fetch,

  // One message = one chunk of recipients. processSendChunk records every
  // outcome itself, so a throw here happened before anything was sent and
  // is safe to retry.
  async queue(batch, env) {
    const deps = sendDeps(env);

    for (const message of batch.messages) {
      const parsed = sendMessageSchema.safeParse(message.body);

      if (!parsed.success) {
        console.error("Dropping malformed send message", message.body);
        message.ack();
        continue;
      }

      try {
        // oxlint-disable-next-line no-await-in-loop -- batches hold a single message
        await processSendChunk(deps, parsed.data);
        message.ack();
      } catch (error) {
        console.error("Send chunk failed before sending; retrying", error);
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  },

  scheduled(_controller, env, ctx) {
    const restartStalled = async () => {
      const restarted = await resumeStalledSends(sendDeps(env));

      if (restarted.length > 0) {
        console.warn("Restarted stalled sends", restarted);
      }
    };

    ctx.waitUntil(restartStalled());
  },
} satisfies ExportedHandler<Env>;
