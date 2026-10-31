import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";

import { createSes, getConfig } from "../config";
import type { Config } from "../config";
import { createDb } from "../db/client";
import type { Database } from "../db/client";
import { issues } from "../db/schema";
import { renderConfirmationEmail } from "../email/confirmation";
import { messagePage, subscribePage } from "../pages";
import { getSettings } from "../settings";
import type { Settings } from "../settings";
import {
  confirmSubscriber,
  findSubscriberById,
  isValidEmail,
  markConfirmationSent,
  normalizeEmail,
  resubscribeSubscriber,
  subscribe,
  unsubscribeSubscriber,
} from "../subscribers";
import { createToken, verifyToken } from "../tokens";
import { verifyTurnstile } from "../turnstile";

type AppContext = Context<{ Bindings: Env }>;

const HTTP_BAD_REQUEST = 400;
const HTTP_NOT_FOUND = 404;
const HTTP_SERVER_ERROR = 500;
const HTTP_UNAVAILABLE = 503;

const signupSchema = z.object({
  "cf-turnstile-response": z.string().default(""),
  email: z.string().default(""),
  // Honeypot: hidden from people, filled in by naive bots.
  website: z.string().default(""),
});

interface Loaded {
  config: Config;
  db: Database;
  settings: Settings;
}

const load = async (c: AppContext): Promise<Loaded | Response> => {
  const config = getConfig(c.env);
  const db = createDb(c.env.DB);
  const settings = await getSettings(db);

  if (!settings) {
    return c.text("This newsletter isn't set up yet.", HTTP_UNAVAILABLE);
  }

  return { config, db, settings };
};

const invalidLink = (c: AppContext, settings: Settings) =>
  c.html(
    messagePage({
      body: "It may be out of date. If you're trying to subscribe, you can sign up again.",
      link: { href: "/", label: "Go to the signup page" },
      settings,
      title: "This link isn't valid",
    }),
    HTTP_NOT_FOUND
  );

/** Links from an issue carry `?issue=` so unsubscribes can be attributed. */
const knownIssueId = async (
  db: Database,
  issueId: string | undefined
): Promise<string | undefined> => {
  if (!issueId) {
    return undefined;
  }

  const issue = await db.query.issues.findFirst({
    columns: { id: true },
    where: eq(issues.id, issueId),
  });

  return issue?.id;
};

const sendConfirmation = async (
  { config, settings }: Loaded,
  subscriber: { email: string; id: string }
): Promise<void> => {
  const token = await createToken(config.tokenSecret, "confirm", subscriber.id);

  const email = await renderConfirmationEmail(
    settings,
    `${config.publicUrl}/confirm/${token}`
  );

  await createSes(config).sendEmail({
    configurationSet: config.sesConfigurationSet,
    from: settings.from,
    html: email.html,
    replyTo: settings.replyTo,
    subject: email.subject,
    tags: { type: "confirmation" },
    text: email.text,
    to: subscriber.email,
  });
};

export const publicRoutes = new Hono<{ Bindings: Env }>();

publicRoutes.get("/", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  return c.html(
    subscribePage({
      settings: loaded.settings,
      siteKey: loaded.config.turnstileSiteKey,
    })
  );
});

publicRoutes.post("/subscribe", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  const { config, db, settings } = loaded;
  const form = signupSchema.parse(await c.req.parseBody());

  if (form.website !== "") {
    return c.redirect("/check-inbox", 303);
  }

  const email = normalizeEmail(form.email);

  const retry = (error: string) =>
    c.html(
      subscribePage({
        email: form.email,
        error,
        settings,
        siteKey: config.turnstileSiteKey,
      }),
      HTTP_BAD_REQUEST
    );

  if (!isValidEmail(email)) {
    return retry("Enter a valid email address.");
  }

  const human = await verifyTurnstile(
    config.turnstileSecretKey,
    form["cf-turnstile-response"],
    c.req.header("cf-connecting-ip")
  );

  if (!human) {
    return retry("We couldn't verify the signup. Please try again.");
  }

  const { outcome, subscriber } = await subscribe(db, {
    email,
    source: "form",
  });

  if (outcome === "send_confirmation") {
    try {
      await sendConfirmation(loaded, subscriber);
      await markConfirmationSent(db, subscriber.id);
    } catch (error) {
      console.error("Failed to send confirmation email", error);

      return c.html(
        messagePage({
          body: "We couldn't send the confirmation email. Please try again in a few minutes.",
          link: { href: "/", label: "Back to the signup page" },
          settings,
          title: "Something went wrong",
        }),
        HTTP_SERVER_ERROR
      );
    }
  }

  // Same response for every outcome, so the form can't reveal who's subscribed.
  return c.redirect("/check-inbox", 303);
});

publicRoutes.get("/check-inbox", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  return c.html(
    messagePage({
      body: "We sent you a link to confirm your subscription. It can take a minute to arrive, so check your spam folder if you don't see it.",
      settings: loaded.settings,
      title: "Check your inbox",
    })
  );
});

publicRoutes.get("/confirm/:token", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  const { config, db, settings } = loaded;

  const id = await verifyToken(
    config.tokenSecret,
    "confirm",
    c.req.param("token")
  );

  const outcome = id ? await confirmSubscriber(db, id) : "not_pending";

  if (outcome === "not_pending") {
    return invalidLink(c, settings);
  }

  return c.html(
    messagePage({
      body: `You'll get the next issue of ${settings.name} when it goes out.`,
      settings,
      title:
        outcome === "confirmed"
          ? "You're subscribed"
          : "You're already subscribed",
    })
  );
});

const unsubscribeAction = (token: string, issueId: string | undefined) =>
  `/unsubscribe/${token}${issueId ? `?issue=${encodeURIComponent(issueId)}` : ""}`;

const unsubscribedPage = (settings: Settings, token: string) =>
  messagePage({
    action: {
      action: `/resubscribe/${token}`,
      label: "Resubscribe",
      secondary: true,
    },
    body: `You won't get any more emails from ${settings.name}. Unsubscribed by mistake?`,
    settings,
    title: "You're unsubscribed",
  });

// Opening the link only asks: link scanners and prefetchers load URLs in
// emails, and that alone mustn't unsubscribe anyone.
publicRoutes.get("/unsubscribe/:token", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  const { config, db, settings } = loaded;
  const token = c.req.param("token");
  const id = await verifyToken(config.tokenSecret, "unsubscribe", token);
  const subscriber = id ? await findSubscriberById(db, id) : undefined;

  if (!subscriber) {
    return invalidLink(c, settings);
  }

  if (subscriber.status !== "active" && subscriber.status !== "pending") {
    return c.html(unsubscribedPage(settings, token));
  }

  return c.html(
    messagePage({
      action: {
        action: unsubscribeAction(token, c.req.query("issue")),
        label: "Unsubscribe",
      },
      body: `${subscriber.email} will stop getting emails from ${settings.name}.`,
      settings,
      title: "Unsubscribe?",
    })
  );
});

// Handles both the button above and RFC 8058 one-click unsubscribe, where the
// mail provider POSTs `List-Unsubscribe=One-Click` to this URL.
publicRoutes.post("/unsubscribe/:token", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  const { config, db, settings } = loaded;
  const token = c.req.param("token");
  const id = await verifyToken(config.tokenSecret, "unsubscribe", token);

  const subscriber = id
    ? await unsubscribeSubscriber(db, id, {
        issueId: await knownIssueId(db, c.req.query("issue")),
      })
    : undefined;

  if (!subscriber) {
    return invalidLink(c, settings);
  }

  return c.html(unsubscribedPage(settings, token));
});

publicRoutes.post("/resubscribe/:token", async (c) => {
  const loaded = await load(c);

  if (loaded instanceof Response) {
    return loaded;
  }

  const { config, db, settings } = loaded;

  const id = await verifyToken(
    config.tokenSecret,
    "unsubscribe",
    c.req.param("token")
  );

  const subscriber = id ? await findSubscriberById(db, id) : undefined;

  if (!subscriber) {
    return invalidLink(c, settings);
  }

  await resubscribeSubscriber(db, subscriber.id);

  return c.html(
    messagePage({
      body: `You'll keep getting ${settings.name}.`,
      settings,
      title: "You're back on the list",
    })
  );
});
