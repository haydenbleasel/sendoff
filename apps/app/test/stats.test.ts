import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";

import { events, issues, sends, subscribers } from "../src/db/schema";
import type { IssueTracking, issueStatuses } from "../src/db/schema";
import { createId } from "../src/id";
import { createDraft } from "../src/issues";
import { describeReport } from "../src/mcp/stats-tools";
import { issueReport } from "../src/stats";
import { findSubscriberByEmail, importSubscribers } from "../src/subscribers";
import { recordClick, recordOpen } from "../src/tracking";
import { db } from "./helpers";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-31T12:00:00.000Z");

const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

const LINK_A = "https://example.com/a";
const LINK_B = "https://example.com/b";

let readers: string[] = [];

beforeEach(async () => {
  const database = db();

  await database.delete(events);
  await database.delete(sends);
  await database.delete(issues);
  await database.delete(subscribers);
  await importSubscribers(
    database,
    Array.from({ length: 10 }, (_, index) => ({
      email: `r${index}@example.com`,
      status: "active" as const,
    }))
  );

  readers = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const reader = await findSubscriberByEmail(
        database,
        `r${index}@example.com`
      );

      return reader?.id ?? "";
    })
  );
});

/** An issue sent at `startedAt` to every reader, delivered 5 s later except for `undelivered`. */
const sentIssue = async ({
  startedAt,
  status = "sent",
  subject,
  tracking,
  undelivered = [],
}: {
  startedAt: number;
  status?: (typeof issueStatuses)[number];
  subject: string;
  tracking: IssueTracking | null;
  undelivered?: number[];
}) => {
  const draft = await createDraft(db(), { body: "Hi", subject });

  await db()
    .update(issues)
    .set({
      recipientCount: readers.length,
      sendStartedAt: new Date(startedAt),
      sentAt: new Date(startedAt + MINUTE),
      status,
      tracking,
    })
    .where(eq(issues.id, draft.id));

  await db()
    .insert(sends)
    .values(
      readers.map((subscriberId, index) => ({
        deliveredAt: undelivered.includes(index)
          ? null
          : new Date(startedAt + 5000),
        issueId: draft.id,
        messageId: `ses-${draft.id}-${index}`,
        sentAt: new Date(startedAt),
        status: "sent" as const,
        subscriberId,
      }))
    );

  const click = async (
    reader: number,
    after: number,
    url = LINK_A,
    userAgent = BROWSER
  ) =>
    await recordClick(db(), {
      at: new Date(startedAt + after),
      issueId: draft.id,
      subscriberId: readers[reader] ?? "",
      url,
      userAgent,
    });

  const open = async (reader: number, after: number, userAgent = BROWSER) =>
    await recordOpen(db(), {
      at: new Date(startedAt + after),
      issueId: draft.id,
      subscriberId: readers[reader] ?? "",
      userAgent,
    });

  const event = async (
    type: "bounce" | "complaint" | "unsubscribe",
    reader: number,
    after: number,
    detail: Record<string, string> = {}
  ) =>
    await db()
      .insert(events)
      .values({
        at: new Date(startedAt + after),
        detail,
        id: createId(),
        issueId: draft.id,
        subscriberId: readers[reader] ?? null,
        type,
      });

  return { click, event, id: draft.id, open };
};

describe("issueReport", () => {
  it("counts people, keeps scanners and Apple's loads out, and compares with earlier issues at the same point", async () => {
    const before = await sentIssue({
      startedAt: NOW - 30 * DAY,
      subject: "Before",
      tracking: { clicks: true, opens: false },
    });

    await before.click(0, 2 * HOUR);
    await before.event("unsubscribe", 1, 3 * HOUR);
    // After the point the current issue has reached, so it isn't compared.
    await before.click(2, 30 * HOUR);
    await before.event("unsubscribe", 3, 30 * HOUR);

    // A cancelled send reached only part of the list: never compared.
    await sentIssue({
      startedAt: NOW - 10 * DAY,
      status: "cancelled",
      subject: "Cancelled",
      tracking: { clicks: true, opens: false },
    });

    const issue = await sentIssue({
      startedAt: NOW - 26 * HOUR,
      subject: "Latest",
      tracking: { clicks: true, opens: true },
      undelivered: [8, 9],
    });

    await issue.click(0, 30 * MINUTE);
    await issue.click(0, 40 * MINUTE);
    await issue.click(1, 2 * HOUR, LINK_B);
    await issue.click(2, 3 * HOUR, LINK_A, "python-requests/2.32.3");
    // Within a minute of arriving: a security scanner.
    await issue.click(3, 15_000);
    // Two links in a second: a scanner too.
    await issue.click(4, 5 * HOUR, LINK_A);
    await issue.click(4, 5 * HOUR + 1000, LINK_B);
    await issue.click(5, 25 * HOUR);

    await issue.open(0, MINUTE, "Mozilla/5.0");
    await issue.open(0, 29 * MINUTE);
    await issue.open(6, MINUTE, "Mozilla/5.0");
    await issue.open(7, 3 * HOUR);
    await issue.open(7, 4 * HOUR);

    // On SES's suppression list: never tried, so not a bounce.
    await issue.event("bounce", 9, MINUTE, {
      bounceSubType: "OnAccountSuppressionList",
      bounceType: "Permanent",
    });
    await issue.event("bounce", 8, MINUTE, {
      bounceSubType: "General",
      bounceType: "Permanent",
    });
    await issue.event("bounce", 4, MINUTE, {
      bounceSubType: "MailboxFull",
      bounceType: "Transient",
    });
    await issue.event("complaint", 7, 4 * HOUR);
    await issue.event("unsubscribe", 6, 6 * HOUR);

    const report = await issueReport(db(), { now: NOW });
    const { stats } = report;

    expect(stats.issue.id).toBe(issue.id);
    expect(stats).toMatchObject({
      ageMs: 26 * HOUR,
      bounced: { hard: 1, soft: 1, total: 2 },
      complained: 1,
      delivered: 8,
      opens: { apple: 1, people: 4 },
      recipients: 10,
      sent: 10,
      suppressed: 1,
      unsubscribed: 1,
    });
    expect(stats.clicks).toStrictEqual({
      automated: 4,
      links: [
        { clicks: 3, people: 2, url: LINK_A },
        { clicks: 1, people: 1, url: LINK_B },
      ],
      people: 3,
      total: 4,
    });
    expect(stats.rates).toStrictEqual({
      bounce: 2 / 9,
      click: 3 / 8,
      complaint: 1 / 8,
      open: 4 / 8,
      unsubscribe: 1 / 8,
    });
    expect(stats.timeline).toStrictEqual([
      { clicked: 1, hours: 1, opened: 1 },
      { clicked: 2, hours: 6, opened: 3 },
      { clicked: 2, hours: 24, opened: 3 },
    ]);

    expect(
      report.comparison?.issues.map((earlier) => earlier.id)
    ).toStrictEqual([before.id]);
    expect(report.comparison?.rates).toMatchObject({
      click: 0.1,
      open: null,
      unsubscribe: 0.1,
    });

    const text = describeReport(report);
    expect(text).toContain(
      "Clicks: 3 people clicked (37.5% of delivered), 4 clicks in all. 4 automated clicks from link scanners and checkers aren't counted."
    );
    expect(text).toContain(
      "Opens: 4 opened it (50.0%), counting everyone who clicked."
    );
    expect(text).toContain(
      "bounced: 2 (22.2%; 1 hard, 1 soft), suppressed: 1 (on SES's suppression list"
    );
    expect(text).toContain(
      "Links clicked:\n- https://example.com/a: 2 people (3 clicks)\n- https://example.com/b: 1 person (1 click)"
    );
    expect(text).toContain(
      "Compared with the issue before at the same point, 26 hours after sending: clicks 37.5% vs 10.0%, unsubscribes 12.5% vs 10.0%"
    );
    expect(text).toContain("Bounces are at 22.2%");
    expect(text).toContain("Complaints are at 12.5%");
  });

  it("reports what wasn't tracked, and that it's the first issue", async () => {
    await sentIssue({
      startedAt: NOW - 2 * HOUR,
      subject: "Untracked",
      tracking: null,
    });

    const report = await issueReport(db(), { now: NOW });

    expect(report.comparison).toBeNull();
    expect(report.stats).toMatchObject({
      clicks: null,
      opens: null,
      rates: { click: null, open: null },
      timeline: [],
    });

    const text = describeReport(report);
    expect(text).toContain("Clicks weren't tracked for this issue.");
    expect(text).toContain("Opens weren't tracked for this issue.");
    expect(text).toContain("first issue sent");
    expect(text).toContain("It's early");
  });

  it("returns every link clicked, and lists the top 10", async () => {
    const issue = await sentIssue({
      startedAt: NOW - DAY,
      subject: "Lots of links",
      tracking: { clicks: true, opens: false },
    });

    // Far enough apart, and from delivery, to be a person.
    for (const index of Array.from({ length: 12 }, (_, at) => at)) {
      // oxlint-disable-next-line no-await-in-loop -- in order, like a reader
      await issue.click(
        0,
        HOUR + index * MINUTE,
        `https://example.com/${index}`
      );
    }

    const report = await issueReport(db(), { now: NOW });

    expect(report.stats.clicks?.links).toHaveLength(12);

    const listed = describeReport(report)
      .split("\n")
      .filter((line) => line.startsWith("- "));

    expect(listed).toHaveLength(11);
    expect(listed.at(-1)).toBe("- and 2 more links, listed in the data below");
  });

  it("explains when there's nothing to report", async () => {
    await expect(issueReport(db(), { now: NOW })).rejects.toThrow(
      "Nothing has been sent yet"
    );

    const draft = await createDraft(db(), { body: "Hi", subject: "Draft" });

    await expect(
      issueReport(db(), { now: NOW, ref: draft.id })
    ).rejects.toThrow("hasn't been sent");
  });
});
