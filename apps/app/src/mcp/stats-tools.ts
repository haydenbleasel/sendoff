import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Database } from "../db/client";
import type { JsonObject } from "../json";
import { issueReport } from "../stats";
import type { IssueReport, IssueStats, Rates } from "../stats";
import { presentIssue, result, run } from "./results";

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const SHOW_HOURS_UNTIL = 48;
const PERCENT = 100;
const SMALL_RATE = 0.01;
const DATE_LENGTH = 16;
const TOP_LINKS = 10;

/** SES reviews an account at about these rates. */
const SES_BOUNCE_REVIEW = 0.05;
const SES_COMPLAINT_REVIEW = 0.001;

/** After this long with no deliveries reported, SES probably isn't sending them. */
const DELIVERY_GRACE_MS = 15 * MS_PER_MINUTE;
const EARLY_MS = HOURS_PER_DAY * MINUTES_PER_HOUR * MS_PER_MINUTE;

const number = (value: number) => value.toLocaleString("en-US");

const plural = (count: number, word: string) =>
  `${number(count)} ${word}${count === 1 ? "" : "s"}`;

const people = (count: number) =>
  `${number(count)} ${count === 1 ? "person" : "people"}`;

const percent = (value: number | null): string => {
  if (value === null) {
    return "n/a";
  }

  if (value === 0) {
    return "0%";
  }

  return `${(value * PERCENT).toFixed(value < SMALL_RATE ? 2 : 1)}%`;
};

const since = (ms: number): string => {
  const minutes = Math.round(ms / MS_PER_MINUTE);

  if (minutes < MINUTES_PER_HOUR) {
    return plural(Math.max(minutes, 1), "minute");
  }

  const hours = Math.round(minutes / MINUTES_PER_HOUR);

  return hours < SHOW_HOURS_UNTIL
    ? plural(hours, "hour")
    : plural(Math.round(hours / HOURS_PER_DAY), "day");
};

const checkpointLabel = (hours: number) =>
  hours < HOURS_PER_DAY ? `${hours}h` : `${hours / HOURS_PER_DAY}d`;

const headline = (stats: IssueStats): string => {
  const { issue } = stats;

  const started = issue.sendStartedAt
    ?.toISOString()
    .slice(0, DATE_LENGTH)
    .replace("T", " ");

  const when = `${since(stats.ageMs)} ago (${started} UTC)`;

  if (issue.status === "sending") {
    return `"${issue.subject}" is still sending: ${number(stats.sent)} of ${number(stats.recipients)} sent so far, starting ${when}.`;
  }

  if (issue.status === "cancelled") {
    return `"${issue.subject}" was cancelled after sending to ${number(stats.sent)} of ${number(stats.recipients)} subscribers, starting ${when}.`;
  }

  return `"${issue.subject}" went to ${number(stats.sent)} subscribers ${when}.`;
};

const deliveryLine = (stats: IssueStats): string => {
  const parts = [
    `Delivered: ${number(stats.delivered)} (${percent(stats.sent > 0 ? stats.delivered / stats.sent : null)})`,
    `bounced: ${number(stats.bounced.total)} (${percent(stats.rates.bounce)}; ${number(stats.bounced.hard)} hard, ${number(stats.bounced.soft)} soft)`,
  ];

  if (stats.suppressed > 0) {
    parts.push(
      `suppressed: ${number(stats.suppressed)} (on SES's suppression list, so SES didn't try them; not counted as bounces)`
    );
  }

  parts.push(
    `complaints: ${number(stats.complained)} (${percent(stats.rates.complaint)})`
  );

  if (stats.rejected > 0) {
    parts.push(`rejected by SES: ${number(stats.rejected)}`);
  }

  if (stats.failed > 0) {
    parts.push(`failed to send: ${number(stats.failed)}`);
  }

  if (stats.skipped > 0) {
    parts.push(`skipped (left the list mid-send): ${number(stats.skipped)}`);
  }

  return `${parts.join(", ")}.`;
};

const clicksLine = ({ clicks, rates }: IssueStats): string => {
  if (!clicks) {
    return "Clicks weren't tracked for this issue.";
  }

  const automated =
    clicks.automated > 0
      ? ` ${plural(clicks.automated, "automated click")} from link scanners and checkers aren't counted.`
      : "";

  return `Clicks: ${people(clicks.people)} clicked (${percent(rates.click)} of delivered), ${plural(clicks.total, "click")} in all.${automated}`;
};

const opensLine = ({ opens, rates, delivered, sent }: IssueStats): string => {
  if (!opens) {
    return "Opens weren't tracked for this issue.";
  }

  const reached = delivered > 0 ? delivered : sent;
  const apple = reached > 0 ? opens.apple / reached : null;

  return `Opens: ${number(opens.people)} opened it (${percent(rates.open)}), counting everyone who clicked. Apple Mail loaded it automatically for another ${number(opens.apple)} (${percent(apple)}), so some of them read it, but there's no telling which.`;
};

const linksSection = ({ clicks }: IssueStats): string => {
  if (!clicks || clicks.links.length === 0) {
    return "";
  }

  const shown = clicks.links
    .slice(0, TOP_LINKS)
    .map(
      (link) =>
        `- ${link.url}: ${people(link.people)} (${plural(link.clicks, "click")})`
    );

  const more = clicks.links.length - shown.length;

  if (more > 0) {
    shown.push(`- and ${plural(more, "more link")}, listed in the data below`);
  }

  return `Links clicked:\n${shown.join("\n")}`;
};

const timelineLine = ({ timeline }: IssueStats): string => {
  if (timeline.length === 0) {
    return "";
  }

  const point = (key: "clicked" | "opened") =>
    timeline
      .map((checkpoint) => {
        const value = checkpoint[key];

        return value === null
          ? null
          : `${checkpointLabel(checkpoint.hours)} ${number(value)}`;
      })
      .filter((value) => value !== null)
      .join(" · ");

  return [
    timeline[0]?.clicked === null
      ? ""
      : `Clicked, by time since sending: ${point("clicked")}`,
    timeline[0]?.opened === null
      ? ""
      : `Opened, by time since sending: ${point("opened")}`,
  ]
    .filter(Boolean)
    .join("\n");
};

const COMPARED: [keyof Rates, string][] = [
  ["click", "clicks"],
  ["open", "opens"],
  ["unsubscribe", "unsubscribes"],
  ["bounce", "bounces"],
  ["complaint", "complaints"],
];

const comparisonLine = ({ comparison, stats }: IssueReport): string => {
  if (!comparison) {
    return "This is the first issue sent, so there's nothing to compare it with yet.";
  }

  const parts = COMPARED.flatMap(([key, label]) => {
    const now = stats.rates[key];
    const before = comparison.rates[key];

    return now === null || before === null
      ? []
      : [`${label} ${percent(now)} vs ${percent(before)}`];
  });

  const earlier =
    comparison.issues.length === 1
      ? "the issue before"
      : `the ${comparison.issues.length} issues before (on average)`;

  return parts.length > 0
    ? `Compared with ${earlier} at the same point, ${since(stats.ageMs)} after sending: ${parts.join(", ")}.`
    : "";
};

const notes = (stats: IssueStats): string[] => {
  const list: string[] = [];

  if (
    stats.sent > 0 &&
    stats.delivered === 0 &&
    stats.ageMs > DELIVERY_GRACE_MS
  ) {
    list.push(
      "SES hasn't reported any deliveries for this issue. If doctor warns about delivery reports, ask the person to run `bun run setup` again to turn them on."
    );
  }

  // SES's bounce rate counts hard bounces only: a full mailbox or an
  // out-of-office reply doesn't count against the account.
  const attempted = stats.sent - stats.suppressed;
  const hardBounces = attempted > 0 ? stats.bounced.hard / attempted : 0;

  if (hardBounces >= SES_BOUNCE_REVIEW) {
    list.push(
      `Hard bounces are at ${percent(hardBounces)}. SES reviews accounts at about 5% and pauses sending at about 10%, so the list may need cleaning.`
    );
  }

  if ((stats.rates.complaint ?? 0) >= SES_COMPLAINT_REVIEW) {
    list.push(
      `Complaints are at ${percent(stats.rates.complaint)}. SES reviews accounts at about 0.1%, and Gmail wants spam reports under 0.3%.`
    );
  }

  if (stats.issue.status !== "sending" && stats.ageMs < EARLY_MS) {
    list.push(
      "It's early: most clicks and unsubscribes come in the first day or two."
    );
  }

  return list;
};

export const describeReport = (report: IssueReport): string => {
  const { stats } = report;

  return [
    headline(stats),
    deliveryLine(stats),
    clicksLine(stats),
    opensLine(stats),
    `Unsubscribes: ${number(stats.unsubscribed)} (${percent(stats.rates.unsubscribe)}).`,
    linksSection(stats),
    timelineLine(stats),
    comparisonLine(report),
    ...notes(stats),
  ]
    .filter(Boolean)
    .join("\n\n");
};

const presentRates = (rates: Rates): JsonObject => ({ ...rates });

const presentReport = ({ comparison, stats }: IssueReport): JsonObject =>
  presentIssue(stats.issue, {
    ageMinutes: Math.round(stats.ageMs / MS_PER_MINUTE),
    bounced: { ...stats.bounced },
    clicks: stats.clicks
      ? {
          automated: stats.clicks.automated,
          links: stats.clicks.links.map((link) => ({ ...link })),
          people: stats.clicks.people,
          total: stats.clicks.total,
        }
      : null,
    comparedWith: comparison
      ? {
          issues: comparison.issues.map((issue) => ({
            id: issue.id,
            sentAt: issue.sentAt?.toISOString() ?? null,
            subject: issue.subject,
          })),
          rates: presentRates(comparison.rates),
        }
      : null,
    complained: stats.complained,
    delivered: stats.delivered,
    failed: stats.failed,
    opens: stats.opens ? { ...stats.opens } : null,
    rates: presentRates(stats.rates),
    recipients: stats.recipients,
    rejected: stats.rejected,
    sendStartedAt: stats.issue.sendStartedAt?.toISOString() ?? null,
    sent: stats.sent,
    skipped: stats.skipped,
    suppressed: stats.suppressed,
    timeline: stats.timeline.map((checkpoint) => ({ ...checkpoint })),
    unsubscribed: stats.unsubscribed,
  });

export const registerStatsTools = (
  server: McpServer,
  { db }: { db: Database }
): void => {
  server.registerTool(
    "issue_stats",
    {
      annotations: READ_ONLY,
      description:
        "How a sent issue is doing: deliveries, bounces, addresses SES suppressed, complaints, clicks, opens (if tracked) and unsubscribes, counted in people, with clicks for every link and how it compares with earlier issues at the same point after sending. Clicks from email security scanners and Apple Mail's automatic image loads are kept out of the headline numbers. Defaults to the latest issue sent.",
      inputSchema: z.object({
        issue: z
          .string()
          .min(1)
          .optional()
          .describe("The issue's id or slug. Defaults to the latest sent."),
      }),
      title: "Issue stats",
    },
    async ({ issue }) =>
      await run(async () => {
        const report = await issueReport(db, { ref: issue });

        return result(describeReport(report), presentReport(report));
      })
  );
};
