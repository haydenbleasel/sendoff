import type { z } from "zod/mini";

/** Parse JSON text and validate it; malformed JSON fails validation like any bad input. */
export const parseJsonWith = <T>(schema: z.ZodMiniType<T>, text: string) => {
  try {
    return schema.safeParse(JSON.parse(text));
  } catch {
    return schema.safeParse(null);
  }
};
