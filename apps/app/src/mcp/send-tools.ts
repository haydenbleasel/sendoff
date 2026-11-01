import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config";
import type { Database } from "../db/client";
import { formatChecks, runDoctor } from "../doctor";
import {
  cancelSend,
  confirmSend,
  prepareSend,
  resumeSend,
  sendStatus,
  sendTest,
} from "../sending";
import type { SendQueue, SendStatus } from "../sending";
import { presentIssue, result, run } from "./results";

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const PERCENT = 100;

const issueRef = z.string().min(1).describe("The issue's id or slug.");

const number = (value: number) => value.toLocaleString("en-US");

const duration = (recipients: number, rate: number): string => {
  const seconds = Math.ceil(recipients / Math.max(rate, 1));

  return seconds < SECONDS_PER_MINUTE
    ? `under a minute`
    : `about ${Math.ceil(seconds / SECONDS_PER_MINUTE)} minutes`;
};

const describeStatus = ({
  counts,
  delivered,
  events,
  failures,
  issue,
  stalled,
}: SendStatus): string => {
  const total = issue.recipientCount ?? 0;
  const done = counts.sent + counts.failed + counts.skipped;

  const lines = [
    `"${issue.subject}" is ${issue.status}.`,
    total > 0
      ? `${number(counts.sent)} sent, ${number(counts.failed)} failed, ${number(counts.skipped)} skipped, ${number(counts.queued + counts.sending)} to go (${Math.floor((done / total) * PERCENT)}% of ${number(total)}).`
      : "",
    `Since sending: ${number(delivered)} delivered, ${events.bounce} bounced, ${events.complaint} complaints, ${events.unsubscribe} unsubscribed. issue_stats has clicks, opens, rates and how this compares with earlier issues.`,
  ];

  if (issue.sendError) {
    lines.push(
      `Stopped: ${issue.sendError}\nFix the cause, then call resume_send.`
    );
  }

  if (stalled) {
    lines.push(
      "No progress for a few minutes; the scheduled job will restart it shortly."
    );
  }

  if (failures.length > 0) {
    lines.push(
      `Failures:\n${failures.map((failure) => `- ${failure.email}: ${failure.error ?? "unknown"}`).join("\n")}`
    );
  }

  return lines.filter(Boolean).join("\n");
};

export const registerSendTools = (
  server: McpServer,
  { config, db, queue }: { config: Config; db: Database; queue: SendQueue }
): void => {
  const deps = { config, db, queue };

  server.registerTool(
    "doctor",
    {
      annotations: READ_ONLY,
      description:
        "Run the preflight checks for sending: settings, SES production access and quota, sender domain verification, DMARC, bounce and complaint tracking, and subscribers. prepare_send runs these too.",
      inputSchema: z.object({}),
      title: "Check sending setup",
    },
    async () =>
      await run(async () => {
        const report = await runDoctor({ config, db });

        const failing = report.checks.filter(
          (check) => check.status === "fail"
        ).length;

        return result(
          `${report.ok ? "Ready to send." : `${failing} check${failing === 1 ? "" : "s"} must pass before sending.`}\n\n${formatChecks(report.checks)}`
        );
      })
  );

  server.registerTool(
    "send_test",
    {
      description:
        "Email the current version of a draft to the sender (or up to 5 addresses) with [Test] in the subject. Sending requires a test of the exact current version, so send another after any change to the draft or settings. Ask the person to check it in their inbox.",
      inputSchema: z.object({
        issue: issueRef,
        to: z
          .array(z.string())
          .max(5)
          .optional()
          .describe("Defaults to the reply-to address, or the sender."),
      }),
      title: "Send test email",
    },
    async ({ issue: ref, to }) =>
      await run(async () => {
        const { issue, to: recipients } = await sendTest(deps, ref, to);

        return result(
          `Sent a test of "${issue.subject}" to ${recipients.join(", ")}. Its unsubscribe link is a placeholder. Once the person is happy with it, call prepare_send.`
        );
      })
  );

  server.registerTool(
    "prepare_send",
    {
      annotations: READ_ONLY,
      description:
        "Check that a draft is ready to go to every active subscriber, without sending. Returns a summary to show the person and a confirmation token for confirm_send that expires in 15 minutes.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Prepare send",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const prepared = await prepareSend(deps, ref);
        const { issue, settings } = prepared;

        const warnings = prepared.report.checks.filter(
          (check) => check.status === "warn"
        );

        const minutes = Math.round(
          (prepared.expiresAt - Date.now()) / MS_PER_SECOND / SECONDS_PER_MINUTE
        );

        return result(
          [
            `Ready to send "${issue.subject}" to ${number(prepared.recipients)} subscribers from ${settings.from.name} <${settings.from.email}>.`,
            issue.preheader ? `Preheader: ${issue.preheader}` : "",
            `It will take ${duration(prepared.recipients, prepared.maxSendRate)} at ${prepared.maxSendRate} emails per second.`,
            `The last test (${issue.testSentAt?.toISOString() ?? "earlier"}) matches this version.`,
            warnings.length > 0
              ? `Warnings:\n${formatChecks(warnings)}`
              : "All checks passed.",
            `Confirmation (expires in ${minutes} minutes): ${prepared.confirmation}`,
            "Show this summary to the person. Only call confirm_send after they explicitly say to send it now. Sending can't be undone.",
          ]
            .filter(Boolean)
            .join("\n\n")
        );
      })
  );

  server.registerTool(
    "confirm_send",
    {
      annotations: { destructiveHint: true, openWorldHint: true },
      description:
        "Send a prepared issue to every active subscriber. This emails real people and can't be undone. Only call it after showing the person prepare_send's summary and getting their explicit go-ahead in this conversation.",
      inputSchema: z.object({
        confirmation: z
          .string()
          .min(1)
          .describe("The confirmation from prepare_send."),
        issue: issueRef,
      }),
      title: "Send to subscribers",
    },
    async ({ confirmation, issue: ref }) =>
      await run(async () => {
        const confirmed = await confirmSend(deps, ref, confirmation);

        const queued = confirmed.queued
          ? ""
          : " Starting it hit an error; the scheduled job will pick it up within 5 minutes.";

        return result(
          `Sending "${confirmed.issue.subject}" to ${number(confirmed.recipients)} subscribers.${queued} Check progress with send_status.`,
          presentIssue(confirmed.issue, { recipients: confirmed.recipients })
        );
      })
  );

  server.registerTool(
    "send_status",
    {
      annotations: READ_ONLY,
      description:
        "Progress of a send: sent, failed, skipped and remaining, plus deliveries, bounces, complaints and unsubscribes so far. For how an issue is doing (clicks, opens, rates, comparisons), use issue_stats.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Send status",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const status = await sendStatus(deps, ref);

        return result(
          describeStatus(status),
          presentIssue(status.issue, {
            counts: status.counts,
            delivered: status.delivered,
            events: status.events,
          })
        );
      })
  );

  server.registerTool(
    "cancel_send",
    {
      annotations: { destructiveHint: true },
      description:
        "Stop a send in progress. Emails already sent can't be recalled; everyone not yet sent to is skipped. The issue can't be sent again afterwards.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Cancel send",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const status = await cancelSend(deps, ref);

        return result(`Cancelled. ${describeStatus(status)}`);
      })
  );

  server.registerTool(
    "resume_send",
    {
      annotations: { openWorldHint: true },
      description:
        "Continue a send that stopped on an error (send_status shows why), after the cause is fixed. Runs the preflight checks first.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Resume send",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const { issue } = await resumeSend(deps, ref);

        return result(
          `Resumed sending "${issue.subject}". Check progress with send_status.`
        );
      })
  );
};
