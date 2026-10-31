// Signed, stateless tokens for confirm and unsubscribe links:
// `<subscriberId>.<base64url(HMAC-SHA256(purpose:subscriberId))>`.
// They never expire, because unsubscribe links must keep working for years.

export type TokenPurpose = "confirm" | "preview" | "unsubscribe";

const SIGNATURE_BYTES = 16;
const BASE64_PLUS = /\+/gu;
const BASE64_SLASH = /\//gu;
const BASE64_PADDING = /[=]+$/u;
const URL_DASH = /-/gu;
const URL_UNDERSCORE = /_/gu;
const BASE64_BLOCK = 4;

const keys = new Map<string, Promise<CryptoKey>>();

const keyFor = (secret: string): Promise<CryptoKey> => {
  let key = keys.get(secret);

  if (!key) {
    key = crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign"]
    );
    keys.set(secret, key);
  }

  return key;
};

const toBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll(BASE64_PLUS, "-")
    .replaceAll(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "");

const fromBase64Url = (value: string): Uint8Array | null => {
  const base64 = value
    .replaceAll(URL_DASH, "+")
    .replaceAll(URL_UNDERSCORE, "/");

  const padded = base64.padEnd(
    Math.ceil(base64.length / BASE64_BLOCK) * BASE64_BLOCK,
    "="
  );

  try {
    return Uint8Array.from(
      atob(padded),
      (character) => character.codePointAt(0) ?? 0
    );
  } catch {
    return null;
  }
};

const sign = async (
  secret: string,
  purpose: TokenPurpose,
  subscriberId: string
): Promise<Uint8Array> => {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await keyFor(secret),
    new TextEncoder().encode(`${purpose}:${subscriberId}`)
  );

  return new Uint8Array(signature).slice(0, SIGNATURE_BYTES);
};

export const createToken = async (
  secret: string,
  purpose: TokenPurpose,
  subscriberId: string
): Promise<string> =>
  `${subscriberId}.${toBase64Url(await sign(secret, purpose, subscriberId))}`;

/** Returns the subscriber ID if the token is valid for `purpose`, otherwise null. */
export const verifyToken = async (
  secret: string,
  purpose: TokenPurpose,
  token: string
): Promise<string | null> => {
  const separator = token.lastIndexOf(".");

  if (separator <= 0) {
    return null;
  }

  const subscriberId = token.slice(0, separator);
  const provided = fromBase64Url(token.slice(separator + 1));

  if (provided?.length !== SIGNATURE_BYTES) {
    return null;
  }

  const expected = await sign(secret, purpose, subscriberId);

  return crypto.subtle.timingSafeEqual(provided, expected)
    ? subscriberId
    : null;
};
