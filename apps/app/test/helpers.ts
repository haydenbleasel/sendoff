import { env } from "cloudflare:workers";
import { vi } from "vitest";

import { createDb } from "../src/db/client";
import type { JsonObject } from "../src/json";
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
  headers: Record<string, string>;
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
        Headers?: { Name: string; Value: string }[];
        Subject: { Data: string };
      };
    };
    Destination: { ToAddresses: string[] };
  }>();

  return {
    headers: Object.fromEntries(
      (body.Content.Simple.Headers ?? []).map((header) => [
        header.Name,
        header.Value,
      ])
    ),
    html: body.Content.Simple.Body.Html.Data,
    subject: body.Content.Simple.Subject.Data,
    text: body.Content.Simple.Body.Text.Data,
    to: body.Destination.ToAddresses[0] ?? "",
  };
};

export const sesError = (code: string, status: number, message = code) =>
  Response.json({ message }, { headers: { "x-amzn-ErrorType": code }, status });

export interface NetworkOptions {
  /** Overrides for SES GetAccount. Defaults to a healthy production account. */
  account?: JsonObject;
  /** DMARC TXT record returned for every _dmarc lookup, or null for none. */
  dmarc?: string | null;
  /** DMARC TXT records by queried name; takes precedence over dmarc. */
  dmarcByName?: Record<string, string>;
  /** SES event destinations for the configuration set, or null if it's missing. */
  eventDestinations?: JsonObject[] | null;
  /** Whether the sender's domain is a verified SES identity (default: not set up). */
  identity?: "missing" | "pending" | "verified";
  /** Return a response to fail a specific send; undefined sends normally. */
  onSend?: (email: SentEmail) => Response | undefined;
}

export const HEALTHY_SES: NetworkOptions = {
  dmarc: "v=DMARC1; p=none",
  identity: "verified",
};

const accountResponse = (overrides: JsonObject = {}) =>
  Response.json({
    EnforcementStatus: "HEALTHY",
    ProductionAccessEnabled: true,
    SendQuota: { Max24HourSend: 50_000, MaxSendRate: 1000, SentLast24Hours: 0 },
    SendingEnabled: true,
    SuppressionAttributes: { SuppressedReasons: ["BOUNCE", "COMPLAINT"] },
    ...overrides,
  });

const identityResponse = (identity: NetworkOptions["identity"]) => {
  if (identity === undefined || identity === "missing") {
    return sesError("NotFoundException", 404, "Identity not found");
  }

  return Response.json({
    DkimAttributes: { Status: identity === "verified" ? "SUCCESS" : "PENDING" },
    MailFromAttributes: {
      MailFromDomain: "bounce.example.com",
      MailFromDomainStatus: "SUCCESS",
    },
    VerifiedForSendingStatus: identity === "verified",
  });
};

/**
 * Stub outbound fetches: Turnstile passes unless the token is "fail", SES
 * accepts and records every email (unless onSend fails it), SNS serves the
 * test certificate, DNS answers DMARC lookups.
 */
export const mockNetwork = (options: NetworkOptions = {}) => {
  const sent: SentEmail[] = [];
  const fetched: string[] = [];

  const spy = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const { pathname } = new URL(request.url);
      fetched.push(request.url);

      if (request.url.startsWith("https://challenges.cloudflare.com/")) {
        const form = await request.formData();

        return Response.json({ success: form.get("response") !== "fail" });
      }

      if (pathname === "/v2/email/outbound-emails") {
        const email = await sesEmailFrom(request);
        const failed = options.onSend?.(email);

        if (failed) {
          return failed;
        }

        sent.push(email);

        return Response.json({ MessageId: `msg-${sent.length}` });
      }

      if (pathname === "/v2/email/account") {
        return accountResponse(options.account);
      }

      if (pathname.startsWith("/v2/email/identities/")) {
        return identityResponse(options.identity);
      }

      if (pathname.endsWith("/event-destinations")) {
        return options.eventDestinations === null
          ? sesError("NotFoundException", 404)
          : Response.json({
              EventDestinations: options.eventDestinations ?? [
                {
                  Enabled: true,
                  MatchingEventTypes: [
                    "BOUNCE",
                    "COMPLAINT",
                    "DELIVERY",
                    "REJECT",
                  ],
                  Name: "sendoff",
                  SnsDestination: { TopicArn: TOPIC_ARN },
                },
              ],
            });
      }

      if (request.url.startsWith("https://cloudflare-dns.com/dns-query")) {
        const name = new URL(request.url).searchParams.get("name") ?? "";

        const record = options.dmarcByName
          ? (options.dmarcByName[name] ?? null)
          : options.dmarc;

        return Response.json({
          Answer: record ? [{ data: `"${record}"`, type: 16 }] : undefined,
          Status: record ? 0 : 3,
        });
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
