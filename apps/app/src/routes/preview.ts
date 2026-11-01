import { Hono } from "hono";
import type { Context } from "hono";

import { getConfig } from "../config";
import { createDb } from "../db/client";
import { renderIssue } from "../email/render";
import { sampleSettings } from "../email/sample";
import { findIssue } from "../issues";
import type { Issue } from "../issues";
import { previewPage } from "../preview-page";
import { getSettingsRecord } from "../settings";
import { verifyToken } from "../tokens";

const HTTP_NOT_FOUND = 404;
const HEAD_TAG = /<head\b[^>]*>/iu;

// Links in the preview open in a new tab instead of inside the iframe.
const BASE_TARGET = '<base target="_blank">';

const withBaseTarget = (html: string): string =>
  HEAD_TAG.test(html)
    ? html.replace(HEAD_TAG, (head) => `${head}${BASE_TARGET}`)
    : `${BASE_TARGET}${html}`;

type AppContext = Context<{ Bindings: Env }>;

/** Preview URLs are capability links: the token is the only access check. */
const loadIssue = async (c: AppContext): Promise<Issue | null> => {
  const config = getConfig(c.env);

  const id = await verifyToken(
    config.tokenSecret,
    "preview",
    c.req.param("token") ?? ""
  );

  return id ? ((await findIssue(createDb(c.env.DB), id)) ?? null) : null;
};

const notFound = (c: AppContext) =>
  c.text(
    "This preview link isn't valid. Ask your agent for a new one.",
    HTTP_NOT_FOUND
  );

export const previewRoutes = new Hono<{ Bindings: Env }>();

previewRoutes.get("/preview/:token", async (c) => {
  const issue = await loadIssue(c);

  if (!issue) {
    return notFound(c);
  }

  return c.html(
    previewPage({
      basePath: `/preview/${c.req.param("token")}`,
      subject: issue.subject,
    })
  );
});

// Cheap change detection: the issue's version plus when settings last changed.
previewRoutes.get("/preview/:token/state", async (c) => {
  const issue = await loadIssue(c);

  if (!issue) {
    return notFound(c);
  }

  const record = await getSettingsRecord(createDb(c.env.DB));

  return c.json({
    version: `${issue.version}:${record?.updatedAt.getTime() ?? 0}`,
  });
});

previewRoutes.get("/preview/:token/render", async (c) => {
  const issue = await loadIssue(c);

  if (!issue) {
    return notFound(c);
  }

  const record = await getSettingsRecord(createDb(c.env.DB));
  const settings = record?.settings ?? sampleSettings;

  // Imported issues show the HTML they were sent with. The frame is
  // sandboxed without scripts, so nothing in it can run.
  if (issue.importedAt) {
    return c.json({
      from: settings.from,
      html: withBaseTarget(issue.renderedHtml ?? ""),
      ok: true,
      preheader: issue.preheader,
      sampleSettings: false,
      status: "imported",
      subject: issue.subject,
      text: issue.renderedText ?? "",
      version: issue.version,
    });
  }

  const rendered = await renderIssue(
    {
      body: issue.body,
      preheader: issue.preheader ?? undefined,
      subject: issue.subject,
    },
    settings,
    "#unsubscribe"
  );

  const common = {
    from: settings.from,
    preheader: issue.preheader,
    sampleSettings: record === null,
    status: issue.status,
    subject: issue.subject,
    version: issue.version,
  };

  if (!rendered.ok) {
    return c.json({ ...common, ok: false, problems: rendered.problems });
  }

  return c.json({
    ...common,
    html: withBaseTarget(rendered.html),
    ok: true,
    text: rendered.text,
  });
});
