import { and, count, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import { createSes } from "./config";
import type { Config } from "./config";
import type { Database } from "./db/client";
import { events, issues, sends, subscribers } from "./db/schema";
import type {
  IssuePromotionCheck,
  IssueSender,
  IssueTracking,
  sendStatuses,
} from "./db/schema";
import { formatChecks, runDoctor } from "./doctor";
import type { DoctorReport } from "./doctor";
import {
  TRACKING_TOKEN_PLACEHOLDER,
  personalize,
  renderIssue,
} from "./email/render";
import type { RenderedIssue } from "./email/render";
import { IssueError, requireIssue } from "./issues";
import type { Issue } from "./issues";
import {
  checkPromotion,
  createPromotionClassifier,
  describePromotion,
} from "./promotion";
import type { ClassifyPromotion } from "./promotion";
import { SesError } from "./ses";
import type { SesClient } from "./ses";
import { getSettings } from "./settings";
import type { Settings } from "./settings";
import { isValidEmail, normalizeEmail } from "./subscribers";
import {
  createSendConfirmation,
  createToken,
  verifySendConfirmation,
} from "./tokens";
import { TEST_TRACKING_TOKEN, addTracking } from "./tracking";

// Sending an issue: test, prepare, confirm, then a queue works through the
// recipients in chunks. Delivery is at-most-once per recipient: anything
// with an unknown outcome is reported, never retried.

const HEX = 16;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60_000;
const CONFIRMATION_TTL_MS = 15 * MS_PER_MINUTE;

/** Recipients claimed per queue message. Under D1's 100 bound parameters per query. */
export const CHUNK_SIZE = 50;

/** Workers allow six simultaneous outgoing connections. */
const MAX_PARALLEL = 6;

/** The cron restarts a send with no worker activity for this long. */
export const STALL_AFTER_MS = 5 * MS_PER_MINUTE;
const MAX_TEST_RECIPIENTS = 5;
const MAX_REPORTED_FAILURES = 5;
const THROTTLE_PAUSE_MS = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** SES errors that mean nothing more can be sent until someone fixes the account. */
const FATAL_SES_CODES = new Set([
  "AccessDeniedException",
  "AccountSuspendedException",
  "ConfigurationSetDoesNotExistException",
  "InvalidClientTokenId",
  "LimitExceededException",
  "MailFromDomainNotVerifiedException",
  // SendEmail's only resources are the configuration set and contact list,
  // so this is never about one recipient: SES v2 reports a missing
  // configuration set this way.
  "NotFoundException",
  "SendingPausedException",
  "SignatureDoesNotMatch",
  "UnrecognizedClientException",
]);

/** Rate limits: SES didn't take the email, so it's safe to try again shortly. */
const THROTTLED_SES_CODES = new Set([
  "Throttling",
  "ThrottlingException",
  "TooManyRequestsException",
]);

/** SES reports a used-up daily quota as throttling, but it won't clear for hours. */
const DAILY_QUOTA_EXCEEDED = /daily message quota exceeded/iu;

export const sendMessageSchema = z.object({
  issueId: z.string(),
  maxSendRate: z.number().positive(),
});

export type SendMessage = z.infer<typeof sendMessageSchema>;

export interface SendQueue {
  send: (message: SendMessage) => Promise<QueueSendResponse | undefined>;
}

export interface SendDeps {
  /** Injected in tests; defaults to Workers AI. */
  classifyPromotion?: ClassifyPromotion;
  config: Config;
  db: Database;
  now?: () => number;
  queue: SendQueue;
  ses?: SesClient;
  /** Injected in tests to skip real pacing delays. */
  sleep?: (ms: number) => Promise<void>;
}

const clock = (deps: SendDeps) => deps.now?.() ?? Date.now();
const sesFor = (deps: SendDeps) => deps.ses ?? createSes(deps.config);

const classifierFor = (deps: SendDeps): ClassifyPromotion =>
  deps.classifyPromotion ?? createPromotionClassifier(deps.config.ai);

export type PromotionResult =
  | { check: IssuePromotionCheck; status: "checked" }
  | { error: string; status: "failed" }
  | { status: "skipped" };

/**
 * Without a postal address, judge whether the issue is commercial email. A
 * model that can't be reached doesn't block a send; the warning says so.
 */
export const promotionFor = async (
  deps: SendDeps,
  issue: Issue,
  settings: Settings
): Promise<PromotionResult> => {
  if (settings.address) {
    return { status: "skipped" };
  }

  try {
    return {
      check: await checkPromotion(
        deps.db,
        issue,
        classifierFor(deps),
        new Date(clock(deps))
      ),
      status: "checked",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: "failed",
    };
  }
};

/** Run the promotion check on demand, address or not. */
export const runPromotionCheck = async (
  deps: SendDeps,
  ref: string
): Promise<{ check: IssuePromotionCheck; issue: Issue }> => {
  const issue = await requireIssue(deps.db, ref);

  if (issue.importedAt) {
    throw new IssueError(
      `"${issue.subject}" was imported, so there's nothing to check before sending.`
    );
  }

  const check = await checkPromotion(
    deps.db,
    issue,
    classifierFor(deps),
    new Date(clock(deps))
  );

  return { check, issue };
};

const pause = async (deps: SendDeps, ms: number) =>
  await (deps.sleep ?? ((delay: number) => scheduler.wait(delay)))(ms);

const content = (issue: Issue) => ({
  body: issue.body,
  preheader: issue.preheader ?? undefined,
  subject: issue.subject,
});

/** Identifies what a send would look like: the issue's content plus every setting that shapes the email. */
export const sendFingerprint = async (
  issue: Issue,
  settings: Settings
): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([issue.contentHash, settings]))
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX).padStart(2, "0"))
    .join("");
};

const requireSettings = async (db: Database): Promise<Settings> => {
  const settings = await getSettings(db);

  if (!settings) {
    throw new IssueError("Set up Sendoff with update_settings first.");
  }

  return settings;
};

const requireRendered = async (
  issue: Issue,
  settings: Settings
): Promise<RenderedIssue> => {
  const rendered = await renderIssue(content(issue), settings);

  if (!rendered.ok) {
    throw new IssueError(
      `The draft can't render: ${rendered.problems.map((problem) => `line ${problem.line}: ${problem.message}`).join("; ")}`
    );
  }

  return rendered;
};

const requireDraftStatus = (issue: Issue): void => {
  if (issue.status !== "draft") {
    throw new IssueError(
      `"${issue.subject}" is ${issue.status}; only drafts can be sent.`
    );
  }
};

// --- Test sends -----------------------------------------------------------

export interface TestSendResult {
  issue: Issue;
  to: string[];
}

/** Send the current version to a few addresses and record what was tested. */
export const sendTest = async (
  deps: SendDeps,
  ref: string,
  recipients?: string[]
): Promise<TestSendResult> => {
  const { config, db } = deps;
  const issue = await requireIssue(db, ref);
  requireDraftStatus(issue);

  const settings = await requireSettings(db);

  const to = [
    ...new Set(
      (recipients?.length
        ? recipients
        : [settings.replyTo ?? settings.from.email]
      ).map((email) => normalizeEmail(email))
    ),
  ];

  if (to.length > MAX_TEST_RECIPIENTS) {
    throw new IssueError(
      `Send tests to at most ${MAX_TEST_RECIPIENTS} addresses.`
    );
  }

  const invalid = to.filter((email) => !isValidEmail(email));

  if (invalid.length > 0) {
    throw new IssueError(`Not valid email addresses: ${invalid.join(", ")}`);
  }

  const rendered = await requireRendered(issue, settings);

  // Tracked like the real send, but the links aren't anyone's: the unsubscribe
  // link goes nowhere, and clicks and opens aren't recorded.
  const email = personalize(
    {
      html: await addTracking(rendered.html, {
        issueId: issue.id,
        publicUrl: config.publicUrl,
        secret: config.tokenSecret,
        tracking: settings.tracking,
      }),
      text: rendered.text,
    },
    {
      trackingToken: TEST_TRACKING_TOKEN,
      unsubscribeUrl: `${config.publicUrl}/unsubscribe/test`,
    }
  );

  const ses = sesFor(deps);

  for (const address of to) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of addresses, sent in order
    await ses.sendEmail({
      configurationSet: config.sesConfigurationSet,
      from: settings.from,
      html: email.html,
      replyTo: settings.replyTo,
      subject: `[Test] ${issue.subject}`,
      tags: { issue: issue.id, type: "test" },
      text: email.text,
      to: address,
    });
  }

  const [updated] = await db
    .update(issues)
    .set({
      testSentAt: new Date(clock(deps)),
      testSentHash: await sendFingerprint(issue, settings),
    })
    .where(eq(issues.id, issue.id))
    .returning();

  return { issue: updated ?? issue, to };
};

// --- Prepare and confirm ----------------------------------------------------

export interface PreparedSend {
  confirmation: string;
  expiresAt: number;
  issue: Issue;
  maxSendRate: number;
  promotion: PromotionResult;
  recipients: number;
  report: DoctorReport;
  settings: Settings;
}

/** Everything that must be true to send, checked without sending anything. */
export const prepareSend = async (
  deps: SendDeps,
  ref: string
): Promise<PreparedSend> => {
  const { config, db } = deps;
  const issue = await requireIssue(db, ref);
  requireDraftStatus(issue);

  const settings = await requireSettings(db);
  await requireRendered(issue, settings);

  if (!issue.subject.trim()) {
    throw new IssueError("The draft needs a subject before it can be sent.");
  }

  const fingerprint = await sendFingerprint(issue, settings);

  if (!issue.testSentHash) {
    throw new IssueError(
      "Send a test with send_test first, and check it in a real inbox."
    );
  }

  if (issue.testSentHash !== fingerprint) {
    throw new IssueError(
      "The draft or settings changed since the last test. Send another test with send_test first."
    );
  }

  const report = await runDoctor({ config, db });

  if (!report.ok || !report.account) {
    throw new IssueError(
      `Preflight checks failed, so this can't be sent yet:\n${formatChecks(report.checks)}`
    );
  }

  const promotion = await promotionFor(deps, issue, settings);

  if (
    promotion.status === "checked" &&
    promotion.check.verdict === "commercial"
  ) {
    throw new IssueError(
      `${describePromotion(promotion.check)}\n\nThere's no postal address in your settings, so it can't be sent as it is. Either add one with update_settings (a street address, a PO box or a private mailbox), or change the issue so promotion isn't its main purpose, then send another test.`
    );
  }

  const expiresAt = clock(deps) + CONFIRMATION_TTL_MS;

  return {
    confirmation: await createSendConfirmation(
      config.tokenSecret,
      issue.id,
      fingerprint,
      expiresAt
    ),
    expiresAt,
    issue,
    maxSendRate: report.account.maxSendRate,
    promotion,
    recipients: report.activeSubscribers,
    report,
    settings,
  };
};

export interface ConfirmedSend {
  issue: Issue;
  queued: boolean;
  recipients: number;
}

/** Snapshot the recipients and start sending. Only valid with a fresh confirmation from prepareSend. */
export const confirmSend = async (
  deps: SendDeps,
  ref: string,
  confirmation: string
): Promise<ConfirmedSend> => {
  const { config, db } = deps;
  const issue = await requireIssue(db, ref);
  requireDraftStatus(issue);

  const settings = await requireSettings(db);
  const now = clock(deps);

  const check = await verifySendConfirmation(config.tokenSecret, {
    fingerprint: await sendFingerprint(issue, settings),
    issueId: issue.id,
    now,
    token: confirmation,
  });

  if (check === "expired") {
    throw new IssueError(
      "The confirmation expired. Run prepare_send again and confirm with the person."
    );
  }

  if (check === "invalid") {
    throw new IssueError(
      "That confirmation doesn't match this issue as it is now (it may have changed since prepare_send). Run prepare_send again."
    );
  }

  const rendered = await requireRendered(issue, settings);
  const account = await sesFor(deps).getAccount();
  const startedAt = new Date(now);

  const sender: IssueSender = {
    from: settings.from,
    replyTo: settings.replyTo,
  };

  const tracking: IssueTracking = { ...settings.tracking };

  const renderedHtml = await addTracking(rendered.html, {
    issueId: issue.id,
    publicUrl: config.publicUrl,
    secret: config.tokenSecret,
    tracking,
  });

  // One transaction: claim the issue, snapshot active subscribers, count them.
  await db.batch([
    db
      .update(issues)
      .set({
        renderedHtml,
        renderedText: rendered.text,
        sendError: null,
        sendHeartbeatAt: startedAt,
        sendStartedAt: startedAt,
        sender,
        status: "sending",
        tracking,
      })
      .where(
        and(
          eq(issues.id, issue.id),
          eq(issues.status, "draft"),
          eq(issues.version, issue.version)
        )
      ),
    db
      .insert(sends)
      .select(
        db
          // Every column of sends, in table order (Drizzle requires it).
          .select({
            deliveredAt: sql<null>`NULL`.as("delivered_at"),
            error: sql<null>`NULL`.as("error"),
            issueId: sql<string>`${issue.id}`.as("issue_id"),
            messageId: sql<null>`NULL`.as("message_id"),
            sentAt: sql<null>`NULL`.as("sent_at"),
            status: sql<"queued">`'queued'`.as("status"),
            subscriberId: subscribers.id,
          })
          .from(subscribers)
          .where(
            and(
              eq(subscribers.status, "active"),
              // Only if the update above claimed the issue for this confirmation.
              sql`EXISTS (SELECT 1 FROM issues WHERE id = ${issue.id} AND status = 'sending' AND send_started_at = ${now})`
            )
          )
      )
      .onConflictDoNothing(),
    db
      .update(issues)
      .set({
        recipientCount: sql`(SELECT count(*) FROM sends WHERE issue_id = ${issue.id})`,
      })
      .where(eq(issues.id, issue.id)),
  ]);

  const started = await requireIssue(db, issue.id);

  if (
    started.status !== "sending" ||
    started.sendStartedAt?.getTime() !== now
  ) {
    throw new IssueError(
      "The issue changed while confirming. Run prepare_send again."
    );
  }

  let queued = true;

  try {
    await deps.queue.send({
      issueId: issue.id,
      maxSendRate: account.maxSendRate,
    });
  } catch (error) {
    // The cron restarts stalled sends, so this delays the send rather than losing it.
    console.error("Failed to queue the first send chunk", error);
    queued = false;
  }

  return { issue: started, queued, recipients: started.recipientCount ?? 0 };
};

// --- The send worker ----------------------------------------------------------

type Outcome =
  | { kind: "sent"; messageId: string }
  | { error: string; kind: "failed" }
  | { kind: "throttled" }
  | { error: string; kind: "fatal" };

const classify = (error: Error): Outcome => {
  if (error instanceof SesError) {
    if (DAILY_QUOTA_EXCEEDED.test(error.message)) {
      return { error: error.message, kind: "fatal" };
    }

    if (
      error.status === HTTP_TOO_MANY_REQUESTS ||
      THROTTLED_SES_CODES.has(error.code)
    ) {
      return { kind: "throttled" };
    }

    if (
      FATAL_SES_CODES.has(error.code) ||
      error.status === HTTP_UNAUTHORIZED ||
      error.status === HTTP_FORBIDDEN
    ) {
      return { error: error.message, kind: "fatal" };
    }

    return { error: error.message, kind: "failed" };
  }

  // A network error: SES may or may not have accepted it. Never retry.
  return {
    error: `Unknown outcome, not retried: ${error.message}`,
    kind: "failed",
  };
};

const unsubscribeUrl = async (
  config: Config,
  issueId: string,
  subscriberId: string
) =>
  `${config.publicUrl}/unsubscribe/${await createToken(config.tokenSecret, "unsubscribe", subscriberId)}?issue=${encodeURIComponent(issueId)}`;

const remaining = async (
  db: Database,
  issueId: string,
  status: (typeof sendStatuses)[number]
) => {
  const [row] = await db
    .select({ value: count() })
    .from(sends)
    .where(and(eq(sends.issueId, issueId), eq(sends.status, status)));

  return row?.value ?? 0;
};

/**
 * Mark the issue sent once nothing is queued. Rows still "sending" here were
 * claimed by a worker that crashed mid-chunk: their outcome is unknown, so
 * they're reported as failed rather than sent again.
 */
const finishIfDone = async (
  deps: SendDeps,
  issueId: string
): Promise<boolean> => {
  const { db } = deps;

  if ((await remaining(db, issueId, "queued")) > 0) {
    return false;
  }

  const now = new Date(clock(deps));

  await db.batch([
    db
      .update(sends)
      .set({
        error:
          "Unknown outcome: the send worker stopped mid-chunk. Not retried.",
        status: "failed",
      })
      .where(and(eq(sends.issueId, issueId), eq(sends.status, "sending"))),
    db
      .update(issues)
      .set({ sendHeartbeatAt: now, sentAt: now, status: "sent" })
      .where(and(eq(issues.id, issueId), eq(issues.status, "sending"))),
  ]);

  return true;
};

export interface ChunkResult {
  failed: number;
  finished: boolean;
  sent: number;
  stopped?: string;
}

/** Process one queue message: claim up to CHUNK_SIZE recipients, send, record, chain the next chunk. */
export const processSendChunk = async (
  deps: SendDeps,
  message: SendMessage
): Promise<ChunkResult> => {
  const { config, db } = deps;
  const result: ChunkResult = { failed: 0, finished: false, sent: 0 };

  const issue = await db.query.issues.findFirst({
    where: eq(issues.id, message.issueId),
  });

  // Cancelled, already finished, or stopped on an error: nothing to do.
  if (
    !issue ||
    issue.status !== "sending" ||
    issue.sendError ||
    !issue.renderedHtml ||
    !issue.sender
  ) {
    return { ...result, finished: true };
  }

  const rendered: RenderedIssue = {
    html: issue.renderedHtml,
    text: issue.renderedText ?? "",
  };

  const { sender } = issue;
  const tracked = rendered.html.includes(TRACKING_TOKEN_PLACEHOLDER);

  await db.batch([
    db
      .update(issues)
      .set({ sendHeartbeatAt: new Date(clock(deps)) })
      .where(eq(issues.id, issue.id)),
    // Anyone who unsubscribed, bounced or complained since the send started.
    db
      .update(sends)
      .set({ status: "skipped" })
      .where(
        and(
          eq(sends.issueId, issue.id),
          eq(sends.status, "queued"),
          inArray(
            sends.subscriberId,
            db
              .select({ id: subscribers.id })
              .from(subscribers)
              .where(sql`${subscribers.status} != 'active'`)
          )
        )
      ),
  ]);

  // Claim atomically; a crashed worker's claimed rows are never reclaimed.
  const claimed = await db
    .update(sends)
    .set({ status: "sending" })
    .where(
      and(
        eq(sends.issueId, issue.id),
        eq(sends.status, "queued"),
        inArray(
          sends.subscriberId,
          db
            .select({ id: sends.subscriberId })
            .from(sends)
            .where(and(eq(sends.issueId, issue.id), eq(sends.status, "queued")))
            .limit(CHUNK_SIZE)
        )
      )
    )
    .returning({ subscriberId: sends.subscriberId });

  if (claimed.length === 0) {
    return { ...result, finished: await finishIfDone(deps, issue.id) };
  }

  const recipients = await db
    .select({ email: subscribers.email, id: subscribers.id })
    .from(subscribers)
    .where(
      inArray(
        subscribers.id,
        claimed.map((row) => row.subscriberId)
      )
    );

  const ses = sesFor(deps);

  const groupSize = Math.max(
    1,
    Math.min(MAX_PARALLEL, Math.floor(message.maxSendRate))
  );

  const requeue: string[] = [];

  for (let start = 0; start < recipients.length; start += groupSize) {
    const group = recipients.slice(start, start + groupSize);
    const groupStarted = Date.now();

    // oxlint-disable-next-line no-await-in-loop -- groups are paced to the SES send rate
    const outcomes = await Promise.all(
      group.map(async (recipient): Promise<Outcome> => {
        try {
          const url = await unsubscribeUrl(config, issue.id, recipient.id);

          const trackingToken = tracked
            ? await createToken(config.tokenSecret, "track", recipient.id)
            : "";

          const email = personalize(rendered, {
            trackingToken,
            unsubscribeUrl: url,
          });

          const { messageId } = await ses.sendEmail({
            configurationSet: config.sesConfigurationSet,
            from: sender.from,
            headers: {
              "List-Unsubscribe": `<${url}>`,
              "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
            },
            html: email.html,
            replyTo: sender.replyTo,
            subject: issue.subject,
            tags: { issue: issue.id },
            text: email.text,
            to: recipient.email,
          });

          return { kind: "sent", messageId };
        } catch (error) {
          return classify(
            error instanceof Error ? error : new Error(String(error))
          );
        }
      })
    );

    const now = new Date(clock(deps));

    const updates = group.flatMap((recipient, index) => {
      const outcome = outcomes[index];

      const where = and(
        eq(sends.issueId, issue.id),
        eq(sends.subscriberId, recipient.id)
      );

      if (outcome?.kind === "sent") {
        result.sent += 1;

        return [
          db
            .update(sends)
            .set({ messageId: outcome.messageId, sentAt: now, status: "sent" })
            .where(where),
        ];
      }

      if (outcome?.kind === "failed") {
        result.failed += 1;

        return [
          db
            .update(sends)
            .set({ error: outcome.error, status: "failed" })
            .where(where),
        ];
      }

      // Throttled or stopped: SES didn't take it, so it's safe to try again later.
      requeue.push(recipient.id);

      return [];
    });

    const [first, ...rest] = updates;

    if (first) {
      // oxlint-disable-next-line no-await-in-loop -- record each group before sending the next
      await db.batch([first, ...rest]);
    }

    const fatal = outcomes.find((outcome) => outcome.kind === "fatal");

    if (fatal?.kind === "fatal") {
      result.stopped = fatal.error;
      requeue.push(
        ...recipients.slice(start + groupSize).map((recipient) => recipient.id)
      );
      break;
    }

    const elapsed = Date.now() - groupStarted;
    const minimum = (group.length / message.maxSendRate) * MS_PER_SECOND;
    const throttled = outcomes.some((outcome) => outcome.kind === "throttled");
    const wait = Math.max(minimum - elapsed, throttled ? THROTTLE_PAUSE_MS : 0);

    if (wait > 0) {
      // oxlint-disable-next-line no-await-in-loop -- pacing
      await pause(deps, wait);
    }
  }

  const finish: BatchItem<"sqlite">[] = [
    db
      .update(issues)
      .set({
        sendError: result.stopped ?? null,
        sendHeartbeatAt: new Date(clock(deps)),
      })
      .where(eq(issues.id, issue.id)),
  ];

  if (requeue.length > 0) {
    finish.push(
      db
        .update(sends)
        .set({ status: "queued" })
        .where(
          and(eq(sends.issueId, issue.id), inArray(sends.subscriberId, requeue))
        )
    );
  }

  const [firstStatement, ...otherStatements] = finish;

  if (firstStatement) {
    await db.batch([firstStatement, ...otherStatements]);
  }

  if (result.stopped) {
    return result;
  }

  if ((await remaining(db, issue.id, "queued")) > 0) {
    await deps.queue.send(message);

    return result;
  }

  return { ...result, finished: await finishIfDone(deps, issue.id) };
};

// --- Status, cancel, resume -------------------------------------------------

export interface SendStatus {
  counts: Record<(typeof sendStatuses)[number], number>;
  /** Sends SES has reported as accepted by the receiving server. */
  delivered: number;
  events: {
    bounce: number;
    complaint: number;
    unsubscribe: number;
  };
  failures: { email: string; error: string | null }[];
  issue: Issue;
  stalled: boolean;
}

export const sendStatus = async (
  deps: SendDeps,
  ref: string
): Promise<SendStatus> => {
  const { db } = deps;
  const issue = await requireIssue(db, ref);

  if (issue.importedAt) {
    throw new IssueError(
      `"${issue.subject}" was imported from another provider, so Sendoff didn't send it and has no progress to show.`
    );
  }

  const [sendRows, eventRows, failures] = await Promise.all([
    db
      .select({
        delivered: count(sends.deliveredAt),
        status: sends.status,
        value: count(),
      })
      .from(sends)
      .where(eq(sends.issueId, issue.id))
      .groupBy(sends.status),
    db
      .select({ type: events.type, value: count() })
      .from(events)
      .where(eq(events.issueId, issue.id))
      .groupBy(events.type),
    db
      .select({ email: subscribers.email, error: sends.error })
      .from(sends)
      .innerJoin(subscribers, eq(subscribers.id, sends.subscriberId))
      .where(and(eq(sends.issueId, issue.id), eq(sends.status, "failed")))
      .limit(MAX_REPORTED_FAILURES),
  ]);

  const counts = { failed: 0, queued: 0, sending: 0, sent: 0, skipped: 0 };
  let delivered = 0;

  for (const row of sendRows) {
    counts[row.status] = row.value;
    delivered += row.delivered;
  }

  const eventCounts = { bounce: 0, complaint: 0, unsubscribe: 0 };

  for (const row of eventRows) {
    if (
      row.type === "bounce" ||
      row.type === "complaint" ||
      row.type === "unsubscribe"
    ) {
      eventCounts[row.type] = row.value;
    }
  }

  const heartbeat = issue.sendHeartbeatAt?.getTime() ?? 0;

  return {
    counts,
    delivered,
    events: eventCounts,
    failures,
    issue,
    stalled:
      issue.status === "sending" &&
      !issue.sendError &&
      clock(deps) - heartbeat > STALL_AFTER_MS,
  };
};

export const cancelSend = async (
  deps: SendDeps,
  ref: string
): Promise<SendStatus> => {
  const { db } = deps;
  const issue = await requireIssue(db, ref);

  if (issue.status !== "sending") {
    throw new IssueError(
      `"${issue.subject}" is ${issue.status}, not sending, so there's nothing to cancel.`
    );
  }

  await db.batch([
    db
      .update(issues)
      .set({ cancelledAt: new Date(clock(deps)), status: "cancelled" })
      .where(and(eq(issues.id, issue.id), eq(issues.status, "sending"))),
    db
      .update(sends)
      .set({ status: "skipped" })
      .where(and(eq(sends.issueId, issue.id), eq(sends.status, "queued"))),
  ]);

  return await sendStatus(deps, issue.id);
};

/** Continue a send that stopped on an error, once the preflight checks pass again. */
export const resumeSend = async (
  deps: SendDeps,
  ref: string
): Promise<{ issue: Issue; report: DoctorReport }> => {
  const { config, db } = deps;
  const issue = await requireIssue(db, ref);

  if (issue.status !== "sending") {
    throw new IssueError(
      `"${issue.subject}" is ${issue.status}, so there's nothing to resume.`
    );
  }

  const heartbeat = issue.sendHeartbeatAt?.getTime() ?? 0;
  const stalled = clock(deps) - heartbeat > STALL_AFTER_MS;

  // A second queue chain on a healthy send would only double its pace.
  if (!issue.sendError && !stalled) {
    throw new IssueError(
      `"${issue.subject}" is still sending, so there's nothing to resume. Check progress with send_status.`
    );
  }

  const report = await runDoctor({
    config,
    db,
    toSend: await remaining(db, issue.id, "queued"),
  });

  if (!report.ok || !report.account) {
    throw new IssueError(
      `Fix these before resuming:\n${formatChecks(report.checks)}`
    );
  }

  await db
    .update(issues)
    .set({ sendError: null, sendHeartbeatAt: new Date(clock(deps)) })
    .where(eq(issues.id, issue.id));
  await deps.queue.send({
    issueId: issue.id,
    maxSendRate: report.account.maxSendRate,
  });

  return { issue: await requireIssue(db, issue.id), report };
};

/** Cron: restart sends whose queue chain went quiet (a lost or failed message). */
export const resumeStalledSends = async (deps: SendDeps): Promise<string[]> => {
  const { db } = deps;
  const cutoff = new Date(clock(deps) - STALL_AFTER_MS);

  const stalled = await db
    .select({ id: issues.id })
    .from(issues)
    .where(
      and(
        eq(issues.status, "sending"),
        isNull(issues.sendError),
        or(isNull(issues.sendHeartbeatAt), lt(issues.sendHeartbeatAt, cutoff))
      )
    );

  if (stalled.length === 0) {
    return [];
  }

  const { maxSendRate } = await sesFor(deps).getAccount();
  const restarted: string[] = [];

  for (const { id } of stalled) {
    // oxlint-disable-next-line no-await-in-loop -- rare, and usually a single issue
    if (!(await finishIfDone(deps, id))) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await db
        .update(issues)
        .set({ sendHeartbeatAt: new Date(clock(deps)) })
        .where(eq(issues.id, id));
      // oxlint-disable-next-line no-await-in-loop -- see above
      await deps.queue.send({ issueId: id, maxSendRate });
      restarted.push(id);
    }
  }

  return restarted;
};
