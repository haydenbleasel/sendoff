import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConfig } from "../src/config";
import { events, issues, sends, subscribers } from "../src/db/schema";
import { createDraft, editDraft } from "../src/issues";
import type { ClassifyPromotion, PromotionAssessment } from "../src/promotion";
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
import { createToken } from "../src/tokens";
import { TEST_TRACKING_TOKEN } from "../src/tracking";
import {
  BASE_URL,
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

  it.each([
    // SES reports a used-up daily quota as throttling, but it won't clear for hours.
    [
      "the daily quota is used up",
      "TooManyRequestsException",
      429,
      "Daily message quota exceeded.",
    ],
    // How SES v2 reports a missing configuration set.
    [
      "the configuration set is missing",
      "NotFoundException",
      404,
      "Configuration set sendoff does not exist.",
    ],
  ])(
    "stops, rather than failing everyone, when %s",
    async (_, code, status, message) => {
      await addActive(3);
      useNetwork({
        onSend: (email) =>
          email.subject.startsWith("[Test]")
            ? undefined
            : sesError(code, status, message),
      });

      const confirmed = await startSend();

      const result = await processSendChunk(
        deps,
        messages.shift() ?? { issueId: "", maxSendRate: 1 }
      );

      expect(result.stopped).toContain(message);
      expect(messages).toHaveLength(0);

      const stopped = await sendStatus(deps, confirmed.issue.id);
      expect(stopped.counts).toMatchObject({ failed: 0, queued: 3 });
      expect(stopped.issue.sendError).toContain(message);
    }
  );

  it("retries a ThrottlingException like any other rate limit", async () => {
    await addActive(2);
    let throttledOnce = false;
    useNetwork({
      onSend: (email) => {
        const throttle = email.to === "reader-0@example.com" && !throttledOnce;

        throttledOnce ||= throttle;

        return throttle
          ? sesError(
              "ThrottlingException",
              400,
              "Maximum sending rate exceeded."
            )
          : undefined;
      },
    });

    const confirmed = await startSend();
    await drain();

    const status = await sendStatus(deps, confirmed.issue.id);
    expect(status.counts).toMatchObject({ failed: 0, sent: 2 });
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

const { address: _address, ...withoutAddress } = testSettings;

/** A classifier that records what it was asked and always gives `verdict`. */
const stubClassifier = (verdict: PromotionAssessment["verdict"]) => {
  const asked: string[] = [];

  const classify: ClassifyPromotion = (content) => {
    asked.push(content.subject);

    return Promise.resolve({
      commercialMentions: verdict !== "not_commercial",
      fixes: verdict === "commercial" ? ["Lead with your own update."] : [],
      reasons: ["It's mostly about a paid product."],
      verdict,
    });
  };

  return { asked, classify };
};

/** A tested draft, ready for prepare_send. */
const testedDraft = async (subject: string) => {
  const draft = await createDraft(db(), { body: "News.", subject });
  await sendTest(deps, draft.id);

  return draft;
};

describe("promotion check", () => {
  it("blocks an issue that reads as commercial when there's no postal address", async () => {
    await saveSettings(db(), withoutAddress);
    await addActive(1);
    deps = {
      ...deps,
      classifyPromotion: stubClassifier("commercial").classify,
    };

    const draft = await testedDraft("Buy Tersa Pro");

    await expect(prepareSend(deps, draft.id)).rejects.toThrow(
      "reads as commercial email"
    );
    await expect(prepareSend(deps, draft.id)).rejects.toThrow(
      "Lead with your own update."
    );
  });

  it("checks each version once, and skips the check with an address", async () => {
    await saveSettings(db(), withoutAddress);
    await addActive(1);
    const stub = stubClassifier("not_commercial");
    deps = { ...deps, classifyPromotion: stub.classify };

    const draft = await testedDraft("A few updates");
    const first = await prepareSend(deps, draft.id);
    await prepareSend(deps, draft.id);

    expect(first.promotion).toMatchObject({
      check: { verdict: "not_commercial" },
      status: "checked",
    });
    expect(stub.asked).toStrictEqual(["A few updates"]);

    await editDraft(db(), draft.id, { body: "More news." });
    await sendTest(deps, draft.id);
    await prepareSend(deps, draft.id);
    expect(stub.asked).toHaveLength(2);

    await saveSettings(db(), testSettings);
    await sendTest(deps, draft.id);
    const withAddress = await prepareSend(deps, draft.id);

    expect(withAddress.promotion).toStrictEqual({ status: "skipped" });
    expect(stub.asked).toHaveLength(2);
  });

  it("warns rather than blocks when the check can't run", async () => {
    await saveSettings(db(), withoutAddress);
    await addActive(1);
    deps = {
      ...deps,
      classifyPromotion: () => Promise.reject(new Error("Workers AI is down")),
    };

    const draft = await testedDraft("Quiet update");
    const prepared = await prepareSend(deps, draft.id);

    expect(prepared.promotion).toStrictEqual({
      error: "Workers AI is down",
      status: "failed",
    });
  });
});

/** Send an issue with one link, test first, all the way through. */
const sendWithLink = async () => {
  const draft = await createDraft(db(), {
    body: "Read [the post](https://example.com/post?a=1&b=2).",
    subject: "Tracked",
  });

  await sendTest(deps, draft.id);
  const prepared = await prepareSend(deps, draft.id);
  const confirmed = await confirmSend(deps, draft.id, prepared.confirmation);
  await drain();

  return confirmed.issue;
};

const clickPath = (issueId: string, token: string) =>
  `${BASE_URL}/click/${issueId}/${token}/`;

describe("tracking", () => {
  it("tracks each recipient's clicks and opens in the HTML, never in plain text", async () => {
    await saveSettings(db(), {
      ...testSettings,
      tracking: { clicks: true, opens: true },
    });
    await addActive(2);

    const issue = await sendWithLink();

    const test = network.sent.find((email) =>
      email.subject.startsWith("[Test]")
    );

    expect(test?.html).toContain(clickPath(issue.id, TEST_TRACKING_TOKEN));
    expect(test?.html).toContain(
      `${BASE_URL}/open/${issue.id}/${TEST_TRACKING_TOKEN}"`
    );

    const sent = newsletterEmails();
    expect(sent).toHaveLength(2);

    for (const email of sent) {
      // oxlint-disable-next-line no-await-in-loop -- two recipients
      const reader = await findSubscriberByEmail(db(), email.to);

      // oxlint-disable-next-line no-await-in-loop -- see above
      const token = await createToken(
        env.TOKEN_SECRET,
        "track",
        reader?.id ?? ""
      );

      expect(email.html).toContain(clickPath(issue.id, token));
      expect(email.html).toContain(
        `?url=${encodeURIComponent("https://example.com/post?a=1&b=2")}`
      );
      expect(email.html).toContain(`${BASE_URL}/open/${issue.id}/${token}"`);
      expect(email.html).not.toContain("%%sendoff");
      expect(email.text).toContain("https://example.com/post?a=1&b=2");
      expect(email.text).not.toContain("/click/");
    }

    const stored = await db().query.issues.findFirst({
      where: eq(issues.id, issue.id),
    });

    expect(stored?.tracking).toStrictEqual({ clicks: true, opens: true });
  });

  it("leaves links untouched with tracking off", async () => {
    await saveSettings(db(), {
      ...testSettings,
      tracking: { clicks: false, opens: false },
    });
    await addActive(1);

    await sendWithLink();
    const [email] = newsletterEmails();

    expect(email?.html).toContain(
      'href="https://example.com/post?a=1&amp;b=2"'
    );
    expect(email?.html).not.toContain("/click/");
    expect(email?.html).not.toContain("/open/");
  });
});
