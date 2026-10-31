import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config";
import { events, issues, sends, subscribers } from "../src/db/schema";
import { createDraft, editDraft } from "../src/issues";
import {
  CHUNK_SIZE,
  STALL_AFTER_MS,
  cancelSend,
  confirmSend,
  prepareSend,
  processSendChunk,
  resumeSend,
  resumeStalledSends,
  sendStatus,
  sendTest,
} from "../src/sending";
import type { SendDeps, SendMessage } from "../src/sending";
import { saveSettings } from "../src/settings";
import {
  findSubscriberByEmail,
  importSubscribers,
  unsubscribeSubscriber,
} from "../src/subscribers";
import {
  HEALTHY_SES,
  db,
  mockNetwork,
  sesError,
  testSettings,
} from "./helpers";
import type { NetworkOptions } from "./helpers";

let network: ReturnType<typeof mockNetwork>;
let messages: SendMessage[];
let deps: SendDeps;

const useNetwork = (options: NetworkOptions = {}) => {
  network.restore();
  network = mockNetwork({ ...HEALTHY_SES, ...options });
};

beforeEach(async () => {
  const database = db();

  await database.delete(events);
  await database.delete(sends);
  await database.delete(issues);
  await database.delete(subscribers);
  await saveSettings(database, testSettings);

  messages = [];
  network = mockNetwork(HEALTHY_SES);
  deps = {
    config: getConfig(env),
    db: database,
    queue: {
      send: (message) => {
        messages.push(message);

        return Promise.resolve(undefined);
      },
    },
    sleep: () => Promise.resolve(),
  };
});

afterEach(() => network.restore());

const addActive = async (count: number, prefix = "reader") =>
  await importSubscribers(
    db(),
    Array.from({ length: count }, (_, index) => ({
      email: `${prefix}-${index}@example.com`,
      status: "active" as const,
    }))
  );

/** Process queued chunks until the chain ends. */
const drain = async () => {
  for (let guard = 0; guard < 100; guard += 1) {
    const next = messages.shift();

    if (!next) {
      return;
    }

    // oxlint-disable-next-line no-await-in-loop -- chunks run one at a time, like the real queue
    await processSendChunk(deps, next);
  }

  throw new Error("Send chain didn't finish");
};

/** Draft, test, prepare and confirm: everything up to the queue taking over. */
const startSend = async () => {
  const draft = await createDraft(db(), {
    body: "Hello **readers**.",
    subject: "Issue 1",
  });

  await sendTest(deps, draft.id);
  const prepared = await prepareSend(deps, draft.id);

  return await confirmSend(deps, draft.id, prepared.confirmation);
};

const newsletterEmails = () =>
  network.sent.filter((email) => !email.subject.startsWith("[Test]"));

describe("send gates", () => {
  it("requires a test of the exact current version", async () => {
    const draft = await createDraft(db(), { body: "Hello", subject: "Gated" });

    await expect(prepareSend(deps, draft.id)).rejects.toThrow("Send a test");

    const test = await sendTest(deps, draft.id);
    expect(test.to).toStrictEqual(["hello@example.com"]);
    expect(network.sent[0]?.subject).toBe("[Test] Gated");

    await editDraft(db(), draft.id, { body: "Hello again" });
    await expect(prepareSend(deps, draft.id)).rejects.toThrow(
      "changed since the last test"
    );

    await sendTest(deps, draft.id);
    await saveSettings(db(), { ...testSettings, accent: "#ff0066" });
    await expect(prepareSend(deps, draft.id)).rejects.toThrow(
      "changed since the last test"
    );
  });

  it("refuses when the preflight checks fail", async () => {
    await addActive(1);

    const draft = await createDraft(db(), {
      body: "Hello",
      subject: "Sandboxed",
    });

    await sendTest(deps, draft.id);
    useNetwork({ account: { ProductionAccessEnabled: false } });

    await expect(prepareSend(deps, draft.id)).rejects.toThrow(
      "SES is in the sandbox"
    );
  });

  it("only accepts a fresh, matching confirmation", async () => {
    await addActive(1);

    const draft = await createDraft(db(), {
      body: "Hello",
      subject: "Confirm me",
    });

    await sendTest(deps, draft.id);
    const prepared = await prepareSend(deps, draft.id);

    await expect(confirmSend(deps, draft.id, "123.forged")).rejects.toThrow(
      "doesn't match this issue"
    );
    await expect(
      confirmSend(
        { ...deps, now: () => prepared.expiresAt + 1 },
        draft.id,
        prepared.confirmation
      )
    ).rejects.toThrow("expired");

    await editDraft(db(), draft.id, { body: "Changed after preparing" });
    await expect(
      confirmSend(deps, draft.id, prepared.confirmation)
    ).rejects.toThrow("doesn't match");
  });
});

describe("sending", () => {
  it("sends each active subscriber one personalized email with one-click unsubscribe", async () => {
    await addActive(3);
    await importSubscribers(db(), [
      { email: "gone@example.com", status: "unsubscribed" },
    ]);

    const confirmed = await startSend();
    expect(confirmed).toMatchObject({ queued: true, recipients: 3 });
    expect(confirmed.issue.status).toBe("sending");
    expect(messages).toHaveLength(1);

    await drain();

    const sent = newsletterEmails();
    expect(sent.map((email) => email.to).toSorted()).toStrictEqual([
      "reader-0@example.com",
      "reader-1@example.com",
      "reader-2@example.com",
    ]);

    for (const email of sent) {
      const header = email.headers["List-Unsubscribe"] ?? "";
      const url = header.slice(1, -1);

      expect(header).toMatch(
        /^<https:\/\/news\.example\.com\/unsubscribe\/.+\?issue=.+>$/u
      );
      expect(email.headers["List-Unsubscribe-Post"]).toBe(
        "List-Unsubscribe=One-Click"
      );
      expect(email.html).toContain(url.replaceAll("&", "&amp;"));
      expect(email.html).not.toContain("%%sendoff");
      expect(email.subject).toBe("Issue 1");
    }

    const status = await sendStatus(deps, confirmed.issue.id);
    expect(status.issue.status).toBe("sent");
    expect(status.issue.sentAt).toBeInstanceOf(Date);
    expect(status.counts).toMatchObject({
      failed: 0,
      queued: 0,
      sending: 0,
      sent: 3,
    });

    await expect(prepareSend(deps, confirmed.issue.id)).rejects.toThrow(
      "only drafts"
    );
  });

  it("works through large lists in chunks and skips people who unsubscribe mid-send", async () => {
    await addActive(CHUNK_SIZE * 2 + 10);
    const confirmed = await startSend();

    await processSendChunk(
      deps,
      messages.shift() ?? { issueId: "", maxSendRate: 1 }
    );
    expect(newsletterEmails()).toHaveLength(CHUNK_SIZE);

    const sentTo = new Set(newsletterEmails().map((email) => email.to));

    const later = Array.from(
      { length: CHUNK_SIZE * 2 + 10 },
      (_, index) => `reader-${index}@example.com`
    ).find((email) => !sentTo.has(email));

    const subscriber = await findSubscriberByEmail(db(), later ?? "");
    await unsubscribeSubscriber(db(), subscriber?.id ?? "");

    await drain();

    const status = await sendStatus(deps, confirmed.issue.id);
    expect(status.counts).toMatchObject({
      sent: CHUNK_SIZE * 2 + 9,
      skipped: 1,
    });
    expect(newsletterEmails().map((email) => email.to)).not.toContain(later);
  });

  it("retries throttled sends and records permanent failures without resending", async () => {
    await addActive(2);
    await importSubscribers(db(), [
      { email: "throttled@example.com", status: "active" },
      { email: "rejected@example.com", status: "active" },
    ]);
    let throttledOnce = false;
    useNetwork({
      onSend: (email) => {
        if (email.to === "throttled@example.com" && !throttledOnce) {
          throttledOnce = true;

          return sesError(
            "TooManyRequestsException",
            429,
            "Maximum sending rate exceeded."
          );
        }

        return email.to === "rejected@example.com"
          ? sesError("MessageRejected", 400, "Address rejected")
          : undefined;
      },
    });

    const confirmed = await startSend();
    await drain();

    const status = await sendStatus(deps, confirmed.issue.id);
    expect(status.counts).toMatchObject({ failed: 1, sent: 3 });
    expect(status.failures).toStrictEqual([
      {
        email: "rejected@example.com",
        error: "SES MessageRejected: Address rejected",
      },
    ]);
    expect(
      newsletterEmails().filter((email) => email.to === "throttled@example.com")
    ).toHaveLength(1);
    expect(status.issue.status).toBe("sent");
  });

  it("stops on account errors and continues after resume_send", async () => {
    await addActive(4);
    let paused = true;
    useNetwork({
      onSend: (email) =>
        paused && !email.subject.startsWith("[Test]")
          ? sesError("SendingPausedException", 400, "Sending is paused")
          : undefined,
    });

    const confirmed = await startSend();

    const result = await processSendChunk(
      deps,
      messages.shift() ?? { issueId: "", maxSendRate: 1 }
    );

    expect(result.stopped).toContain("SendingPausedException");
    expect(messages).toHaveLength(0);

    const stopped = await sendStatus(deps, confirmed.issue.id);
    expect(stopped.issue.sendError).toContain("Sending is paused");
    expect(stopped.counts).toMatchObject({ queued: 4, sent: 0 });

    paused = false;
    await resumeSend(deps, confirmed.issue.id);
    await drain();

    const resumed = await sendStatus(deps, confirmed.issue.id);
    expect(resumed.counts.sent).toBe(4);
    expect(resumed.issue).toMatchObject({ sendError: null, status: "sent" });
  });

  it("never resends recipients a crashed worker had claimed", async () => {
    await addActive(3);
    const confirmed = await startSend();
    const crashed = await findSubscriberByEmail(db(), "reader-1@example.com");

    await db()
      .update(sends)
      .set({ status: "sending" })
      .where(
        and(
          eq(sends.issueId, confirmed.issue.id),
          eq(sends.subscriberId, crashed?.id ?? "")
        )
      );
    await drain();

    const status = await sendStatus(deps, confirmed.issue.id);
    expect(status.counts).toMatchObject({ failed: 1, sent: 2 });
    expect(status.failures[0]?.error).toContain("Unknown outcome");
    expect(newsletterEmails().map((email) => email.to)).not.toContain(
      "reader-1@example.com"
    );
    expect(status.issue.status).toBe("sent");
  });

  it("cancels a send in progress", async () => {
    await addActive(CHUNK_SIZE + 5);
    const confirmed = await startSend();

    await processSendChunk(
      deps,
      messages.shift() ?? { issueId: "", maxSendRate: 1 }
    );
    const cancelled = await cancelSend(deps, confirmed.issue.id);
    await drain();

    expect(cancelled.issue.status).toBe("cancelled");
    expect(cancelled.counts).toMatchObject({
      queued: 0,
      sent: CHUNK_SIZE,
      skipped: 5,
    });
    expect(newsletterEmails()).toHaveLength(CHUNK_SIZE);
  });

  it("restarts stalled sends from the cron", async () => {
    await addActive(2);
    deps = {
      ...deps,
      queue: { send: () => Promise.reject(new Error("queue unavailable")) },
    };

    const confirmed = await startSend();
    expect(confirmed.queued).toBe(false);

    deps = {
      ...deps,
      queue: {
        send: (message) => {
          messages.push(message);

          return Promise.resolve(undefined);
        },
      },
    };

    expect(await resumeStalledSends(deps)).toStrictEqual([]);

    const later = { ...deps, now: () => Date.now() + STALL_AFTER_MS + 1000 };
    expect(await resumeStalledSends(later)).toStrictEqual([confirmed.issue.id]);

    await drain();
    expect(newsletterEmails()).toHaveLength(2);
  });
});
