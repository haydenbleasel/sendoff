import { X509Certificate } from "node:crypto";

import { z } from "zod";

// Verifies Amazon SNS HTTP(S) messages:
// https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
// A valid signature only proves the message came from *some* SNS topic, so
// callers must also check `TopicArn` against the one they own.

const SNS_HOST = /^sns\.[a-z\d-]+\.amazonaws\.com(?:\.cn)?$/u;

export const snsMessageSchema = z.object({
  Message: z.string(),
  MessageId: z.string(),
  Signature: z.string(),
  SignatureVersion: z.enum(["1", "2"]),
  SigningCertURL: z.string(),
  Subject: z.string().optional(),
  SubscribeURL: z.string().optional(),
  Timestamp: z.string(),
  Token: z.string().optional(),
  TopicArn: z.string(),
  Type: z.enum([
    "Notification",
    "SubscriptionConfirmation",
    "UnsubscribeConfirmation",
  ]),
});

export type SnsMessage = z.infer<typeof snsMessageSchema>;

type SignedField = keyof SnsMessage;

const NOTIFICATION_FIELDS: SignedField[] = [
  "Message",
  "MessageId",
  "Subject",
  "Timestamp",
  "TopicArn",
  "Type",
];

const SUBSCRIPTION_FIELDS: SignedField[] = [
  "Message",
  "MessageId",
  "SubscribeURL",
  "Timestamp",
  "Token",
  "TopicArn",
  "Type",
];

/** True for https URLs on an SNS endpoint, the only hosts we fetch from. */
export const isSnsUrl = (value: string): boolean => {
  try {
    const url = new URL(value);

    return url.protocol === "https:" && SNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
};

export const stringToSign = (message: SnsMessage): string => {
  const fields =
    message.Type === "Notification" ? NOTIFICATION_FIELDS : SUBSCRIPTION_FIELDS;

  return fields
    .flatMap((field) => {
      const value = message[field];

      return value === undefined ? [] : [`${field}\n${value}\n`];
    })
    .join("");
};

const keys = new Map<string, Promise<CryptoKey>>();

const loadKey = async (
  url: string,
  hash: "SHA-1" | "SHA-256",
  fetcher: typeof fetch
): Promise<CryptoKey> => {
  const response = await fetcher(url);

  if (!response.ok) {
    throw new Error(`Couldn't fetch SNS certificate (${response.status})`);
  }

  const certificate = new X509Certificate(await response.text());
  const spki = certificate.publicKey.export({ format: "der", type: "spki" });

  return await crypto.subtle.importKey(
    "spki",
    spki,
    { hash, name: "RSASSA-PKCS1-v1_5" },
    false,
    ["verify"]
  );
};

const keyFor = (
  url: string,
  hash: "SHA-1" | "SHA-256",
  fetcher: typeof fetch
): Promise<CryptoKey> => {
  const cacheKey = `${hash} ${url}`;
  let key = keys.get(cacheKey);

  if (!key) {
    key = loadKey(url, hash, fetcher);
    // Don't cache failures; the next message retries the fetch.
    key.catch(() => keys.delete(cacheKey));
    keys.set(cacheKey, key);
  }

  return key;
};

const decodeBase64 = (value: string): Uint8Array | null => {
  try {
    return Uint8Array.from(
      atob(value),
      (character) => character.codePointAt(0) ?? 0
    );
  } catch {
    return null;
  }
};

export const verifySnsMessage = async (
  message: SnsMessage,
  fetcher: typeof fetch = fetch
): Promise<boolean> => {
  if (!isSnsUrl(message.SigningCertURL)) {
    return false;
  }

  const signature = decodeBase64(message.Signature);

  if (!signature) {
    return false;
  }

  const hash = message.SignatureVersion === "1" ? "SHA-1" : "SHA-256";

  try {
    const key = await keyFor(message.SigningCertURL, hash, fetcher);

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature,
      new TextEncoder().encode(stringToSign(message))
    );
  } catch {
    return false;
  }
};
