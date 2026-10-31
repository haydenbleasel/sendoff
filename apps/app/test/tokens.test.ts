import { describe, expect, it } from "vitest";

import { createId } from "../src/id";
import { createToken, verifyToken } from "../src/tokens";

const SECRET = "a-test-secret-that-is-long-enough-for-hmac";

const UUID_V7 =
  /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/u;

describe("tokens", () => {
  it("round-trips a subscriber id for the same purpose", async () => {
    const id = createId();
    const token = await createToken(SECRET, "unsubscribe", id);

    expect(await verifyToken(SECRET, "unsubscribe", token)).toBe(id);
  });

  it("rejects other purposes, other secrets and tampering", async () => {
    const id = createId();
    const token = await createToken(SECRET, "confirm", id);
    const otherId = createId();

    expect(await verifyToken(SECRET, "unsubscribe", token)).toBeNull();
    expect(await verifyToken(`${SECRET}-rotated`, "confirm", token)).toBeNull();
    expect(
      await verifyToken(SECRET, "confirm", token.replace(id, otherId))
    ).toBeNull();
    expect(await verifyToken(SECRET, "confirm", "garbage")).toBeNull();
    expect(await verifyToken(SECRET, "confirm", `${id}.!!!`)).toBeNull();
  });
});

describe("createId", () => {
  it("creates time-ordered UUIDv7 values", () => {
    const first = createId(1_700_000_000_000);
    const second = createId(1_700_000_000_001);

    expect(first).toMatch(UUID_V7);
    expect(first < second).toBe(true);
    expect(first.slice(0, 13)).toBe("018bcfe5-6800");
  });
});
