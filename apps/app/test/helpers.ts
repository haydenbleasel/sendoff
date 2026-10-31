import { env } from "cloudflare:workers";
import { vi } from "vitest";

import { createDb } from "../src/db/client";
import { saveSettings } from "../src/settings";
import { stringToSign } from "../src/sns";
import type { SnsMessage } from "../src/sns";
import { findSubscriberByEmail } from "../src/subscribers";
import {
  TEST_SNS_CERT,
  TEST_SNS_CERT_URL,
  TEST_SNS_PRIVATE_KEY,
} from "./fixtures/sns-keys";

export const TOPIC_ARN = "arn:aws:sns:us-east-1:123456789012:sendoff-events";
export const BASE_URL = "https://news.example.com";

export const testSettings = {
  address: "1 Test Lane, Sydney",
  from: { email: "hello@example.com", name: "Tester" },
  name: "Test Newsletter",
};

export const db = () => createDb(env.DB);

export const statusOf = async (email: string) => {
  const subscriber = await findSubscriberByEmail(db(), email);

  return subscriber?.status;
};

export const setupSettings = async () => {
  await saveSettings(db(), testSettings);
};

export interface SentEmail {
  html: string;
  subject: string;
  text: string;
  to: string;
}

const sesEmailFrom = async (request: Request): Promise<SentEmail> => {
  const body = await request.json<{
    Content: {
      Simple: {
        Body: { Html: { Data: string }; Text: { Data: string } };
        Subject: { Data: string };
      };
    };
    Destination: { ToAddresses: string[] };
  }>();

  return {
    html: body.Content.Simple.Body.Html.Data,
    subject: body.Content.Simple.Subject.Data,
    text: body.Content.Simple.Body.Text.Data,
    to: body.Destination.ToAddresses[0] ?? "",
  };
};

/**
 * Stub outbound fetches: Turnstile passes unless the token is "fail", SES
 * accepts and records every email, SNS serves the test certificate.
 */
export const mockNetwork = () => {
  const sent: SentEmail[] = [];
  const fetched: string[] = [];

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      fetched.push(request.url);

      if (request.url.startsWith("https://challenges.cloudflare.com/")) {
        const form = await request.formData();

        return Response.json({ success: form.get("response") !== "fail" });
      }

      if (request.url.includes(".amazonaws.com/v2/email/outbound-emails")) {
        sent.push(await sesEmailFrom(request));

        return Response.json({ MessageId: `msg-${sent.length}` });
      }

      if (request.url === TEST_SNS_CERT_URL) {
        return new Response(TEST_SNS_CERT);
      }

      if (
        request.url.startsWith(
          "https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription"
        )
      ) {
        return new Response("<ConfirmSubscriptionResponse/>");
      }

      return new Response("Unexpected request", { status: 500 });
    });

  return { fetched, restore: () => spy.mockRestore(), sent };
};

const pemToDer = (pem: string): Uint8Array =>
  Uint8Array.from(
    atob(pem.replaceAll(/-----[A-Z ]+-----/gu, "").replaceAll(/\s+/gu, "")),
    (character) => character.codePointAt(0) ?? 0
  );

/** Build an SNS message signed with the test key (SignatureVersion 2 by default). */
export const signedSnsMessage = async (
  fields: Omit<
    SnsMessage,
    | "Signature"
    | "SignatureVersion"
    | "SigningCertURL"
    | "Timestamp"
    | "TopicArn"
  > &
    Partial<Pick<SnsMessage, "SignatureVersion" | "TopicArn">>
): Promise<SnsMessage> => {
  const message: SnsMessage = {
    Signature: "",
    SignatureVersion: "2",
    SigningCertURL: TEST_SNS_CERT_URL,
    Timestamp: "2026-10-31T00:00:00.000Z",
    TopicArn: TOPIC_ARN,
    ...fields,
  };

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(TEST_SNS_PRIVATE_KEY),
    {
      hash: message.SignatureVersion === "1" ? "SHA-1" : "SHA-256",
      name: "RSASSA-PKCS1-v1_5",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(stringToSign(message))
  );

  return {
    ...message,
    Signature: btoa(String.fromCodePoint(...new Uint8Array(signature))),
  };
};
