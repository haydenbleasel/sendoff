import type { Config } from "./config";
import { createToken, verifyToken } from "./tokens";

// Sendoff has one owner, who proves it with the admin token (the
// MCP_TOKEN secret from setup): directly as a bearer token for Claude Code
// and Codex, or once on /authorize to connect claude.ai or Claude Desktop.

export const ADMIN_SESSION_COOKIE = "__Host-sendoff-admin";
const SESSION_TTL_SECONDS = 15 * 60;
const MS_PER_SECOND = 1000;

const digest = async (value: string): Promise<ArrayBuffer> =>
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

/** Constant-time comparison (of digests, so token length doesn't leak). */
export const isAdminToken = async (
  config: Config,
  provided: string
): Promise<boolean> =>
  crypto.subtle.timingSafeEqual(
    await digest(provided),
    await digest(config.mcpToken)
  );

/** A signed, short-lived session for the authorize page: `<expiresAt>.<signature>`. */
export const createAdminSession = async (
  config: Config,
  now: number = Date.now()
): Promise<{ maxAge: number; value: string }> => ({
  maxAge: SESSION_TTL_SECONDS,
  value: await createToken(
    config.tokenSecret,
    "session",
    String(now + SESSION_TTL_SECONDS * MS_PER_SECOND)
  ),
});

export const isAdminSession = async (
  config: Config,
  value: string | undefined,
  now: number = Date.now()
): Promise<boolean> => {
  if (!value) {
    return false;
  }

  const expiresAt = await verifyToken(config.tokenSecret, "session", value);

  return expiresAt !== null && Number(expiresAt) > now;
};
