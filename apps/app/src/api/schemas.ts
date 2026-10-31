import { z } from "zod";

// Request and response shapes for the REST API. The OpenAPI document is
// generated from this registry, so it can't drift from what handlers accept.

export const apiSchemas = z.registry<{ id: string }>();

const MAX_NAME = 100;

export const createSubscriberBody = z
  .object({
    email: z.email().describe("The address to subscribe."),
    name: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NAME)
      .optional()
      .describe("Optional display name."),
  })
  .register(apiSchemas, { id: "CreateSubscriber" });

export const acceptedResponse = z
  .object({
    status: z
      .literal("accepted")
      .describe(
        "Always returned, whether the address is new, pending or already subscribed, so the response can't reveal who's on the list."
      ),
  })
  .register(apiSchemas, { id: "Accepted" });

export const errorCodes = [
  "confirmation_failed",
  "insufficient_scope",
  "invalid_api_key",
  "invalid_request",
  "not_configured",
  "not_found",
] as const;

export type ErrorCode = (typeof errorCodes)[number];

export const errorResponse = z
  .object({
    error: z.object({
      code: z.enum(errorCodes),
      message: z.string(),
    }),
  })
  .register(apiSchemas, { id: "Error" });
