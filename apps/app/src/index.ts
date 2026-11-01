import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { isAdminToken } from "./admin";
import { getConfig } from "./config";
import { createDb } from "./db/client";
import { renderIssue } from "./email/render";
import { sampleIssue, sampleSettings } from "./email/sample";
import { apiRoutes } from "./routes/api";
import { authorizeRoutes } from "./routes/authorize";
import { handleMcp } from "./routes/mcp";
import { previewRoutes } from "./routes/preview";
import { publicRoutes } from "./routes/public";
import { trackingRoutes } from "./routes/tracking";
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

app.route("/", apiRoutes);

// Before the page headers: email clients load the open image from other
// origins, and redirects shouldn't change the referrer.
app.route("/", trackingRoutes);

// Pages people visit: lock down framing and referrers (URLs carry tokens),
// and don't cache anything personal.
app.use("*", secureHeaders());

app.use("*", async (c, next) => {
  // oxlint-disable-next-line node/callback-return -- the header goes on after the handler
  await next();
  // After the handler, so it also covers Responses a handler built itself.
  // Setting a header copies a finished Response first, which also makes an
  // immutable one (Response.redirect) writable for secureHeaders.
  c.header("Cache-Control", "no-store");
});

app.route("/", authorizeRoutes);

app.route("/", previewRoutes);

app.route("/", publicRoutes);

const sendDeps = (env: Env): SendDeps => ({
  config: getConfig(env),
  db: createDb(env.DB),
  queue: env.SEND_QUEUE,
});

const RETRY_DELAY_SECONDS = 30;
const NEWSLETTER_SCOPE = "newsletter";
const PURGE_CRON = "0 3 * * *";

// OAuth 2.1 for claude.ai and Claude Desktop connectors (MCP authorization
// 2026-07-28: protected resource metadata, client ID metadata documents,
// PKCE, resource-bound tokens). It wraps the whole Worker: /mcp is the
// protected resource; everything else passes through to the Hono app.
const providers = new Map<string, OAuthProvider<Env>>();

const providerFor = (env: Env): OAuthProvider<Env> => {
  const { publicUrl } = getConfig(env);
  const resource = `${publicUrl}/mcp`;
  let provider = providers.get(publicUrl);

  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiHandler: {
        fetch: (request, handlerEnv) => handleMcp(request, handlerEnv),
      },
      apiRoute: "/mcp",
      authorizeEndpoint: "/authorize",
      clientIdMetadataDocumentEnabled: true,
      // Dynamic registration is deprecated in MCP, but older clients still use it.
      clientRegistrationEndpoint: "/oauth/register",
      defaultHandler: { fetch: app.fetch },
      requiredScopes: [NEWSLETTER_SCOPE],
      // The static MCP_TOKEN (Claude Code, Codex): this server's own credential,
      // checked after the provider's own token lookup fails.
      resolveExternalToken: async ({ env: tokenEnv, token }) =>
        (await isAdminToken(getConfig(tokenEnv), token))
          ? { audience: resource, props: { owner: true } }
          : null,
      resourceMetadata: {
        authorization_servers: [publicUrl],
        resource,
        resource_name: "Sendoff",
      },
      scopesSupported: [NEWSLETTER_SCOPE, "offline_access"],
      tokenEndpoint: "/oauth/token",
    });
    providers.set(publicUrl, provider);
  }

  return provider;
};

export default {
  fetch: (request, env, ctx) => providerFor(env).fetch(request, env, ctx),

  // One message = one chunk of recipients. processSendChunk records every
  // outcome itself, and a retry never reclaims rows an earlier attempt
  // claimed, so retrying after a throw can't send anyone the issue twice.
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
        console.error("Send chunk failed; retrying", error);
        message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
      }
    }
  },

  scheduled(controller, env, ctx) {
    if (controller.cron === PURGE_CRON) {
      ctx.waitUntil(providerFor(env).purgeExpiredData(env));

      return;
    }

    const restartStalled = async () => {
      const restarted = await resumeStalledSends(sendDeps(env));

      if (restarted.length > 0) {
        console.warn("Restarted stalled sends", restarted);
      }
    };

    ctx.waitUntil(restartStalled());
  },
} satisfies ExportedHandler<Env>;
