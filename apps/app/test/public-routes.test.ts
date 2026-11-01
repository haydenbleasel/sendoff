import { env, exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { events } from "../src/db/schema";
import { findSubscriberByEmail, importSubscribers } from "../src/subscribers";
import { createToken } from "../src/tokens";
import { BASE_URL, db, mockNetwork, setupSettings, statusOf } from "./helpers";

let network: ReturnType<typeof mockNetwork>;

beforeAll(setupSettings);

beforeEach(() => {
  network = mockNetwork();
});

afterEach(() => network.restore());

const request = (path: string, init?: RequestInit) =>
  exports.default.fetch(
    new Request(`${BASE_URL}${path}`, { redirect: "manual", ...init })
  );

const signup = (fields: Record<string, string>) =>
  request("/subscribe", {
    body: new URLSearchParams({ "cf-turnstile-response": "ok", ...fields }),
    method: "POST",
  });

const unsubscribeToken = async (email: string) => {
  const subscriber = await findSubscriberByEmail(db(), email);

  return await createToken(
    env.TOKEN_SECRET,
    "unsubscribe",
    subscriber?.id ?? ""
  );
};

describe("signup", () => {
  it("renders the form with Turnstile and safe headers", async () => {
    const response = await request("/");
    const html = await response.text();

    expect(html).toContain('action="/subscribe"');
    expect(html).toContain('data-sitekey="test-site-key"');
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("sends a confirmation email whose link activates the subscriber", async () => {
    const response = await signup({ email: "Reader@Example.com" });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/check-inbox");
    expect(network.sent).toHaveLength(1);

    const [email] = network.sent;
    expect(email?.to).toBe("reader@example.com");
    expect(email?.subject).toBe("Confirm your subscription to Test Newsletter");

    const link = email?.text.match(
      /https:\/\/news\.example\.com(?<path>\/confirm\/\S+)/u
    )?.groups?.path;

    expect(link).toBeDefined();
    expect(email?.html).toContain(link);

    // Opening the link only asks, so a mail filter that opens it can't confirm.
    const opened = await request(link ?? "");
    expect(await opened.text()).toContain(`action="${link}"`);
    expect(await statusOf("reader@example.com")).toBe("pending");

    const confirmed = await request(link ?? "", { method: "POST" });
    expect(await confirmed.text()).toContain("You&#x27;re subscribed");
    expect(await statusOf("reader@example.com")).toBe("active");

    const again = await request(link ?? "");
    expect(await again.text()).toContain("You&#x27;re already subscribed");
  });

  it("responds the same way for existing subscribers without emailing them", async () => {
    await importSubscribers(db(), [
      { email: "already@example.com", status: "active" },
    ]);

    const response = await signup({ email: "already@example.com" });

    expect(response.headers.get("location")).toBe("/check-inbox");
    expect(network.sent).toHaveLength(0);
  });

  it("rejects invalid emails, failed Turnstile checks and bots", async () => {
    const invalid = await signup({ email: "nope" });

    const robot = await signup({
      "cf-turnstile-response": "fail",
      email: "bot@example.com",
    });

    const honeypot = await signup({
      email: "trap@example.com",
      website: "spam.biz",
    });

    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toContain("Enter a valid email address.");
    expect(robot.status).toBe(400);
    expect(honeypot.status).toBe(303);
    expect(network.sent).toHaveLength(0);
    expect(
      await findSubscriberByEmail(db(), "trap@example.com")
    ).toBeUndefined();
  });

  it("shows an error when SES fails, so the person can retry", async () => {
    network.restore();
    const failing = mockNetwork();
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) =>
      new Request(input, init).url.includes("outbound-emails")
        ? Promise.resolve(Response.json({ message: "Paused" }, { status: 400 }))
        : original(input, init);

    const response = await signup({ email: "ses-down@example.com" });

    globalThis.fetch = original;
    failing.restore();
    expect(response.status).toBe(500);
    expect(await response.text()).toContain("couldn");
  });

  it("rejects confirm links that are forged", async () => {
    const opened = await request("/confirm/not-a-real-token");

    const posted = await request("/confirm/not-a-real-token", {
      method: "POST",
    });

    expect(opened.status).toBe(404);
    expect(posted.status).toBe(404);
  });
});

describe("unsubscribe", () => {
  it("only asks on GET, so link scanners can't unsubscribe anyone", async () => {
    await importSubscribers(db(), [
      { email: "scanned@example.com", status: "active" },
    ]);
    const token = await unsubscribeToken("scanned@example.com");

    const page = await request(`/unsubscribe/${token}`);

    expect(await page.text()).toContain(`action="/unsubscribe/${token}"`);
    expect(await statusOf("scanned@example.com")).toBe("active");
  });

  it("handles RFC 8058 one-click POSTs and resubscribing", async () => {
    await importSubscribers(db(), [
      { email: "oneclick@example.com", status: "active" },
    ]);
    const token = await unsubscribeToken("oneclick@example.com");

    const response = await request(
      `/unsubscribe/${token}?issue=unknown-issue`,
      {
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        method: "POST",
      }
    );

    expect(response.status).toBe(200);

    const subscriber = await findSubscriberByEmail(
      db(),
      "oneclick@example.com"
    );

    expect(subscriber?.status).toBe("unsubscribed");

    // Unknown issue ids are dropped rather than breaking the foreign key.
    const [recorded] = await db()
      .select()
      .from(events)
      .where(eq(events.subscriberId, subscriber?.id ?? ""));

    expect(recorded).toMatchObject({ issueId: null, type: "unsubscribe" });

    const back = await request(`/resubscribe/${token}`, { method: "POST" });

    expect(await back.text()).toContain("You&#x27;re back on the list");
    expect(await statusOf("oneclick@example.com")).toBe("active");
  });

  it("rejects forged unsubscribe tokens", async () => {
    const response = await request("/unsubscribe/forged.token", {
      method: "POST",
    });

    expect(response.status).toBe(404);
  });

  it("doesn't offer, or claim, a resubscribe for an address that bounced", async () => {
    await importSubscribers(db(), [
      { email: "bounced@example.com", status: "bounced" },
    ]);
    const token = await unsubscribeToken("bounced@example.com");

    const page = await request(`/unsubscribe/${token}`);
    expect(await page.text()).not.toContain("/resubscribe/");

    const back = await request(`/resubscribe/${token}`, { method: "POST" });
    expect(await back.text()).toContain("Can&#x27;t resubscribe");
    expect(await statusOf("bounced@example.com")).toBe("bounced");
  });

  it("asks a pending signup to confirm instead of resubscribing it", async () => {
    await signup({ email: "pending@example.com" });
    const token = await unsubscribeToken("pending@example.com");

    const back = await request(`/resubscribe/${token}`, { method: "POST" });
    const html = await back.text();

    expect(html).toContain("Confirm your subscription");
    expect(html).not.toContain("bounced");
    expect(await statusOf("pending@example.com")).toBe("pending");
  });
});
