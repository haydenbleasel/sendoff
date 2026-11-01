import {
  and,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  lt,
  lte,
  sql,
} from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./db/client";
import { events, issues, sends } from "./db/schema";
import { IssueError, requireIssue } from "./issues";
import type { Issue } from "./issues";
import { SCANNER_BURST_MS, tooSoon } from "./tracking";

// How an issue is doing: delivery, clicks, opens and unsubscribes, counted
// in people, with scanners and Apple Mail's automatic loads kept out of the
// headline numbers. Compared with earlier issues at the same point after
// sending, since most engagement comes in the first day or two.

const MS_PER_HOUR = 3_600_000;
const COMPARE_WITH = 3;

/** Cumulative engagement checkpoints, in hours after sending started. */
const CHECKPOINT_HOURS = [1, 6, 24, 72, 168] as const;

export interface LinkStats {
  clicks: number;
  people: number;
  url: string;
}

export interface Rates {
  /** Of emails sent, less any SES suppressed (it never tried to deliver those). */
  bounce: number | null;
  /** The rest are of emails delivered (or sent, if SES hasn't reported deliveries). */
  click: number | null;
  complaint: number | null;
  open: number | null;
  unsubscribe: number | null;
}

export interface Checkpoint {
  clicked: number | null;
  hours: number;
  opened: number | null;
}

export interface IssueStats {
  /** Time since sending started that these numbers cover. */
  ageMs: number;
  bounced: { hard: number; soft: number; total: number };
  /** null when the issue was sent without click tracking. */
  clicks: {
    /** Clicks from scanners and link checkers, left out of everything else. */
    automated: number;
    /** Every link that was clicked, most people first. */
    links: LinkStats[];
    people: number;
    total: number;
  } | null;
  complained: number;
  delivered: number;
  failed: number;
  issue: Issue;
  /** null when the issue was sent without open tracking. */
  opens: {
    /** Apple Mail loaded the email automatically, and there's no other sign it was read. */
    apple: number;
    /** Opened it in a way that shows a person, or clicked a link. */
    people: number;
  } | null;
  rates: Rates;
  recipients: number;
  rejected: number;
  sent: number;
  skipped: number;
  /** Addresses on SES's suppression list: SES didn't try to deliver them, so they aren't bounces. */
  suppressed: number;
  timeline: Checkpoint[];
  unsubscribed: number;
}

export interface IssueReport {
  /** Earlier issues' average rates at the same point after sending. */
  comparison: { issues: Issue[]; rates: Rates } | null;
  stats: IssueStats;
}

interface ClickRow {
  agent: string;
  at: Date;
  deliveredAt: Date | null;
  link: string;
  sentAt: Date | null;
  subscriberId: string;
}

// Event details are JSON written by Sendoff; parse what's needed, defensively.
const clickDetailSchema = z.object({ agent: z.string(), link: z.string() });

const bounceDetailSchema = z.object({
  bounceSubType: z.string().optional(),
  bounceType: z.string(),
});

/**
 * SES reports a send to an address on its account-level or global
 * suppression list as a bounce with one of these subtypes, but it never
 * tried to deliver it, and it doesn't count toward SES's bounce rate.
 */
const SUPPRESSED_SUBTYPES = new Set(["OnAccountSuppressionList", "Suppressed"]);

const rate = (part: number, whole: number): number | null =>
  whole > 0 ? part / whole : null;

/**
 * Split clicks into people and scanners. A click is automated if it came
 * from a non-browser, arrived within a minute of delivery, or was one of
 * several different links followed within a couple of seconds.
 */
const splitClicks = (rows: ClickRow[]) => {
  const bySubscriber = new Map<string, ClickRow[]>();

  for (const row of rows) {
    const list = bySubscriber.get(row.subscriberId) ?? [];
    list.push(row);
    bySubscriber.set(row.subscriberId, list);
  }

  const human: ClickRow[] = [];
  let automated = 0;

  for (const list of bySubscriber.values()) {
    const clicks = list.toSorted((a, b) => a.at.getTime() - b.at.getTime());

    const flagged = clicks.map(
      (click) => click.agent !== "browser" || tooSoon(click.at, click)
    );

    for (const [index, click] of clicks.entries()) {
      for (const [offset, later] of clicks.slice(index + 1).entries()) {
        if (later.at.getTime() - click.at.getTime() > SCANNER_BURST_MS) {
          break;
        }

        if (later.link !== click.link) {
          flagged[index] = true;
          flagged[index + 1 + offset] = true;
        }
      }
    }

    for (const [index, click] of clicks.entries()) {
      if (flagged[index]) {
        automated += 1;
      } else {
        human.push(click);
      }
    }
  }

  return { automated, human };
};

const linkStats = (clicks: ClickRow[]): LinkStats[] => {
  const byUrl = new Map<string, { clicks: number; people: Set<string> }>();

  for (const click of clicks) {
    const entry = byUrl.get(click.link) ?? { clicks: 0, people: new Set() };
    entry.clicks += 1;
    entry.people.add(click.subscriberId);
    byUrl.set(click.link, entry);
  }

  return [...byUrl.entries()]
    .map(([url, entry]) => ({
      clicks: entry.clicks,
      people: entry.people.size,
      url,
    }))
    .toSorted(
      (a, b) =>
        b.people - a.people || b.clicks - a.clicks || a.url.localeCompare(b.url)
    );
};

/** Keep each person's earliest time. */
const keepEarliest = (
  first: Map<string, number>,
  subscriberId: string,
  at: Date
) => {
  const previous = first.get(subscriberId);

  if (previous === undefined || at.getTime() < previous) {
    first.set(subscriberId, at.getTime());
  }
};

const countBy = (times: Map<string, number>, cutoff: number): number => {
  let total = 0;

  for (const at of times.values()) {
    if (at <= cutoff) {
      total += 1;
    }
  }

  return total;
};

const loadTotals = async (db: Database, issueId: string, until: number) => {
  const [totals] = await db
    .select({
      delivered: sql<number>`count(case when ${sends.deliveredAt} <= ${until} then 1 end)`,
      failed: sql<number>`count(case when ${sends.status} = 'failed' then 1 end)`,
      recipients: count(),
      sent: sql<number>`count(case when ${sends.status} = 'sent' and ${sends.sentAt} <= ${until} then 1 end)`,
      skipped: sql<number>`count(case when ${sends.status} = 'skipped' then 1 end)`,
    })
    .from(sends)
    .where(eq(sends.issueId, issueId));

  return {
    delivered: totals?.delivered ?? 0,
    failed: totals?.failed ?? 0,
    recipients: totals?.recipients ?? 0,
    sent: totals?.sent ?? 0,
    skipped: totals?.skipped ?? 0,
  };
};

/** Everything but opens, with each click's send for the scanner checks. */
const loadEvents = async (db: Database, issueId: string, cutoff: Date) =>
  await db
    .select({
      at: events.at,
      deliveredAt: sends.deliveredAt,
      detail: events.detail,
      id: events.id,
      sentAt: sends.sentAt,
      subscriberId: events.subscriberId,
      type: events.type,
    })
    .from(events)
    .leftJoin(
      sends,
      and(
        eq(sends.issueId, events.issueId),
        eq(sends.subscriberId, events.subscriberId)
      )
    )
    .where(
      and(
        eq(events.issueId, issueId),
        lte(events.at, cutoff),
        inArray(events.type, [
          "bounce",
          "click",
          "complaint",
          "reject",
          "unsubscribe",
        ])
      )
    );

/** At most one row per person and kind of agent (see recordOpen). */
const loadOpens = async (db: Database, issueId: string, cutoff: Date) =>
  await db
    .select({
      agent: sql<string>`json_extract(${events.detail}, '$.agent')`,
      at: events.at,
      subscriberId: events.subscriberId,
    })
    .from(events)
    .where(
      and(
        eq(events.issueId, issueId),
        eq(events.type, "open"),
        lte(events.at, cutoff)
      )
    );

type EventRow = Awaited<ReturnType<typeof loadEvents>>[number];

/** Who bounced, was suppressed, complained, was rejected or unsubscribed, and every click. */
const tallyEvents = (rows: EventRow[]) => {
  const people = {
    bounce: new Set<string>(),
    complaint: new Set<string>(),
    hardBounce: new Set<string>(),
    reject: new Set<string>(),
    suppressed: new Set<string>(),
    unsubscribe: new Set<string>(),
  };

  const clicks: ClickRow[] = [];

  for (const row of rows) {
    // Someone deleted since still counts once, under the event's own id.
    const person = row.subscriberId ?? row.id;

    if (row.type === "click") {
      const detail = clickDetailSchema.safeParse(row.detail);

      if (row.subscriberId && detail.success) {
        clicks.push({
          ...detail.data,
          at: row.at,
          deliveredAt: row.deliveredAt,
          sentAt: row.sentAt,
          subscriberId: row.subscriberId,
        });
      }
    } else if (row.type === "bounce") {
      const bounce = bounceDetailSchema.safeParse(row.detail).data;

      if (SUPPRESSED_SUBTYPES.has(bounce?.bounceSubType ?? "")) {
        people.suppressed.add(person);
      } else {
        people.bounce.add(person);

        if (bounce?.bounceType === "Permanent") {
          people.hardBounce.add(person);
        }
      }
    } else if (row.type !== "open") {
      people[row.type].add(person);
    }
  }

  return { clicks, people };
};

/**
 * Everyone who clicked has opened it, whatever the image said. Apple's
 * automatic loads count only for people with no other sign of reading.
 */
const tallyOpens = (
  firstClick: Map<string, number>,
  rows: Awaited<ReturnType<typeof loadOpens>>
) => {
  const firstOpen = new Map(firstClick);
  const apple = new Set<string>();

  for (const row of rows) {
    if (row.subscriberId && row.agent === "browser") {
      keepEarliest(firstOpen, row.subscriberId, row.at);
    } else if (row.subscriberId && row.agent === "apple") {
      apple.add(row.subscriberId);
    }
  }

  for (const subscriberId of firstOpen.keys()) {
    apple.delete(subscriberId);
  }

  return { apple: apple.size, firstOpen };
};

const buildTimeline = ({
  firstClick,
  firstOpen,
  startedAt,
  until,
}: {
  firstClick: Map<string, number> | null;
  firstOpen: Map<string, number> | null;
  startedAt: number;
  until: number;
}): Checkpoint[] =>
  CHECKPOINT_HOURS.flatMap((hours) => {
    const at = startedAt + hours * MS_PER_HOUR;

    if (at > until || (!firstClick && !firstOpen)) {
      return [];
    }

    return [
      {
        clicked: firstClick ? countBy(firstClick, at) : null,
        hours,
        opened: firstOpen ? countBy(firstOpen, at) : null,
      },
    ];
  });

/** Stats for one issue, counting only what happened up to `until`. */
export const computeStats = async (
  db: Database,
  issue: Issue,
  until: number
): Promise<IssueStats> => {
  const startedAt = issue.sendStartedAt?.getTime() ?? until;
  const cutoff = new Date(until);
  const tracking = issue.tracking ?? { clicks: false, opens: false };

  const [totals, rows, openRows] = await Promise.all([
    loadTotals(db, issue.id, until),
    loadEvents(db, issue.id, cutoff),
    tracking.opens ? loadOpens(db, issue.id, cutoff) : Promise.resolve([]),
  ]);

  const { clicks: clickRows, people } = tallyEvents(rows);
  const { automated, human } = splitClicks(clickRows);
  const firstClick = new Map<string, number>();

  for (const click of human) {
    keepEarliest(firstClick, click.subscriberId, click.at);
  }

  const opened = tallyOpens(firstClick, openRows);
  const reached = totals.delivered > 0 ? totals.delivered : totals.sent;

  const clicks = tracking.clicks
    ? {
        automated,
        links: linkStats(human),
        people: firstClick.size,
        total: human.length,
      }
    : null;

  const opens = tracking.opens
    ? { apple: opened.apple, people: opened.firstOpen.size }
    : null;

  return {
    ageMs: Math.max(0, until - startedAt),
    bounced: {
      hard: people.hardBounce.size,
      soft: people.bounce.size - people.hardBounce.size,
      total: people.bounce.size,
    },
    clicks,
    complained: people.complaint.size,
    delivered: totals.delivered,
    failed: totals.failed,
    issue,
    opens,
    rates: {
      bounce: rate(people.bounce.size, totals.sent - people.suppressed.size),
      click: clicks ? rate(clicks.people, reached) : null,
      complaint: rate(people.complaint.size, reached),
      open: opens ? rate(opens.people, reached) : null,
      unsubscribe: rate(people.unsubscribe.size, reached),
    },
    recipients: issue.recipientCount ?? totals.recipients,
    rejected: people.reject.size,
    sent: totals.sent,
    skipped: totals.skipped,
    suppressed: people.suppressed.size,
    timeline: buildTimeline({
      firstClick: tracking.clicks ? firstClick : null,
      firstOpen: tracking.opens ? opened.firstOpen : null,
      startedAt,
      until,
    }),
    unsubscribed: people.unsubscribe.size,
  };
};

const RATE_KEYS = [
  "bounce",
  "click",
  "complaint",
  "open",
  "unsubscribe",
] as const satisfies readonly (keyof Rates)[];

const averageRates = (all: Rates[]): Rates => {
  const averages: Rates = {
    bounce: null,
    click: null,
    complaint: null,
    open: null,
    unsubscribe: null,
  };

  for (const key of RATE_KEYS) {
    const values = all.flatMap((rates) => {
      const value = rates[key];

      return value === null ? [] : [value];
    });

    let sum = 0;

    for (const value of values) {
      sum += value;
    }

    averages[key] = values.length > 0 ? sum / values.length : null;
  }

  return averages;
};

/** The most recently sent issue, including one still sending. */
const latestSent = async (db: Database): Promise<Issue | undefined> =>
  await db.query.issues.findFirst({
    orderBy: desc(issues.sendStartedAt),
    where: isNotNull(issues.sendStartedAt),
  });

/**
 * Stats for an issue (the latest sent, by default), with the average of the
 * few issues before it measured at the same point after sending.
 */
export const issueReport = async (
  db: Database,
  { now = Date.now(), ref }: { now?: number; ref?: string | undefined } = {}
): Promise<IssueReport> => {
  const issue = ref ? await requireIssue(db, ref) : await latestSent(db);

  if (!issue) {
    throw new IssueError("Nothing has been sent yet, so there are no stats.");
  }

  if (!issue.sendStartedAt) {
    throw new IssueError(
      `"${issue.subject}" is a draft that hasn't been sent, so there are no stats yet.`
    );
  }

  const stats = await computeStats(db, issue, now);

  // Cancelled issues reached only part of the list, so they'd skew the average.
  const earlier = await db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.status, "sent"),
        lt(issues.sendStartedAt, issue.sendStartedAt)
      )
    )
    .orderBy(desc(issues.sendStartedAt))
    .limit(COMPARE_WITH);

  if (earlier.length === 0) {
    return { comparison: null, stats };
  }

  const previous = await Promise.all(
    earlier.map(
      async (before) =>
        await computeStats(
          db,
          before,
          (before.sendStartedAt?.getTime() ?? 0) + stats.ageMs
        )
    )
  );

  return {
    comparison: {
      issues: earlier,
      rates: averageRates(previous.map((before) => before.rates)),
    },
    stats,
  };
};
