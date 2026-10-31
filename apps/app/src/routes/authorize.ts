import {
  AuthorizationError,
  CimdFetchError,
} from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";

import {
  ADMIN_SESSION_COOKIE,
  createAdminSession,
  isAdminSession,
  isAdminToken,
} from "../admin";
import { getConfig } from "../config";
import { consentPage, messagePage, signInPage } from "../oauth-pages";

// The OAuth authorize step for claude.ai and Claude Desktop connectors. The
// provider (index.ts) validates the request and issues tokens; this page
// signs the owner in and asks for consent.

type AppContext = Context<{ Bindings: Env }>;

const HTTP_BAD_REQUEST = 400;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FOUND = 302;
const AUTHORIZE_PATH = "/authorize";

/** Grants are tied to this one owner. */
const OWNER = "owner";

const signInSchema = z.object({
  return_to: z.string().default(AUTHORIZE_PATH),
  token: z.string().default(""),
});

const consentSchema = z.object({
  decision: z.enum(["approve", "deny"]),
  handle: z.string().min(1),
});

const helpers = (c: AppContext): OAuthHelpers => {
  const api = c.env.OAUTH_PROVIDER;

  if (!api) {
    throw new Error("The OAuth provider isn't wrapping this request.");
  }

  return api;
};

/** Only ever send people back to the authorize page, never elsewhere. */
const safeReturnTo = (value: string): string =>
  value === AUTHORIZE_PATH || value.startsWith(`${AUTHORIZE_PATH}?`)
    ? value
    : AUTHORIZE_PATH;

const signedIn = async (c: AppContext): Promise<boolean> =>
  await isAdminSession(getConfig(c.env), getCookie(c, ADMIN_SESSION_COOKIE));

/** Errors the library says to redirect for, render locally, or let surface. */
const failure = (error: Error): Response => {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, HTTP_FOUND);
  }

  if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
    const message =
      error instanceof AuthorizationError
        ? error.description
        : "This app's details couldn't be verified.";

    return new Response(messagePage("This request can't continue", message), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
      status: HTTP_BAD_REQUEST,
    });
  }

  throw error;
};

export const authorizeRoutes = new Hono<{ Bindings: Env }>();

authorizeRoutes.get(AUTHORIZE_PATH, async (c) => {
  const url = new URL(c.req.url);

  if (!(await signedIn(c))) {
    return c.html(signInPage({ returnTo: `${url.pathname}${url.search}` }));
  }

  try {
    const api = helpers(c);
    const request = await api.parseAuthRequest(c.req.raw);
    const details = await api.describeConsent(request);
    const consent = await api.beginConsent(request);

    consent.headers.set("Content-Type", "text/html; charset=utf-8");

    return new Response(consentPage(details, consent.handle), {
      headers: consent.headers,
    });
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
});

authorizeRoutes.post(`${AUTHORIZE_PATH}/sign-in`, async (c) => {
  const config = getConfig(c.env);
  const form = signInSchema.parse(await c.req.parseBody());
  const returnTo = safeReturnTo(form.return_to);

  if (!(form.token && (await isAdminToken(config, form.token.trim())))) {
    return c.html(
      signInPage({ error: "That isn't the admin token.", returnTo }),
      HTTP_UNAUTHORIZED
    );
  }

  const session = await createAdminSession(config);

  setCookie(c, ADMIN_SESSION_COOKIE, session.value, {
    httpOnly: true,
    maxAge: session.maxAge,
    path: "/",
    sameSite: "Lax",
    secure: true,
  });

  return c.redirect(returnTo, 303);
});

authorizeRoutes.post(AUTHORIZE_PATH, async (c) => {
  if (!(await signedIn(c))) {
    return c.html(
      messagePage(
        "Your sign-in expired",
        "Start connecting again from your app."
      ),
      HTTP_UNAUTHORIZED
    );
  }

  const form = consentSchema.safeParse(await c.req.parseBody());

  if (!form.success) {
    return c.html(
      messagePage(
        "Something's missing",
        "Start connecting again from your app."
      ),
      HTTP_BAD_REQUEST
    );
  }

  try {
    const api = helpers(c);

    if (form.data.decision === "deny") {
      const denied = await api.denyConsent(c.req.raw, form.data.handle);

      denied.headers.set("Location", denied.redirectTo);

      return new Response(null, {
        headers: denied.headers,
        status: HTTP_FOUND,
      });
    }

    const approved = await api.approveConsent(c.req.raw, form.data.handle);

    const { redirectTo } = await api.completeAuthorization({
      metadata: {},
      props: { owner: true },
      request: approved.request,
      scope: approved.request.scope,
      userId: OWNER,
    });

    approved.headers.set("Location", redirectTo);

    return new Response(null, {
      headers: approved.headers,
      status: HTTP_FOUND,
    });
  } catch (error) {
    return failure(error instanceof Error ? error : new Error(String(error)));
  }
});
