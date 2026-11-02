import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { events } from "../src/db/schema";
import {
  CONFIRMATION_COOLDOWN_MS,
  confirmSubscriber,
  findSubscriberByEmail,
  importSubscribers,
  markConfirmationSent,
  resubscribeSubscriber,
  subscribe,
  unsubscribeSubscriber,
} from "../src/subscribers";
import { db, statusOf } from "./helpers";

describe("subscribe", () => {
  it("creates a pending subscriber with a normalized email", async () => {
    const { outcome, subscriber } = await subscribe(db(), {
      email: "  New.Person@Example.COM ",
      source: "form",
    });

    expect(outcome).toBe("send_confirmation");
    expect(subscriber).toMatchObject({
      email: "new.person@example.com",
      source: "form",
      status: "pending",
    });
  });

  it("rate-limits confirmation emails per address", async () => {
    const now = new Date("2026-10-31T00:00:00Z");

    const { subscriber } = await subscribe(db(), {
      email: "cooldown@example.com",
      now,
      source: "form",
    });

    await markConfirmationSent(db(), subscriber.id, now);

    const soon = await subscribe(db(), {
      email: "cooldown@example.com",
      now: new Date(now.getTime() + 1000),
      source: "form",
    });

    const later = await subscribe(db(), {
      email: "cooldown@example.com",
      now: new Date(now.getTime() + CONFIRMATION_COOLDOWN_MS + 1),
      source: "form",
    });

    expect(soon.outcome).toBe("recently_sent");
    expect(later.outcome).toBe("send_confirmation");
  });

  it("doesn't email active or suppressed addresses", async () => {
    await importSubscribers(db(), [
      { email: "active@example.com", status: "active" },
      { email: "bounced@example.com", status: "bounced" },
    ]);

    const active = await subscribe(db(), {
      email: "active@example.com",
      source: "form",
    });

    const bounced = await subscribe(db(), {
      email: "bounced@example.com",
      source: "form",
    });

    expect(active.outcome).toBe("already_active");
    expect(bounced.outcome).toBe("suppressed");
  });
});

describe("confirm, unsubscribe and resubscribe", () => {
  it("moves through the lifecycle and records the unsubscribe", async () => {
    const { subscriber } = await subscribe(db(), {
      email: "lifecycle@example.com",
      source: "form",
    });

    expect(await confirmSubscriber(db(), subscriber.id)).toBe("confirmed");
    expect(await confirmSubscriber(db(), subscriber.id)).toBe("already_active");

    await unsubscribeSubscriber(db(), subscriber.id);
    await unsubscribeSubscriber(db(), subscriber.id);

    // An old confirm link can't undo an unsubscribe.
    expect(await confirmSubscriber(db(), subscriber.id)).toBe("not_pending");

    const recorded = await db()
      .select()
      .from(events)
      .where(eq(events.subscriberId, subscriber.id));

    expect(recorded.map((event) => event.type)).toStrictEqual(["unsubscribe"]);

    expect(await resubscribeSubscriber(db(), subscriber.id)).toBe(true);
    expect(await statusOf("lifecycle@example.com")).toBe("active");
  });

  it("resubscribes a pending signup, since the link proves inbox access", async () => {
    const { subscriber } = await subscribe(db(), {
      email: "pending-again@example.com",
      source: "form",
    });

    expect(await resubscribeSubscriber(db(), subscriber.id)).toBe(true);
    expect(
      await findSubscriberByEmail(db(), "pending-again@example.com")
    ).toMatchObject({
      status: "active",
      unsubscribedAt: null,
    });
    expect(await resubscribeSubscriber(db(), subscriber.id)).toBe(false);
  });

  it("clears the unsubscribe date when someone signs up again and confirms", async () => {
    const { subscriber } = await subscribe(db(), {
      email: "again@example.com",
      source: "form",
    });

    await confirmSubscriber(db(), subscriber.id);
    await unsubscribeSubscriber(db(), subscriber.id);
    await subscribe(db(), { email: "again@example.com", source: "form" });

    expect(await confirmSubscriber(db(), subscriber.id)).toBe("confirmed");

    const confirmed = await findSubscriberByEmail(db(), "again@example.com");
    expect(confirmed).toMatchObject({ status: "active", unsubscribedAt: null });
  });

  it("keeps bounced subscribers bounced when they unsubscribe", async () => {
    await importSubscribers(db(), [
      { email: "hard@example.com", status: "bounced" },
    ]);
    const subscriber = await findSubscriberByEmail(db(), "hard@example.com");

    const result = await unsubscribeSubscriber(db(), subscriber?.id ?? "");

    expect(result?.status).toBe("bounced");
    expect(await resubscribeSubscriber(db(), subscriber?.id ?? "")).toBe(false);
  });
});

describe("importSubscribers", () => {
  it("creates, dedupes, validates and never reactivates suppressed addresses", async () => {
    await importSubscribers(db(), [
      { email: "keep-unsubscribed@example.com", status: "unsubscribed" },
      { email: "becomes-unsubscribed@example.com", status: "active" },
    ]);

    const summary = await importSubscribers(db(), [
      { email: "fresh@example.com", name: "Fresh", status: "active" },
      { email: "FRESH@example.com", status: "unsubscribed" },
      { email: "keep-unsubscribed@example.com", status: "active" },
      { email: "becomes-unsubscribed@example.com", status: "unsubscribed" },
      { email: "not-an-email", status: "active" },
    ]);

    expect(summary).toStrictEqual({
      created: 1,
      invalid: ["not-an-email"],
      invalidCount: 1,
      suppressed: 1,
      total: 5,
      unchanged: 1,
    });

    // Within one import, a suppression wins over an active duplicate.
    expect(await statusOf("fresh@example.com")).toBe("unsubscribed");
    expect(await statusOf("keep-unsubscribed@example.com")).toBe(
      "unsubscribed"
    );
    expect(await statusOf("becomes-unsubscribed@example.com")).toBe(
      "unsubscribed"
    );
  });

  it("keeps the most serious status for an address listed twice", async () => {
    await importSubscribers(db(), [
      { email: "twice@example.com", status: "complained" },
      { email: "twice@example.com", status: "unsubscribed" },
    ]);

    // An unsubscribe could be undone by a resubscribe link; a complaint can't.
    expect(await statusOf("twice@example.com")).toBe("complained");
  });

  it("treats imported active subscribers as confirmed", async () => {
    await importSubscribers(db(), [
      { email: "confirmed@example.com", status: "active" },
    ]);

    const subscriber = await findSubscriberByEmail(
      db(),
      "confirmed@example.com"
    );

    expect(subscriber?.source).toBe("import");
    expect(subscriber?.confirmedAt).toBeInstanceOf(Date);
  });

  it("handles a list larger than one batch", async () => {
    const rows = Array.from({ length: 1200 }, (_, index) => ({
      email: `bulk-${index}@example.com`,
      status: "active" as const,
    }));

    const summary = await importSubscribers(db(), rows);

    expect(summary.created).toBe(1200);
  });
});
