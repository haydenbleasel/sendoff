import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";

import { createDb } from "./db/client";
import { renderIssue } from "./email/render";
import { sampleIssue, sampleSettings } from "./email/sample";
import { mcpRoutes } from "./routes/mcp";
import { previewRoutes } from "./routes/preview";
import { publicRoutes } from "./routes/public";
import { webhookRoutes } from "./routes/webhooks";
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

// Pages people visit: lock down framing and referrers (URLs carry tokens),
// and don't cache anything personal.
app.use("*", secureHeaders());

app.use("*", (c, next) => {
  c.header("Cache-Control", "no-store");

  return next();
});

app.route("/", previewRoutes);

app.route("/", publicRoutes);

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
