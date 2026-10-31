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

const columnsUsed = z.object({
  email: z.string().describe("The header of the email column."),
  name: z.array(z.string()).describe("The headers the name was read from."),
  status: z
    .array(z.string())
    .describe(
      "The headers the status was read from (status, unsubscribed, bounced…)."
    ),
});

const skippedRows = z.object({
  noEmail: z.number().int().describe("Rows with an empty email cell."),
  unconfirmed: z
    .number()
    .int()
    .describe("Rows marked pending or unconfirmed, which are never imported."),
  unrecognized: z
    .number()
    .int()
    .describe(
      "Rows with a status Sendoff doesn't recognize, which aren't imported."
    ),
  unrecognizedValues: z
    .array(z.object({ count: z.number().int(), value: z.string() }))
    .describe("The most common of those status values, up to 10."),
});

export const csvImportQuery = z.object({
  dryRun: z
    .enum(["true", "false"])
    .optional()
    .transform((value) => value === "true"),
  status: z.enum(["unsubscribed", "bounced", "complained"]).optional(),
});

export const csvImportResponse = z
  .object({
    columns: columnsUsed,
    counts: z
      .object({
        active: z.number().int(),
        bounced: z.number().int(),
        complained: z.number().int(),
        unsubscribed: z.number().int(),
      })
      .describe("Rows by the status they're imported with."),
    created: z.number().int().describe("New subscribers."),
    dryRun: z.boolean().describe("If true, nothing was written."),
    invalid: z.array(z.string()).describe("Up to 20 invalid addresses."),
    invalidCount: z.number().int(),
    skipped: skippedRows,
    suppressed: z
      .number()
      .int()
      .describe("Existing subscribers newly suppressed by this file."),
    total: z.number().int().describe("Non-blank data rows in the file."),
    unchanged: z.number().int().describe("Addresses already on the list."),
  })
  .register(apiSchemas, { id: "CsvImport" });

export const errorCodes = [
  "confirmation_failed",
  "insufficient_scope",
  "invalid_api_key",
  "invalid_request",
  "not_configured",
  "not_found",
  "too_large",
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
