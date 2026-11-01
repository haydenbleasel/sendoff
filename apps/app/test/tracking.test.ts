import { env, exports } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { events, issues, sends, subscribers } from "../src/db/schema";
import {
  TRACKING_TOKEN_PLACEHOLDER,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from "../src/email/render";
import { createDraft } from "../src/issues";
import { findSubscriberByEmail, importSubscribers } from "../src/subscribers";
import { createLinkSignature, createToken } from "../src/tokens";
import {
  TEST_TRACKING_TOKEN,
  addTracking,
  agentKind,
  clickUrl,
  openUrl,
} from "../src/tracking";
import { BASE_URL, db } from "./helpers";

const SECRET = env.TOKEN_SECRET;
const POST = "https://example.com/post?a=1&b=2";

const BROWSER =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const HTML = `<html><body><a href="https://example.com/post?a=1&amp;b=2">Post</a> <a class="x" href="mailto:me@example.com">Mail</a> <a href="${BASE_URL}/">Subscribe</a> <a href="${UNSUBSCRIBE_URL_PLACEHOLDER}">Unsubscribe</a> <a href="https://example.com/post?a=1&amp;b=2">Again</a><!--/$--></body></html>`;

const OPTIONS = { issueId: "issue-1", publicUrl: BASE_URL, secret: SECRET };

describe("addTracking", () => {
  it("sends web links through the signed click redirect, leaving Sendoff's own links and mailto alone", async () => {
    const tracked = await addTracking(HTML, {
      ...OPTIONS,
      tracking: { clicks: true, opens: false },
    });

    const expected = clickUrl({
      issueId: "issue-1",
      publicUrl: BASE_URL,
      signature: await createLinkSignature(SECRET, "issue-1", POST),
      token: TRACKING_TOKEN_PLACEHOLDER,
      url: POST,
    });

    expect(tracked.split(`href="${expected}"`)).toHaveLength(3);
    expect(tracked).toContain('href="mailto:me@example.com"');
    expect(tracked).toContain(`href="${BASE_URL}/"`);
    expect(tracked).toContain(`href="${UNSUBSCRIBE_URL_PLACEHOLDER}"`);
    expect(tracked).not.toContain("<img");
  });

  it("adds the open image only when asked, and changes nothing with tracking off", async () => {
    const opens = await addTracking(HTML, {
      ...OPTIONS,
      tracking: { clicks: false, opens: true },
    });

    expect(opens).toContain(
      `<img alt="" height="1" src="${openUrl(BASE_URL, "issue-1", TRACKING_TOKEN_PLACEHOLDER)}"`
    );
    expect(opens.indexOf("<img")).toBeLessThan(opens.indexOf("</body>"));
    expect(opens).toContain('href="https://example.com/post?a=1&amp;b=2"');

    expect(
      await addTracking(HTML, {
        ...OPTIONS,
        tracking: { clicks: false, opens: false },
      })
    ).toBe(HTML);
  });
});

describe("agentKind", () => {
  it("tells people from Apple's image proxy and automated clients", () => {
    expect(agentKind(BROWSER)).toBe("browser");
    expect(agentKind("Mozilla/5.0")).toBe("apple");
    expect(agentKind("")).toBe("automated");
    expect(agentKind(undefined)).toBe("automated");
    expect(agentKind("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(
      "automated"
    );
    expect(agentKind("python-requests/2.32.3")).toBe("automated");
    expect(agentKind("Slackbot-LinkExpanding 1.0")).toBe("automated");
  });
});

describe("tracking routes", () => {
  let issueId = "";
  let subscriberId = "";
  let token = "";

  beforeEach(async () => {
    const database = db();

    await database.delete(events);
    await database.delete(sends);
    await database.delete(issues);
    await database.delete(subscribers);
    await importSubscribers(database, [
      { email: "reader@example.com", status: "active" },
    ]);

    const reader = await findSubscriberByEmail(database, "reader@example.com");
    subscriberId = reader?.id ?? "";

    const draft = await createDraft(database, {
      body: "Hi",
      subject: "Tracked",
    });

    const sentAt = new Date(Date.now() - 10 * 60_000);
    issueId = draft.id;

    await database
      .update(issues)
      .set({
        sendStartedAt: sentAt,
        sentAt,
        status: "sent",
        tracking: { clicks: true, opens: true },
      })
      .where(eq(issues.id, issueId));
    await database.insert(sends).values({
      issueId,
      messageId: "ses-1",
      sentAt,
      status: "sent",
      subscriberId,
    });

    token = await createToken(SECRET, "track", subscriberId);
  });

  const click = async (
    url: string,
    { agent = BROWSER, as = token, method = "GET" } = {}
  ) =>
    await exports.default.fetch(
      new Request(
        clickUrl({
          issueId,
          publicUrl: BASE_URL,
          signature: await createLinkSignature(SECRET, issueId, url),
          token: as,
          url,
        }),
        { headers: { "user-agent": agent }, method, redirect: "manual" }
      )
    );

  const recorded = async (type: "click" | "open") =>
    await db()
      .select()
      .from(events)
      .where(and(eq(events.issueId, issueId), eq(events.type, type)));

  it("redirects to the linked page and counts the click", async () => {
    const response = await click(POST);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(POST);
    expect(response.headers.get("cache-control")).toBe("no-store, private");

    await vi.waitFor(async () => {
      expect(await recorded("click")).toHaveLength(1);
    });

    const [row] = await recorded("click");
    expect(row).toMatchObject({
      detail: { agent: "browser", link: POST },
      subscriberId,
    });

    const reader = await findSubscriberByEmail(db(), "reader@example.com");
    expect(reader?.lastEngagedAt).toBeInstanceOf(Date);
  });

  it("redirects without counting test sends, link checkers or other tokens", async () => {
    const url = "https://example.com/post";

    const responses = [
      await click(url, { as: TEST_TRACKING_TOKEN }),
      await click(url, { method: "HEAD" }),
      await click(url, {
        as: await createToken(SECRET, "unsubscribe", subscriberId),
      }),
    ];

    for (const response of responses) {
      expect(response.status).toBe(302);
    }

    // A real click afterwards is the only one recorded.
    await click(url);

    await vi.waitFor(async () => {
      expect(await recorded("click")).toHaveLength(1);
    });
  });

  it("never redirects to a link the issue didn't sign", async () => {
    const signature = await createLinkSignature(SECRET, issueId, POST);

    const forged = [
      clickUrl({
        issueId,
        publicUrl: BASE_URL,
        signature,
        token,
        url: "https://phish.example/login",
      }),
      clickUrl({
        issueId: "another-issue",
        publicUrl: BASE_URL,
        signature,
        token,
        url: POST,
      }),
      `${BASE_URL}/click/${issueId}/${token}/${signature}`,
    ];

    for (const url of forged) {
      // oxlint-disable-next-line no-await-in-loop -- three requests
      const response = await exports.default.fetch(
        new Request(url, { redirect: "manual" })
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
    }
  });

  const open = async (agent: string) =>
    await exports.default.fetch(
      new Request(openUrl(BASE_URL, issueId, token), {
        headers: { "user-agent": agent },
      })
    );

  it("serves the open image and keeps one row per kind of reader", async () => {
    const first = await open("Mozilla/5.0");

    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/gif");
    expect(first.headers.get("cross-origin-resource-policy")).toBeNull();
    const image = await first.arrayBuffer();
    expect(new TextDecoder().decode(image.slice(0, 6))).toBe("GIF89a");

    await open(BROWSER);
    await open(BROWSER);

    await vi.waitFor(async () => {
      const rows = await recorded("open");

      expect(rows.map((row) => row.detail?.agent).toSorted()).toStrictEqual([
        "apple",
        "browser",
      ]);
    });
  });
});
