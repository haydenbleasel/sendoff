// UUIDv7 (RFC 9562): a millisecond timestamp followed by random bits, so IDs
// sort by creation time and index well.

const HEX = 16;
const TIMESTAMP_HEX_LENGTH = 12;
const RANDOM_BYTES = 10;
const VARIANT_HEX = "89ab";

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(HEX).padStart(2, "0")).join("");

export const createId = (now: number = Date.now()): string => {
  const timestamp = now.toString(HEX).padStart(TIMESTAMP_HEX_LENGTH, "0");
  const random = toHex(crypto.getRandomValues(new Uint8Array(RANDOM_BYTES)));

  const variant = VARIANT_HEX.charAt(
    Number.parseInt(random.charAt(3), HEX) % VARIANT_HEX.length
  );

  return [
    timestamp.slice(0, 8),
    timestamp.slice(8, 12),
    `7${random.slice(0, 3)}`,
    `${variant}${random.slice(4, 7)}`,
    random.slice(7, 19),
  ].join("-");
};
