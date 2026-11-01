import { and, eq } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";

import type { Database } from "./db/client";
import { events, sends, subscribers } from "./db/schema";
import type { IssueTracking } from "./db/schema";
import { TRACKING_TOKEN_PLACEHOLDER } from "./email/render";
import { createId } from "./id";
import { createLinkSignature } from "./tokens";

// Click and open tracking, all on Sendoff's own domain. Links in the HTML
// email go through /click, which records the click and redirects; the
// destination stays visible in the link and is signed, so the redirect only
// goes where the issue linked. Opens are a 1×1 image at /open. Plain text is
// never tracked.

/** Test sends carry this instead of a recipient's token, so nothing is recorded. */
export const TEST_TRACKING_TOKEN = "test";

/**
 * Clicks this soon after delivery come from email security scanners, which
 * follow every link as a message arrives. People take longer than this.
 */
export const SCANNER_WINDOW_MS = 60_000;

/** Different links clicked this close together are a scanner, not a person. */
export const SCANNER_BURST_MS = 2000;

const ANCHOR_HREF =
  /(?<start><a\b[^>]*?\shref=")(?<href>https?:\/\/[^"]+)(?<end>")/giu;

const ATTRIBUTE_ENTITY = /&(?:amp|quot|lt|gt|#x27|#39);/gu;

const ENTITIES = new Map([
  ["&#39;", "'"],
  ["&#x27;", "'"],
  ["&amp;", "&"],
  ["&gt;", ">"],
  ["&lt;", "<"],
  ["&quot;", '"'],
]);

/** React escapes attribute values; links are signed and redirected unescaped. */
const decodeAttribute = (value: string): string =>
  value.replaceAll(
    ATTRIBUTE_ENTITY,
    (entity) => ENTITIES.get(entity) ?? entity
  );

export const isWebUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);

    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

export const clickUrl = ({
  issueId,
  publicUrl,
  signature,
  token,
  url,
}: {
  issueId: string;
  publicUrl: string;
  signature: string;
  token: string;
  url: string;
}): string =>
  `${publicUrl}/click/${issueId}/${token}/${signature}?url=${encodeURIComponent(url)}`;

export const openUrl = (publicUrl: string, issueId: string, token: string) =>
  `${publicUrl}/open/${issueId}/${token}`;

export interface TrackingOptions {
  issueId: string;
  publicUrl: string;
  secret: string;
  tracking: IssueTracking;
}

/**
 * Send an issue's web links through the click redirect and add the open
 * image, as the settings ask. Links to Sendoff's own pages (like
 * unsubscribe) are left alone. Each recipient's token is filled in later by
 * personalize().
 */
export const addTracking = async (
  html: string,
  { issueId, publicUrl, secret, tracking }: TrackingOptions
): Promise<string> => {
  let tracked = html;

  if (tracking.clicks) {
    const own = new URL(publicUrl).origin;
    const urls = new Set<string>();

    for (const match of html.matchAll(ANCHOR_HREF)) {
      const url = decodeAttribute(match.groups?.href ?? "");

      if (isWebUrl(url) && new URL(url).origin !== own) {
        urls.add(url);
      }
    }

    const signatures = new Map(
      await Promise.all(
        [...urls].map(
          async (url) =>
            [url, await createLinkSignature(secret, issueId, url)] as const
        )
      )
    );

    tracked = tracked.replaceAll(
      ANCHOR_HREF,
      (whole, start: string, href: string, end: string) => {
        const url = decodeAttribute(href);
        const signature = signatures.get(url);

        return signature
          ? `${start}${clickUrl({ issueId, publicUrl, signature, token: TRACKING_TOKEN_PLACEHOLDER, url })}${end}`
          : whole;
      }
    );
  }

  if (tracking.opens) {
    const image = `<img alt="" height="1" src="${openUrl(publicUrl, issueId, TRACKING_TOKEN_PLACEHOLDER)}" style="border:0;display:block;height:1px;width:1px" width="1" />`;
    const end = tracked.lastIndexOf("</body>");

    tracked =
      end === -1
        ? `${tracked}${image}`
        : `${tracked.slice(0, end)}${image}${tracked.slice(end)}`;
  }

  return tracked;
};

/**
 * - `apple`: Apple Mail Privacy Protection, which loads every image through
 *   a proxy as mail arrives, whether or not anyone reads it.
 * - `automated`: link checkers, previews, scripts and security scanners.
 * - `browser`: everything else, which is usually a person.
 */
export type AgentKind = "apple" | "automated" | "browser";

/** The exact user agent of Apple's image proxy. */
const APPLE_PROXY_AGENT = "Mozilla/5.0";

const AUTOMATED_AGENT =
  /bot\b|crawl|spider|slurp|preview|scan|python|curl|wget|java\/|go-http|okhttp|axios|node-fetch|undici|headless|phantom|proofpoint|mimecast|barracuda|whatsapp|facebookexternalhit/iu;

export const agentKind = (userAgent: string | undefined): AgentKind => {
  const agent = userAgent?.trim() ?? "";

  if (agent === APPLE_PROXY_AGENT) {
    return "apple";
  }

  return agent === "" || AUTOMATED_AGENT.test(agent) ? "automated" : "browser";
};

interface Hit {
  at: Date;
  issueId: string;
  subscriberId: string;
  userAgent: string | undefined;
}

/** Only people the issue was actually sent to are counted. */
const findSend = async (db: Database, issueId: string, subscriberId: string) =>
  await db.query.sends.findFirst({
    columns: { deliveredAt: true, sentAt: true },
    where: and(
      eq(sends.issueId, issueId),
      eq(sends.subscriberId, subscriberId),
      eq(sends.status, "sent")
    ),
  });

const markEngaged = (db: Database, subscriberId: string, at: Date) =>
  db
    .update(subscribers)
    .set({ lastEngagedAt: at })
    .where(eq(subscribers.id, subscriberId));

/** Whether a click came too soon after delivery to be a person. */
export const tooSoon = (
  at: Date,
  send: { deliveredAt: Date | null; sentAt: Date | null }
): boolean => {
  const arrived = send.deliveredAt ?? send.sentAt;

  return (
    arrived !== null && at.getTime() - arrived.getTime() < SCANNER_WINDOW_MS
  );
};

/** Record a click on a tracked link. Every click is kept; issue stats filter out scanners. */
export const recordClick = async (
  db: Database,
  { url, ...hit }: Hit & { url: string }
): Promise<boolean> => {
  const send = await findSend(db, hit.issueId, hit.subscriberId);

  if (!send) {
    return false;
  }

  const agent = agentKind(hit.userAgent);

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db.insert(events).values({
      at: hit.at,
      detail: { agent, link: url },
      id: createId(hit.at.getTime()),
      issueId: hit.issueId,
      subscriberId: hit.subscriberId,
      type: "click",
    }),
  ];

  if (agent === "browser" && !tooSoon(hit.at, send)) {
    statements.push(markEngaged(db, hit.subscriberId, hit.at));
  }

  await db.batch(statements);

  return true;
};

/**
 * Record an open. Each person gets at most one row per kind of agent, holding
 * the first time, so reopening an email doesn't add rows.
 */
export const recordOpen = async (db: Database, hit: Hit): Promise<boolean> => {
  const send = await findSend(db, hit.issueId, hit.subscriberId);

  if (!send) {
    return false;
  }

  const agent = agentKind(hit.userAgent);

  const statements: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]] = [
    db
      .insert(events)
      .values({
        at: hit.at,
        detail: { agent },
        id: `open:${hit.issueId}:${hit.subscriberId}:${agent}`,
        issueId: hit.issueId,
        subscriberId: hit.subscriberId,
        type: "open",
      })
      .onConflictDoNothing(),
  ];

  if (agent === "browser") {
    statements.push(markEngaged(db, hit.subscriberId, hit.at));
  }

  await db.batch(statements);

  return true;
};
