import { exports } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { events, sends } from "../src/db/schema";
import { createDraft } from "../src/issues";
import type { SesEvent } from "../src/ses-events";
import { verifySnsMessage } from "../src/sns";
import type { SnsMessage } from "../src/sns";
import { findSubscriberByEmail, importSubscribers } from "../src/subscribers";
import { TEST_SNS_CERT } from "./fixtures/sns-keys";
import {
  BASE_URL,
  db,
  mockNetwork,
  signedSnsMessage,
  statusOf,
} from "./helpers";

let network: ReturnType<typeof mockNetwork>;

beforeEach(() => {
  network = mockNetwork();
});

afterEach(() => network.restore());

const post = (message: SnsMessage) =>
  exports.default.fetch(
    new Request(`${BASE_URL}/webhooks/ses`, {
      body: JSON.stringify(message),
      headers: { "content-type": "text/plain; charset=UTF-8" },
      method: "POST",
    })
  );

const sesNotification = (
  event: Partial<SesEvent>,
  messageId = crypto.randomUUID()
) =>
  signedSnsMessage({
    Message: JSON.stringify(event),
    MessageId: messageId,
    Type: "Notification",
  });

/** SES reporting that the "ses-arrived" message reached its recipient. */
const delivery = async (timestamp: string) =>
  await post(
    await sesNotification({
      delivery: { timestamp },
      eventType: "Delivery",
      mail: {
        destination: ["Arrived@example.com"],
        messageId: "ses-arrived",
      },
    })
  );

const mail = (to: string) => ({
  destination: [to],
  messageId: `ses-${crypto.randomUUID()}`,
  tags: { issue: ["missing-issue"] },
});

const certFetcher: typeof fetch = () =>
  Promise.resolve(new Response(TEST_SNS_CERT));

const unavailableFetcher: typeof fetch = () =>
  Promise.resolve(new Response("Unavailable", { status: 503 }));

describe("verifySnsMessage", () => {
  it.each(["1", "2"] as const)(
    "accepts SignatureVersion %s and rejects tampering",
    async (version) => {
      const message = await signedSnsMessage({
        Message: "hello",
        MessageId: `id-${version}`,
        SignatureVersion: version,
        Type: "Notification",
      });

      expect(await verifySnsMessage(message, certFetcher)).toBe("valid");
      expect(
        await verifySnsMessage({ ...message, Message: "hell0" }, certFetcher)
      ).toBe("invalid");
    }
  );

  it.each([
    "https://sns.us-east-1.amazonaws.com.evil.com/cert.pem",
    // An S3 bucket named "sns" has this hostname.
    "https://sns.s3.amazonaws.com/cert.pem",
    // SNS, but not the topic's region.
    "https://sns.eu-west-1.amazonaws.com/cert.pem",
  ])("refuses a certificate from %s", async (url) => {
    const message = await signedSnsMessage({
      Message: "hello",
      MessageId: "id",
      Type: "Notification",
    });

    expect(
      await verifySnsMessage({ ...message, SigningCertURL: url }, certFetcher)
    ).toBe("invalid");
  });

  it("can't judge a message while the certificate can't be fetched", async () => {
    const message = await signedSnsMessage({
      Message: "hello",
      MessageId: "id",
      Type: "Notification",
    });

    expect(
      await verifySnsMessage(
        {
          ...message,
          SigningCertURL: "https://sns.us-east-1.amazonaws.com/unreachable.pem",
        },
        unavailableFetcher
      )
    ).toBe("unavailable");
  });
});

describe("POST /webhooks/ses", () => {
  it("confirms the SNS subscription via the SubscribeURL", async () => {
    const subscribeUrl =
      "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription&Token=abc";

    const message = await signedSnsMessage({
      Message: "You have chosen to subscribe",
      MessageId: "sub-1",
      SubscribeURL: subscribeUrl,
      Token: "abc",
      Type: "SubscriptionConfirmation",
    });

    const response = await post(message);

    expect(response.status).toBe(200);
    expect(network.fetched).toContain(subscribeUrl);
  });

  it("rejects other topics and bad signatures", async () => {
    const otherTopic = await signedSnsMessage({
      Message: "{}",
      MessageId: "x",
      TopicArn: "arn:aws:sns:us-east-1:999999999999:someone-else",
      Type: "Notification",
    });

    const tampered = {
      ...(await sesNotification({ eventType: "Delivery" })),
      Message: '{"eventType":"Bounce"}',
    };

    const otherTopicResponse = await post(otherTopic);
    const tamperedResponse = await post(tampered);

    expect(otherTopicResponse.status).toBe(403);
    expect(tamperedResponse.status).toBe(403);
  });

  it("asks SNS to retry when the signing certificate can't be fetched", async () => {
    // SNS drops a message for good on a 4xx, so this has to be a 5xx.
    const message = {
      ...(await sesNotification({ eventType: "Delivery" })),
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/unreachable.pem",
    };

    const response = await post(message);

    expect(response.status).toBe(503);
  });

  it("suppresses hard bounces, idempotently", async () => {
    await importSubscribers(db(), [
      { email: "gone@example.com", status: "active" },
    ]);

    const message = await sesNotification(
      {
        bounce: {
          bounceSubType: "General",
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "Gone@Example.com" }],
        },
        eventType: "Bounce",
        mail: mail("gone@example.com"),
      },
      "bounce-1"
    );

    const first = await post(message);
    const redelivered = await post(message);

    expect(first.status).toBe(200);
    expect(redelivered.status).toBe(200);

    const subscriber = await findSubscriberByEmail(db(), "gone@example.com");
    expect(subscriber?.status).toBe("bounced");

    const recorded = await db()
      .select()
      .from(events)
      .where(eq(events.subscriberId, subscriber?.id ?? ""));

    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      detail: { bounceSubType: "General", bounceType: "Permanent" },
      issueId: null,
      type: "bounce",
    });
  });

  it("only logs soft bounces", async () => {
    await importSubscribers(db(), [
      { email: "full@example.com", status: "active" },
    ]);

    await post(
      await sesNotification({
        bounce: {
          bounceType: "Transient",
          bouncedRecipients: [{ emailAddress: "full@example.com" }],
        },
        eventType: "Bounce",
        mail: mail("full@example.com"),
      })
    );

    expect(await statusOf("full@example.com")).toBe("active");
  });

  it("suppresses complaints", async () => {
    await importSubscribers(db(), [
      { email: "angry@example.com", status: "active" },
    ]);

    await post(
      await sesNotification({
        complaint: {
          complainedRecipients: [{ emailAddress: "angry@example.com" }],
        },
        eventType: "Complaint",
        mail: mail("angry@example.com"),
      })
    );

    expect(await statusOf("angry@example.com")).toBe("complained");
  });

  it("notes deliveries on the send they belong to, once", async () => {
    await importSubscribers(db(), [
      { email: "arrived@example.com", status: "active" },
    ]);
    const reader = await findSubscriberByEmail(db(), "arrived@example.com");
    const issue = await createDraft(db(), { body: "Hi", subject: "Arrived" });

    await db()
      .insert(sends)
      .values({
        issueId: issue.id,
        messageId: "ses-arrived",
        sentAt: new Date(),
        status: "sent",
        subscriberId: reader?.id ?? "",
      });

    const first = await delivery("2026-10-31T01:02:03.000Z");
    const again = await delivery("2026-10-31T05:00:00.000Z");

    expect(await first.json()).toStrictEqual({
      emails: ["arrived@example.com"],
      type: "delivery",
    });
    expect(await again.json()).toStrictEqual({ emails: [], type: "ignored" });

    const [row] = await db()
      .select()
      .from(sends)
      .where(eq(sends.messageId, "ses-arrived"));

    expect(row?.deliveredAt?.toISOString()).toBe("2026-10-31T01:02:03.000Z");
  });

  it("acknowledges events it doesn't track", async () => {
    const responses = await Promise.all([
      post(
        await sesNotification({
          eventType: "Open",
          mail: mail("x@example.com"),
        })
      ),
      // A test send's delivery: no send row to note it on.
      post(
        await sesNotification({
          eventType: "Delivery",
          mail: mail("x@example.com"),
        })
      ),
    ]);

    for (const response of responses) {
      // oxlint-disable-next-line no-await-in-loop -- two responses
      expect(await response.json()).toStrictEqual({
        emails: [],
        type: "ignored",
      });
    }
  });
});
