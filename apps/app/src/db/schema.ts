import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type JsonObject = Record<string, JsonValue>;

export const subscriberStatuses = [
  "pending",
  "active",
  "unsubscribed",
  "bounced",
  "complained",
] as const;

export const subscriberSources = ["import", "form", "mcp"] as const;

export const issueStatuses = ["draft", "sending", "sent", "cancelled"] as const;

export const sendStatuses = [
  "queued",
  "sending",
  "sent",
  "failed",
  "skipped",
] as const;

export const eventTypes = [
  "bounce",
  "complaint",
  "reject",
  "click",
  "unsubscribe",
] as const;

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .default(sql`(unixepoch('subsec') * 1000)`);

export const subscribers = sqliteTable(
  "subscribers",
  {
    // When the last double opt-in email went out, to rate-limit resends.
    confirmationSentAt: integer("confirmation_sent_at", {
      mode: "timestamp_ms",
    }),
    confirmedAt: integer("confirmed_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
    // Stored lowercased and trimmed; uniqueness is on the normalized value.
    email: text("email").notNull().unique(),
    id: text("id").primaryKey(),
    lastEngagedAt: integer("last_engaged_at", { mode: "timestamp_ms" }),
    metadata: text("metadata", { mode: "json" }).$type<JsonObject>(),
    name: text("name"),
    source: text("source", { enum: subscriberSources }).notNull(),
    status: text("status", { enum: subscriberStatuses }).notNull(),
    unsubscribedAt: integer("unsubscribed_at", { mode: "timestamp_ms" }),
  },
  (table) => [index("subscribers_status_idx").on(table.status)]
);

export const issues = sqliteTable("issues", {
  body: text("body").notNull().default(""),
  cancelledAt: integer("cancelled_at", { mode: "timestamp_ms" }),
  contentHash: text("content_hash"),
  createdAt: createdAt(),
  id: text("id").primaryKey(),
  preheader: text("preheader"),
  renderedHtml: text("rendered_html"),
  renderedText: text("rendered_text"),
  sentAt: integer("sent_at", { mode: "timestamp_ms" }),
  slug: text("slug").notNull().unique(),
  status: text("status", { enum: issueStatuses }).notNull().default("draft"),
  subject: text("subject").notNull().default(""),
  testSentHash: text("test_sent_hash"),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  version: integer("version").notNull().default(1),
});

export const sends = sqliteTable(
  "sends",
  {
    error: text("error"),
    issueId: text("issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    messageId: text("message_id"),
    sentAt: integer("sent_at", { mode: "timestamp_ms" }),
    status: text("status", { enum: sendStatuses }).notNull().default("queued"),
    subscriberId: text("subscriber_id")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.issueId, table.subscriberId] }),
    index("sends_issue_status_idx").on(table.issueId, table.status),
    index("sends_message_id_idx").on(table.messageId),
  ]
);

export const events = sqliteTable(
  "events",
  {
    at: integer("at", { mode: "timestamp_ms" }).notNull(),
    detail: text("detail", { mode: "json" }).$type<JsonObject>(),
    id: text("id").primaryKey(),
    issueId: text("issue_id").references(() => issues.id, {
      onDelete: "cascade",
    }),
    messageId: text("message_id"),
    subscriberId: text("subscriber_id").references(() => subscribers.id, {
      onDelete: "set null",
    }),
    type: text("type", { enum: eventTypes }).notNull(),
  },
  (table) => [
    index("events_issue_type_idx").on(table.issueId, table.type),
    index("events_message_id_idx").on(table.messageId),
  ]
);

// A single row (id = 1) holding the validated settings document.
export const settings = sqliteTable(
  "settings",
  {
    data: text("data", { mode: "json" }).notNull().$type<unknown>(),
    id: integer("id").primaryKey(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (table) => [check("settings_single_row", sql`${table.id} = 1`)]
);
