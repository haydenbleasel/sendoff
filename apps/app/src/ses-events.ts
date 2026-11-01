import { and, eq, inArray, isNull, ne } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { z } from "zod";

import type { Database } from "./db/client";
import { events, issues, sends, subscribers } from "./db/schema";
import type { eventTypes } from "./db/schema";
import { normalizeEmail } from "./subscribers";

// Handles SES events published by the configuration set (via SNS). Hard
// bounces and complaints suppress the address; deliveries are noted on the
// send, for issue stats. Clicks and opens are tracked by Sendoff itself (see
// tracking.ts), not by SES.

const recipientSchema = z.object({ emailAddress: z.string() });

export const sesEventSchema = z.object({
  bounce: z
    .object({
      bounceSubType: z.string().optional(),
      bounceType: z.string(),
      bouncedRecipients: z.array(
        recipientSchema.extend({ diagnosticCode: z.string().optional() })
      ),
    })
    .optional(),
  complaint: z
    .object({
      complainedRecipients: z.array(recipientSchema),
      complaintFeedbackType: z.string().optional(),
    })
    .optional(),
  delivery: z.object({ timestamp: z.string().optional() }).optional(),
  // Configuration sets send `eventType`; identity notifications use `notificationType`.
  eventType: z.string().optional(),
  mail: z.object({
    destination: z.array(z.string()),
    messageId: z.string(),
    tags: z.record(z.string(), z.array(z.string())).optional(),
  }),
  notificationType: z.string().optional(),
  reject: z.object({ reason: z.string().optional() }).optional(),
});

export type SesEvent = z.infer<typeof sesEventSchema>;

type EventType = (typeof eventTypes)[number];

export interface HandledEvent {
  emails: string[];
  type: EventType | "delivery" | "ignored";
}

/** SES tags each email with the issue id; confirm it still exists before linking. */
const findIssueId = async (
  db: Database,
  event: SesEvent
): Promise<string | null> => {
  const sent = await db.query.sends.findFirst({
    columns: { issueId: true },
    where: eq(sends.messageId, event.mail.messageId),
  });

  if (sent) {
    return sent.issueId;
  }

  const tagged = event.mail.tags?.issue?.[0];

  if (!tagged) {
    return null;
  }

  const issue = await db.query.issues.findFirst({
    columns: { id: true },
    where: eq(issues.id, tagged),
  });

  return issue?.id ?? null;
};

interface Classified {
  detail: Record<string, string>;
  emails: string[];
  suppress?: "bounced" | "complained" | undefined;
  type: EventType | "ignored";
}

const classify = (event: SesEvent): Classified => {
  const kind = event.eventType ?? event.notificationType;

  if (kind === "Bounce" && event.bounce) {
    const hard = event.bounce.bounceType === "Permanent";

    return {
      detail: {
        bounceSubType: event.bounce.bounceSubType ?? "",
        bounceType: event.bounce.bounceType,
      },
      emails: event.bounce.bouncedRecipients.map((r) => r.emailAddress),
      suppress: hard ? "bounced" : undefined,
      type: "bounce",
    };
  }

  // "not-spam" feedback means the recipient rescued the email from spam.
  if (
    kind === "Complaint" &&
    event.complaint &&
    event.complaint.complaintFeedbackType !== "not-spam"
  ) {
    return {
      detail: { feedbackType: event.complaint.complaintFeedbackType ?? "" },
      emails: event.complaint.complainedRecipients.map((r) => r.emailAddress),
      suppress: "complained",
      type: "complaint",
    };
  }

  if (kind === "Reject") {
    return {
      detail: { reason: event.reject?.reason ?? "" },
      emails: event.mail.destination,
      type: "reject",
    };
  }

  return { detail: {}, emails: [], type: "ignored" };
};

/** One write per delivery, keyed on the message: no event row. */
const recordDelivery = async (
  db: Database,
  event: SesEvent,
  now: Date
): Promise<HandledEvent> => {
  const reported = new Date(event.delivery?.timestamp ?? "");
  const at = Number.isNaN(reported.getTime()) ? now : reported;

  const delivered = await db
    .update(sends)
    .set({ deliveredAt: at })
    .where(
      and(eq(sends.messageId, event.mail.messageId), isNull(sends.deliveredAt))
    )
    .returning({ subscriberId: sends.subscriberId });

  return delivered.length > 0
    ? {
        emails: event.mail.destination.map((email) => normalizeEmail(email)),
        type: "delivery",
      }
    : { emails: [], type: "ignored" };
};

/**
 * Apply one SES event. Idempotent: event rows are keyed on the SNS message
 * id, so redelivered notifications don't double count.
 */
export const handleSesEvent = async (
  db: Database,
  event: SesEvent,
  { now = new Date(), snsMessageId }: { now?: Date; snsMessageId: string }
): Promise<HandledEvent> => {
  if ((event.eventType ?? event.notificationType) === "Delivery") {
    return await recordDelivery(db, event, now);
  }

  const { detail, emails: rawEmails, suppress, type } = classify(event);

  if (type === "ignored" || rawEmails.length === 0) {
    return { emails: [], type: "ignored" };
  }

  const emails = [...new Set(rawEmails.map((email) => normalizeEmail(email)))];

  const [issueId, matched] = await Promise.all([
    findIssueId(db, event),
    db
      .select({ email: subscribers.email, id: subscribers.id })
      .from(subscribers)
      .where(inArray(subscribers.email, emails)),
  ]);

  const idByEmail = new Map(matched.map((row) => [row.email, row.id]));

  const eventRows = emails.map((email) => ({
    at: now,
    detail,
    id: `${snsMessageId}:${email}`,
    issueId,
    messageId: event.mail.messageId,
    subscriberId: idByEmail.get(email) ?? null,
    type,
  }));

  const [firstRow, ...otherRows] = eventRows;

  if (!firstRow) {
    return { emails: [], type: "ignored" };
  }

  const statements: BatchItem<"sqlite">[] = [
    db
      .insert(events)
      .values([firstRow, ...otherRows])
      .onConflictDoNothing(),
  ];

  if (suppress === "complained") {
    statements.push(
      db
        .update(subscribers)
        .set({ status: "complained" })
        .where(inArray(subscribers.email, emails))
    );
  } else if (suppress === "bounced") {
    // A complaint is the stronger signal; don't overwrite it.
    statements.push(
      db
        .update(subscribers)
        .set({ status: "bounced" })
        .where(
          and(
            inArray(subscribers.email, emails),
            ne(subscribers.status, "complained")
          )
        )
    );
  }

  const [first, ...rest] = statements;

  if (first) {
    await db.batch([first, ...rest]);
  }

  return { emails, type };
};
