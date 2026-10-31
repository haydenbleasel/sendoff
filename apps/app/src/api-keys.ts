import { and, desc, eq, isNull, or } from "drizzle-orm";

import type { Database } from "./db/client";
import { apiKeys } from "./db/schema";
import type { apiScopes } from "./db/schema";
import { createId } from "./id";
import { IssueError } from "./issues";

// API keys for the REST API. The full key is shown once at creation; only a
// SHA-256 hash is stored. Keys look like `sendoff_<43 base64url chars>`.

export type ApiKey = typeof apiKeys.$inferSelect;

export type ApiScope = (typeof apiScopes)[number];

export const API_KEY_PREFIX = "sendoff_";
const KEY_BYTES = 32;
const DISPLAY_LENGTH = API_KEY_PREFIX.length + 6;
const HEX = 16;
const BASE64_PLUS = /\+/gu;
const BASE64_SLASH = /\//gu;
const BASE64_PADDING = /[=]+$/u;

const hashKey = async (key: string): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key)
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX).padStart(2, "0"))
    .join("");
};

const randomKey = (): string =>
  `${API_KEY_PREFIX}${btoa(
    String.fromCodePoint(...crypto.getRandomValues(new Uint8Array(KEY_BYTES)))
  )
    .replaceAll(BASE64_PLUS, "-")
    .replaceAll(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "")}`;

export const createApiKey = async (
  db: Database,
  { name, scopes }: { name: string; scopes: ApiScope[] }
): Promise<{ apiKey: ApiKey; key: string }> => {
  if (name.trim() === "") {
    throw new IssueError(
      "Give the key a name, like the site or script that will use it."
    );
  }

  if (scopes.length === 0) {
    throw new IssueError("A key needs at least one scope.");
  }

  const key = randomKey();

  const [apiKey] = await db
    .insert(apiKeys)
    .values({
      hash: await hashKey(key),
      id: createId(),
      name: name.trim(),
      prefix: key.slice(0, DISPLAY_LENGTH),
      scopes: [...new Set(scopes)],
    })
    .returning();

  if (!apiKey) {
    throw new IssueError("Couldn't create the API key.");
  }

  return { apiKey, key };
};

/** The active key matching `key`, or null. */
export const findApiKey = async (
  db: Database,
  key: string
): Promise<ApiKey | null> => {
  if (!key.startsWith(API_KEY_PREFIX)) {
    return null;
  }

  const found = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.hash, await hashKey(key)), isNull(apiKeys.revokedAt)),
  });

  return found ?? null;
};

export const touchApiKey = async (
  db: Database,
  id: string,
  now: Date = new Date()
): Promise<void> => {
  await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, id));
};

export const listApiKeys = async (db: Database): Promise<ApiKey[]> =>
  await db.select().from(apiKeys).orderBy(desc(apiKeys.createdAt));

/** Revoke by id or by the displayed prefix. Idempotent. */
export const revokeApiKey = async (
  db: Database,
  ref: string,
  now: Date = new Date()
): Promise<ApiKey> => {
  const [key, ...others] = await db
    .select()
    .from(apiKeys)
    .where(or(eq(apiKeys.id, ref), eq(apiKeys.prefix, ref)));

  if (!key) {
    throw new IssueError(
      `No API key with id or prefix "${ref}". Use list_api_keys to find it.`
    );
  }

  if (others.length > 0) {
    throw new IssueError(
      `More than one key starts with "${ref}". Use its id instead.`
    );
  }

  if (key.revokedAt) {
    return key;
  }

  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: now })
    .where(eq(apiKeys.id, key.id))
    .returning();

  return revoked ?? key;
};
