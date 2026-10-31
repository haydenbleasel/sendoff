import { and, count, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./db/client";
import { events, subscribers } from "./db/schema";
import type { subscriberSources, subscriberStatuses } from "./db/schema";
import { createId } from "./id";

export type Subscriber = typeof subscribers.$inferSelect;

export type SubscriberStatus = (typeof subscriberStatuses)[number];

export type SubscriberSource = (typeof subscriberSources)[number];

/** Don't resend a confirmation email to the same address more often than this. */
export const CONFIRMATION_COOLDOWN_MS = 10 * 60 * 1000;

// D1 allows 100 bound parameters per statement; a batch is one query.
const IMPORT_BATCH_SIZE = 500;
const MAX_REPORTED_INVALID = 20;

const SUPPRESSED: ReadonlySet<SubscriberStatus> = new Set([
  "unsubscribed",
  "bounced",
  "complained",
]);

const emailSchema = z.email();

export const normalizeEmail = (email: string): string =>
  email.trim().toLowerCase();

export const isValidEmail = (email: string): boolean =>
  emailSchema.safeParse(email).success;

export const findSubscriberByEmail = async (
  db: Database,
  email: string
): Promise<Subscriber | undefined> =>
  await db.query.subscribers.findFirst({
    where: eq(subscribers.email, normalizeEmail(email)),
  });

export const findSubscriberById = async (
  db: Database,
  id: string
): Promise<Subscriber | undefined> =>
  await db.query.subscribers.findFirst({ where: eq(subscribers.id, id) });

export type SubscribeOutcome =
  /** Send a double opt-in email. */
  | "send_confirmation"
  /** A confirmation went out recently; don't send another. */
  | "recently_sent"
  | "already_active"
  /** Bounced or complained: never email again from a form signup. */
  | "suppressed";

export interface SubscribeInput {
  email: string;
  name?: string | undefined;
  now?: Date;
  source: SubscriberSource;
}

/**
 * Record a signup. The caller sends the confirmation email when the outcome
 * says so, then calls `markConfirmationSent`. Every outcome looks the same to
 * the person signing up, so the form can't be used to probe the list.
 */
export const subscribe = async (
  db: Database,
  { email, name, now = new Date(), source }: SubscribeInput
): Promise<{ outcome: SubscribeOutcome; subscriber: Subscriber }> => {
  const normalized = normalizeEmail(email);
  const existing = await findSubscriberByEmail(db, normalized);

  if (!existing) {
    const [created] = await db
      .insert(subscribers)
      .values({
        email: normalized,
        id: createId(now.getTime()),
        name: name ?? null,
        source,
        status: "pending",
      })
      .returning();

    if (!created) {
      throw new Error(`Failed to create subscriber for ${normalized}`);
    }

    return { outcome: "send_confirmation", subscriber: created };
  }

  if (existing.status === "active") {
    return { outcome: "already_active", subscriber: existing };
  }

  if (existing.status === "bounced" || existing.status === "complained") {
    return { outcome: "suppressed", subscriber: existing };
  }

  const sentAt = existing.confirmationSentAt?.getTime() ?? 0;
  const recentlySent = now.getTime() - sentAt < CONFIRMATION_COOLDOWN_MS;

  // Pending, or unsubscribed and signing up again: confirm (again).
  const [updated] = await db
    .update(subscribers)
    .set({ name: name ?? existing.name, status: "pending" })
    .where(eq(subscribers.id, existing.id))
    .returning();

  return {
    outcome: recentlySent ? "recently_sent" : "send_confirmation",
    subscriber: updated ?? existing,
  };
};

export const markConfirmationSent = async (
  db: Database,
  id: string,
  now: Date = new Date()
): Promise<void> => {
  await db
    .update(subscribers)
    .set({ confirmationSentAt: now })
    .where(eq(subscribers.id, id));
};

export type ConfirmOutcome = "confirmed" | "already_active" | "not_pending";

/** Only a pending subscriber can be confirmed; an old link can't undo an unsubscribe. */
export const confirmSubscriber = async (
  db: Database,
  id: string,
  now: Date = new Date()
): Promise<ConfirmOutcome> => {
  const [confirmed] = await db
    .update(subscribers)
    .set({ confirmedAt: now, status: "active" })
    .where(and(eq(subscribers.id, id), eq(subscribers.status, "pending")))
    .returning({ id: subscribers.id });

  if (confirmed) {
    return "confirmed";
  }

  const existing = await findSubscriberById(db, id);

  return existing?.status === "active" ? "already_active" : "not_pending";
};

/**
 * Unsubscribe and record an event (attributed to an issue when the link came
 * from one). Idempotent; bounced and complained addresses keep their status.
 */
export const unsubscribeSubscriber = async (
  db: Database,
  id: string,
  {
    issueId,
    now = new Date(),
  }: { issueId?: string | undefined; now?: Date } = {}
): Promise<Subscriber | undefined> => {
  const existing = await findSubscriberById(db, id);

  if (!existing) {
    return undefined;
  }

  if (existing.status === "active" || existing.status === "pending") {
    await db.batch([
      db
        .update(subscribers)
        .set({ status: "unsubscribed", unsubscribedAt: now })
        .where(eq(subscribers.id, id)),
      db.insert(events).values({
        at: now,
        id: createId(now.getTime()),
        issueId: issueId ?? null,
        subscriberId: id,
        type: "unsubscribe",
      }),
    ]);

    return { ...existing, status: "unsubscribed", unsubscribedAt: now };
  }

  return existing;
};

/** Undo an unsubscribe from the link in an email (which proves inbox access). */
export const resubscribeSubscriber = async (
  db: Database,
  id: string
): Promise<boolean> => {
  const [updated] = await db
    .update(subscribers)
    .set({ status: "active", unsubscribedAt: null })
    .where(and(eq(subscribers.id, id), eq(subscribers.status, "unsubscribed")))
    .returning({ id: subscribers.id });

  return updated !== undefined;
};

export type ImportStatus = Exclude<SubscriberStatus, "pending">;

export interface ImportRow {
  email: string;
  name?: string | undefined;
  status: ImportStatus;
}

export interface ImportSummary {
  created: number;
  /** Up to 20 invalid addresses, for reporting back. */
  invalid: string[];
  invalidCount: number;
  /** Existing subscribers newly suppressed because the source had them unsubscribed, bounced or complained. */
  suppressed: number;
  total: number;
  unchanged: number;
}

const dedupe = (rows: ImportRow[]) => {
  const byEmail = new Map<string, ImportRow>();
  const invalid: string[] = [];

  for (const row of rows) {
    const email = normalizeEmail(row.email);

    if (!isValidEmail(email)) {
      invalid.push(row.email);
      continue;
    }

    const previous = byEmail.get(email);

    // If the source lists an address twice, a suppression wins.
    const keepPrevious =
      previous !== undefined &&
      SUPPRESSED.has(previous.status) &&
      !SUPPRESSED.has(row.status);

    if (!keepPrevious) {
      byEmail.set(email, { ...row, email });
    }
  }

  return { invalid, rows: [...byEmail.values()] };
};

/**
 * Import subscribers from another provider. Imported active subscribers are
 * treated as already confirmed. Imports can suppress an existing subscriber
 * but never reactivate a suppressed one.
 */
export const importSubscribers = async (
  db: Database,
  input: ImportRow[],
  { dryRun = false, now = new Date() }: { dryRun?: boolean; now?: Date } = {}
): Promise<ImportSummary> => {
  const { invalid, rows } = dedupe(input);

  const current = await db
    .select({
      email: subscribers.email,
      id: subscribers.id,
      status: subscribers.status,
    })
    .from(subscribers);

  const existing = new Map(
    current.map((subscriber) => [subscriber.email, subscriber])
  );

  const inserts: (typeof subscribers.$inferInsert)[] = [];
  const toSuppress = new Map<ImportStatus, string[]>();
  let unchanged = 0;

  for (const row of rows) {
    const match = existing.get(row.email);

    if (!match) {
      inserts.push({
        confirmedAt: row.status === "active" ? now : null,
        email: row.email,
        id: createId(now.getTime()),
        name: row.name ?? null,
        source: "import",
        status: row.status,
        unsubscribedAt: row.status === "unsubscribed" ? now : null,
      });
    } else if (SUPPRESSED.has(row.status) && !SUPPRESSED.has(match.status)) {
      toSuppress.set(row.status, [
        ...(toSuppress.get(row.status) ?? []),
        match.id,
      ]);
    } else {
      unchanged += 1;
    }
  }

  const statements = [
    ...inserts.map((values) =>
      db.insert(subscribers).values(values).onConflictDoNothing()
    ),
    ...[...toSuppress.entries()].flatMap(([status, ids]) =>
      ids.map((id) =>
        db
          .update(subscribers)
          .set({
            status,
            unsubscribedAt: status === "unsubscribed" ? now : undefined,
          })
          .where(
            and(
              eq(subscribers.id, id),
              inArray(subscribers.status, ["active", "pending"])
            )
          )
      )
    ),
  ];

  const batches = dryRun ? 0 : statements.length;

  for (let start = 0; start < batches; start += IMPORT_BATCH_SIZE) {
    const [first, ...rest] = statements.slice(start, start + IMPORT_BATCH_SIZE);

    if (first) {
      // oxlint-disable-next-line no-await-in-loop -- batches must run in order
      await db.batch([first, ...rest]);
    }
  }

  let suppressed = 0;

  for (const ids of toSuppress.values()) {
    suppressed += ids.length;
  }

  return {
    created: inserts.length,
    invalid: invalid.slice(0, MAX_REPORTED_INVALID),
    invalidCount: invalid.length,
    suppressed,
    total: input.length,
    unchanged,
  };
};

export type StatusCounts = Record<SubscriberStatus, number> & { total: number };

export const countSubscribers = async (db: Database): Promise<StatusCounts> => {
  const rows = await db
    .select({ count: count(), status: subscribers.status })
    .from(subscribers)
    .groupBy(subscribers.status);

  const counts: StatusCounts = {
    active: 0,
    bounced: 0,
    complained: 0,
    pending: 0,
    total: 0,
    unsubscribed: 0,
  };

  for (const row of rows) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }

  return counts;
};

const MAX_SEARCH_LENGTH = 100;

/** Newest first, paginated by id (UUIDv7, so ids sort by creation time). */
export const searchSubscribers = async (
  db: Database,
  {
    cursor,
    limit = 50,
    query,
    status,
  }: {
    cursor?: string | undefined;
    limit?: number;
    query?: string | undefined;
    status?: SubscriberStatus | undefined;
  } = {}
): Promise<{ nextCursor: string | undefined; subscribers: Subscriber[] }> => {
  const needle = query?.trim().toLowerCase().slice(0, MAX_SEARCH_LENGTH);

  const rows = await db
    .select()
    .from(subscribers)
    .where(
      and(
        // A plain substring match: instr() has no wildcards to escape.
        needle ? sql`instr(${subscribers.email}, ${needle}) > 0` : undefined,
        status ? eq(subscribers.status, status) : undefined,
        cursor ? lt(subscribers.id, cursor) : undefined
      )
    )
    .orderBy(desc(subscribers.id))
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  return {
    nextCursor: rows.length > limit ? page.at(-1)?.id : undefined,
    subscribers: page,
  };
};
