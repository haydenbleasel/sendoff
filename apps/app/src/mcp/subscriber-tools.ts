import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config";
import { sendConfirmationEmail } from "../confirmations";
import type { Database } from "../db/client";
import { subscriberStatuses } from "../db/schema";
import {
  MAX_CSV_BYTES,
  describeCsvImport,
  importCsv,
  suppressedStatuses,
} from "../importers/csv";
import { getSettings } from "../settings";
import {
  confirmSubscriber,
  countSubscribers,
  findSubscriberByEmail,
  importSubscribers,
  isValidEmail,
  markConfirmationSent,
  normalizeEmail,
  searchSubscribers,
  subscribe,
  unsubscribeSubscriber,
} from "../subscribers";
import type { ImportSummary } from "../subscribers";
import { failure, presentSubscriber, result, run } from "./results";

const MAX_PAGE = 100;
const DEFAULT_PAGE = 25;
const MAX_IMPORT_ROWS = 5000;

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;

const importStatuses = [
  "active",
  "unsubscribed",
  "bounced",
  "complained",
] as const;

const describeImport = (summary: ImportSummary, dryRun: boolean): string => {
  const verb = dryRun ? "Would import" : "Imported";

  const invalid =
    summary.invalidCount > 0
      ? ` ${summary.invalidCount} invalid address${summary.invalidCount === 1 ? "" : "es"} skipped.`
      : "";

  return `${verb} ${summary.total} rows: ${summary.created} new, ${summary.suppressed} existing subscribers suppressed, ${summary.unchanged} unchanged.${invalid}${dryRun ? " Nothing was written; run again without dryRun to import." : ""}`;
};

export const registerSubscriberTools = (
  server: McpServer,
  { config, db }: { config: Config; db: Database }
): void => {
  server.registerTool(
    "search_subscribers",
    {
      annotations: READ_ONLY,
      description:
        "Count subscribers by status and list them newest first, optionally filtered by part of an email address or by status. Page with the returned cursor.",
      inputSchema: z.object({
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(MAX_PAGE).optional(),
        query: z.string().optional().describe("Part of an email address."),
        status: z.enum(subscriberStatuses).optional(),
      }),
      title: "Search subscribers",
    },
    async ({ cursor, limit = DEFAULT_PAGE, query, status }) =>
      await run(async () => {
        const [counts, page] = await Promise.all([
          countSubscribers(db),
          searchSubscribers(db, { cursor, limit, query, status }),
        ]);

        return result(
          `${counts.active} active subscriber${counts.active === 1 ? "" : "s"} (${counts.total} total). Showing ${page.subscribers.length}.`,
          {
            counts,
            nextCursor: page.nextCursor,
            subscribers: page.subscribers.map((subscriber) =>
              presentSubscriber(subscriber)
            ),
          }
        );
      })
  );

  server.registerTool(
    "add_subscriber",
    {
      description:
        "Add one person. By default they get a confirmation email and only become active once they confirm. Set skipConfirmation only if the person explicitly asked to be added. Never re-adds someone who unsubscribed, bounced or complained.",
      inputSchema: z.object({
        email: z.string(),
        name: z.string().optional(),
        skipConfirmation: z.boolean().optional(),
      }),
      title: "Add subscriber",
    },
    async ({ email, name, skipConfirmation = false }) =>
      await run(async () => {
        const normalized = normalizeEmail(email);

        if (!isValidEmail(normalized)) {
          return failure(`"${email}" isn't a valid email address.`);
        }

        const existing = await findSubscriberByEmail(db, normalized);

        if (existing && existing.status !== "pending") {
          // Only an unsubscribe can be undone: the subscribe page won't email
          // an address that bounced or complained.
          const again =
            existing.status === "unsubscribed"
              ? " They can sign up again from the subscribe page."
              : "";

          return result(
            existing.status === "active"
              ? `${normalized} is already subscribed.`
              : `${normalized} is ${existing.status}, so they won't be re-added.${again}`
          );
        }

        if (skipConfirmation) {
          await (existing
            ? confirmSubscriber(db, existing.id)
            : importSubscribers(db, [
                { email: normalized, name, status: "active" },
              ]));

          return result(`Added ${normalized} as an active subscriber.`);
        }

        const settings = await getSettings(db);

        if (!settings) {
          return failure(
            "Set up Sendoff with update_settings before adding subscribers."
          );
        }

        const { outcome, subscriber } = await subscribe(db, {
          email: normalized,
          name,
          source: "mcp",
        });

        if (outcome === "recently_sent") {
          return result(
            `A confirmation email went to ${normalized} in the last few minutes; not sending another yet.`
          );
        }

        await sendConfirmationEmail(config, settings, subscriber);
        await markConfirmationSent(db, subscriber.id);

        return result(
          `Sent a confirmation email to ${normalized}. They'll be active once they confirm.`
        );
      })
  );

  server.registerTool(
    "import_subscribers",
    {
      description: `Import up to ${MAX_IMPORT_ROWS} subscribers given as a list, e.g. a few addresses the person pasted. For a CSV export, use import_csv. Use status to carry over unsubscribes, bounces and complaints from the old provider. Imported active subscribers are treated as already confirmed. Existing subscribers can be suppressed by an import but are never reactivated. Run dryRun first and wait for the person to confirm before importing.`,
      inputSchema: z.object({
        dryRun: z.boolean().optional(),
        subscribers: z
          .array(
            z.object({
              email: z.string(),
              name: z.string().optional(),
              status: z
                .enum(importStatuses)
                .optional()
                .describe("Defaults to active."),
            })
          )
          .min(1)
          .max(MAX_IMPORT_ROWS),
      }),
      title: "Import subscribers",
    },
    async ({ dryRun = false, subscribers }) =>
      await run(async () => {
        const rows = subscribers.map((row) => ({
          ...row,
          status: row.status ?? "active",
        }));

        const summary = await importSubscribers(db, rows, { dryRun });

        return result(describeImport(summary, dryRun), { ...summary });
      })
  );

  server.registerTool(
    "import_csv",
    {
      description: `Import subscribers from a CSV export from any provider. It needs an email column, under a header row (a plain list of addresses works too); name columns, a status column and unsubscribed/bounced/complained columns are detected. Suppressed rows are imported as suppressed; unconfirmed rows and statuses Sendoff doesn't recognize are skipped and reported, never imported as active. If the export leaves out unsubscribes or bounces, ask the person to export those too and import them with status. Always run dryRun first, show the person which columns were used and what was skipped, and wait for them to confirm before importing, even when the numbers look right. Pass the file's contents as csv for up to about 1,000 rows. For a bigger file, don't paste it: if you can run commands, create_api_key with scope subscribers:import, run \`curl --data-binary @file.csv -H "Authorization: Bearer <key>" -H "Content-Type: text/csv" "${config.publicUrl}/api/v1/subscribers/import?dryRun=true"\` (drop dryRun=true to import), then revoke_api_key. Otherwise import it in parts, or give the person that command to run.`,
      inputSchema: z.object({
        csv: z
          .string()
          .min(1)
          .max(MAX_CSV_BYTES)
          .describe("The file's contents, header row (if any) first."),
        dryRun: z.boolean().optional(),
        status: z
          .enum(suppressedStatuses)
          .optional()
          .describe(
            "Mark every row as this, for a file that only lists unsubscribes, bounces or complaints."
          ),
      }),
      title: "Import a CSV",
    },
    async ({ csv, dryRun = false, status }) =>
      await run(async () => {
        const report = await importCsv(db, csv, { dryRun, status });

        return result(describeCsvImport(report), { ...report });
      })
  );

  server.registerTool(
    "unsubscribe_subscriber",
    {
      annotations: { idempotentHint: true },
      description:
        "Unsubscribe someone, e.g. when they replied asking to be removed. They can resubscribe from the link in any past email.",
      inputSchema: z.object({ email: z.string() }),
      title: "Unsubscribe subscriber",
    },
    async ({ email }) =>
      await run(async () => {
        const subscriber = await findSubscriberByEmail(db, email);

        if (!subscriber) {
          return failure(
            `No subscriber with the email ${normalizeEmail(email)}.`
          );
        }

        const updated = await unsubscribeSubscriber(db, subscriber.id);

        return result(
          `${subscriber.email} is now ${updated?.status ?? subscriber.status}.`
        );
      })
  );
};
