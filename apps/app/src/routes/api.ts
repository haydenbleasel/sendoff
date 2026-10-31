import { Hono } from "hono";
import type { Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";

import { findApiKey, touchApiKey } from "../api-keys";
import type { ApiKey, ApiScope } from "../api-keys";
import { openApiDocument } from "../api/openapi";
import { createSubscriberBody } from "../api/schemas";
import type { ErrorCode } from "../api/schemas";
import { getConfig } from "../config";
import { sendConfirmationEmail } from "../confirmations";
import { createDb } from "../db/client";
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
const HTTP_BAD_GATEWAY = 502;
const HTTP_UNAVAILABLE = 503;
const BEARER = /^Bearer\s+(?<token>.+)$/iu;

type ErrorStatus =
  | typeof HTTP_BAD_REQUEST
  | typeof HTTP_UNAUTHORIZED
  | typeof HTTP_FORBIDDEN
  | typeof HTTP_NOT_FOUND
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

apiRoutes.all("/api/v1/*", (c) =>
  apiError(
    c,
    HTTP_NOT_FOUND,
    "not_found",
    "No such endpoint. See /api/v1/openapi.json."
  )
);
