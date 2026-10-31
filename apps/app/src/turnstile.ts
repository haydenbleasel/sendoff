import { z } from "zod";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

const responseSchema = z.object({
  "error-codes": z.array(z.string()).optional(),
  success: z.boolean(),
});

/** Verify a Turnstile token server-side. Network or parse failures count as a failed check. */
export const verifyTurnstile = async (
  secret: string,
  token: string,
  remoteIp: string | undefined,
  fetcher: typeof fetch = fetch
): Promise<boolean> => {
  if (token === "") {
    return false;
  }

  const body = new FormData();
  body.set("secret", secret);
  body.set("response", token);

  if (remoteIp) {
    body.set("remoteip", remoteIp);
  }

  try {
    const response = await fetcher(SITEVERIFY_URL, { body, method: "POST" });
    const result = responseSchema.safeParse(await response.json());

    return result.success && result.data.success;
  } catch {
    return false;
  }
};
