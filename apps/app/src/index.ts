import { Hono } from "hono";

import { createDb } from "./db/client";
import { renderIssue } from "./email/render";
import { sampleIssue, sampleSettings } from "./email/sample";
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

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
