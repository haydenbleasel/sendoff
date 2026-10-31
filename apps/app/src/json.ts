import type { z } from "zod";

/** A JSON-serializable value. Optional object properties may be undefined (JSON.stringify drops them). */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type JsonObject = Record<string, JsonValue | undefined>;

/** Parse JSON text and validate it; malformed JSON fails validation like any bad input. */
export const parseJsonWith = <T>(schema: z.ZodType<T>, text: string) => {
  try {
    return schema.safeParse(JSON.parse(text));
  } catch {
    return schema.safeParse(null);
  }
};
