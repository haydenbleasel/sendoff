import { Hono } from "hono";

import { getConfig } from "../config";
import { createDb } from "../db/client";
import { verifyLinkSignature, verifyToken } from "../tokens";
import { isWebUrl, recordClick, recordOpen } from "../tracking";

// Tracked links and the open image. Both answer straight away and record in
// the background, so tracking never slows a reader down. HEAD requests are
// link checkers, so they're answered but never counted.

const HTTP_FOUND = 302;
const HTTP_NOT_FOUND = 404;
const NO_STORE = "no-store, private";

/** A transparent 1×1 GIF. */
const PIXEL = Uint8Array.from(
  atob("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7"),
  (character) => character.codePointAt(0) ?? 0
);

export const trackingRoutes = new Hono<{ Bindings: Env }>();

const record = async (
  env: Env,
  token: string,
  save: (subscriberId: string) => Promise<boolean>
): Promise<void> => {
  const subscriberId = await verifyToken(
    getConfig(env).tokenSecret,
    "track",
    token
  );

  // Test sends and mangled links still work; they just aren't counted.
  if (!subscriberId) {
    return;
  }

  try {
    await save(subscriberId);
  } catch (error) {
    console.error("Couldn't record a tracking event", error);
  }
};

trackingRoutes.get("/click/:issueId/:token/:signature", async (c) => {
  const { issueId, signature, token } = c.req.param();
  const url = c.req.query("url") ?? "";

  const valid =
    isWebUrl(url) &&
    (await verifyLinkSignature(getConfig(c.env).tokenSecret, {
      issueId,
      signature,
      url,
    }));

  if (!valid) {
    return c.text("This link isn't valid.", HTTP_NOT_FOUND, {
      "Cache-Control": NO_STORE,
    });
  }

  if (c.req.method === "GET") {
    const at = new Date();
    const userAgent = c.req.header("user-agent");
    const db = createDb(c.env.DB);

    c.executionCtx.waitUntil(
      record(c.env, token, (subscriberId) =>
        recordClick(db, { at, issueId, subscriberId, url, userAgent })
      )
    );
  }

  c.header("Cache-Control", NO_STORE);

  return c.redirect(url, HTTP_FOUND);
});

trackingRoutes.get("/open/:issueId/:token", (c) => {
  const { issueId, token } = c.req.param();

  if (c.req.method === "GET") {
    const at = new Date();
    const userAgent = c.req.header("user-agent");
    const db = createDb(c.env.DB);

    c.executionCtx.waitUntil(
      record(c.env, token, (subscriberId) =>
        recordOpen(db, { at, issueId, subscriberId, userAgent })
      )
    );
  }

  return c.body(PIXEL, 200, {
    "Cache-Control": NO_STORE,
    "Content-Type": "image/gif",
  });
});
