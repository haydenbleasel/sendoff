import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { findApiKey, touchApiKey } from "../api-keys";
import type { ApiKey, ApiScope } from "../api-keys";
import { openApiDocument } from "../api/openapi";
import {
  createSubscriberBody,
  csvImportQuery,
  importIssuesBody,
} from "../api/schemas";
import type { ErrorCode } from "../api/schemas";
import { getConfig } from "../config";
import { sendConfirmationEmail } from "../confirmations";
import { createDb } from "../db/client";
import { MAX_CSV_BYTES, importCsv } from "../importers/csv";
import { MAX_ISSUE_IMPORT_BYTES, importIssue } from "../importers/issues";
import { IssueError } from "../issues";
import { parseJsonWith } from "../json";
import { getSettings } from "../settings";
import { markConfirmationSent, subscribe } from "../subscribers";

// The REST API, for servers (no CORS: keys must never be in browser code).
// It's a thin layer over the same functions the MCP tools use.

interface ApiEnv {
  Bindings: Env;
  Variables: { apiKey: ApiKey };
}

const HTTP_ACCEPTED = 202;
const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_TOO_LARGE = 413;
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const BEARER = /^Bearer\s+(?<token>.+)$/iu;

type ErrorStatus =
  | typeof HTTP_BAD_REQUEST
  | typeof HTTP_UNAUTHORIZED
  | typeof HTTP_FORBIDDEN
  | typeof HTTP_NOT_FOUND
  | typeof HTTP_TOO_LARGE
  | typeof HTTP_BAD_GATEWAY
  | typeof HTTP_UNAVAILABLE;

const apiError = (
  c: Context,
  status: ErrorStatus,
  code: ErrorCode,
  message: string
) =>
  c.json(
    { error: { code, message } },
    status,
    status === HTTP_UNAUTHORIZED
      ? { "WWW-Authenticate": 'Bearer realm="sendoff"' }
      : {}
  );

const requireScope = (scope: ApiScope) =>
  createMiddleware<ApiEnv>(async (c, next) => {
    const db = createDb(c.env.DB);

    const token =
      BEARER.exec(c.req.header("authorization") ?? "")?.groups?.token ?? "";

    const apiKey = token ? await findApiKey(db, token.trim()) : null;

    if (!apiKey) {
      return apiError(
        c,
        HTTP_UNAUTHORIZED,
        "invalid_api_key",
        "Send a valid API key as `Authorization: Bearer sendoff_…`."
      );
    }

    if (!apiKey.scopes.includes(scope)) {
      return apiError(
        c,
        HTTP_FORBIDDEN,
        "insufficient_scope",
        `This API key doesn't have the ${scope} scope.`
      );
    }

    await touchApiKey(db, apiKey.id);
    c.set("apiKey", apiKey);

    return next();
  });

export const apiRoutes = new Hono<ApiEnv>();

apiRoutes.get("/api/v1/openapi.json", (c) =>
  c.json(openApiDocument(getConfig(c.env).publicUrl))
);

apiRoutes.post(
  "/api/v1/subscribers",
  requireScope("subscribers:write"),
  async (c) => {
    const body = parseJsonWith(createSubscriberBody, await c.req.text());

    if (!body.success) {
      return apiError(
        c,
        HTTP_BAD_REQUEST,
        "invalid_request",
        z.prettifyError(body.error)
      );
    }

    const config = getConfig(c.env);
    const db = createDb(c.env.DB);
    const settings = await getSettings(db);

    if (!settings) {
      return apiError(
        c,
        HTTP_UNAVAILABLE,
        "not_configured",
        "The newsletter isn't set up yet."
      );
    }

    const { outcome, subscriber } = await subscribe(db, {
      email: body.data.email,
      name: body.data.name,
      source: "api",
    });

    if (outcome === "send_confirmation") {
      try {
        await sendConfirmationEmail(config, settings, subscriber);
        await markConfirmationSent(db, subscriber.id);
      } catch (error) {
        console.error("Failed to send confirmation email", error);

        return apiError(
          c,
          HTTP_BAD_GATEWAY,
          "confirmation_failed",
          "The confirmation email couldn't be sent. Try again in a few minutes."
        );
      }
    }

    return c.json({ status: "accepted" as const }, HTTP_ACCEPTED);
  }
);

const MULTIPART = "multipart/form-data";

/** The CSV as the raw body, or as a multipart field named `file`. */
const csvText = async (request: Request): Promise<string | null> => {
  if (!(request.headers.get("content-type") ?? "").startsWith(MULTIPART)) {
    return await request.text();
  }

  const form = await request.formData();
  const file = form.get("file");

  return file instanceof File ? await file.text() : file;
};

apiRoutes.post(
  "/api/v1/subscribers/import",
  requireScope("subscribers:import"),
  async (c) => {
    const tooLarge = () =>
      apiError(
        c,
        HTTP_TOO_LARGE,
        "too_large",
        `Import at most ${MAX_CSV_BYTES / 1024 / 1024} MB at a time: split the file and import each part.`
      );

    if (Number(c.req.header("content-length") ?? 0) > MAX_CSV_BYTES) {
      return tooLarge();
    }

    const query = csvImportQuery.safeParse(c.req.query());

    if (!query.success) {
      return apiError(
        c,
        HTTP_BAD_REQUEST,
        "invalid_request",
        z.prettifyError(query.error)
      );
    }

    const text = await csvText(c.req.raw);

    if (text === null) {
      return apiError(
        c,
        HTTP_BAD_REQUEST,
        "invalid_request",
        "Send the CSV as the request body (Content-Type: text/csv), or as a multipart field named file."
      );
    }

    if (text.length > MAX_CSV_BYTES) {
      return tooLarge();
    }

    try {
      return c.json(await importCsv(createDb(c.env.DB), text, query.data));
    } catch (error) {
      if (error instanceof IssueError) {
        return apiError(c, HTTP_BAD_REQUEST, "invalid_request", error.message);
      }

      throw error;
    }
  }
);

const BYTES_PER_MB = 1024 * 1024;

apiRoutes.post(
  "/api/v1/issues/import",
  requireScope("issues:import"),
  async (c) => {
    const tooLarge = () =>
      apiError(
        c,
        HTTP_TOO_LARGE,
        "too_large",
        `Send at most ${MAX_ISSUE_IMPORT_BYTES / BYTES_PER_MB} MB at a time: split the issues across requests.`
      );

    if (Number(c.req.header("content-length") ?? 0) > MAX_ISSUE_IMPORT_BYTES) {
      return tooLarge();
    }

    const text = await c.req.text();

    if (text.length > MAX_ISSUE_IMPORT_BYTES) {
      return tooLarge();
    }

    const body = parseJsonWith(importIssuesBody, text);

    if (!body.success) {
      return apiError(
        c,
        HTTP_BAD_REQUEST,
        "invalid_request",
        z.prettifyError(body.error)
      );
    }

    const db = createDb(c.env.DB);
    const results = [];

    // One at a time, so slugs made from the same subject stay unique.
    for (const input of body.data.issues) {
      const reported = {
        sentAt: input.sentAt.toISOString(),
        subject: input.subject,
      };

      try {
        // oxlint-disable-next-line no-await-in-loop -- see above
        const { issue, mergeTags, outcome } = await importIssue(db, input);

        results.push({
          ...reported,
          id: issue.id,
          mergeTags,
          outcome,
          slug: issue.slug,
        });
      } catch (error) {
        if (!(error instanceof IssueError)) {
          throw error;
        }

        results.push({
          ...reported,
          error: error.message,
          mergeTags: [],
          outcome: "failed" as const,
        });
      }
    }

    return c.json({ issues: results });
  }
);

apiRoutes.all("/api/v1/*", (c) =>
  apiError(
    c,
    HTTP_NOT_FOUND,
    "not_found",
    "No such endpoint. See /api/v1/openapi.json."
  )
);
