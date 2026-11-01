import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { createSes } from "../config";
import type { Config } from "../config";
import type { Database } from "../db/client";
import type { JsonObject } from "../json";
import { getSettings, saveSettings } from "../settings";
import type { Settings, SettingsDraft } from "../settings";
import { result, run } from "./results";

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;

const updateSchema = z.object({
  accent: z
    .string()
    .optional()
    .describe("Accent color for links, buttons and callouts, as #rrggbb."),
  address: z
    .string()
    .optional()
    .describe("Postal address for the footer. Required by anti-spam law."),
  description: z
    .string()
    .nullable()
    .optional()
    .describe("One or two sentences for the subscribe page. null removes it."),
  from: z
    .object({ email: z.string(), name: z.string() })
    .optional()
    .describe(
      "Sender. The email's domain must be verified in SES before sending."
    ),
  links: z
    .array(z.object({ label: z.string(), url: z.string() }))
    .optional()
    .describe("Footer links, e.g. Website or X. Replaces the whole list."),
  logo: z
    .object({
      darkUrl: z.string().optional(),
      height: z.number().int(),
      url: z.string(),
      width: z.number().int(),
    })
    .nullable()
    .optional()
    .describe(
      "https logo with its display size in pixels. null shows the name instead."
    ),
  name: z
    .string()
    .optional()
    .describe(
      "The name in every email's header and on the signup page, like a newsletter or brand name."
    ),
  replyTo: z
    .string()
    .nullable()
    .optional()
    .describe("Where replies go, if not the sender. null removes it."),
  tracking: z
    .object({
      clicks: z
        .boolean()
        .optional()
        .describe(
          "Count clicks by sending links in the HTML email through this Sendoff's domain. On by default."
        ),
      opens: z
        .boolean()
        .optional()
        .describe(
          "Count opens with a 1×1 image. Off by default: Apple Mail loads images automatically, so opens are always an estimate. Ask the person before turning it on."
        ),
    })
    .optional()
    .describe(
      "What issue_stats can measure. Applies to issues sent afterwards."
    ),
});

type SettingsUpdate = z.infer<typeof updateSchema>;

/** undefined keeps the current value; null clears an optional one. */
const pick = <T>(
  next: T | null | undefined,
  current: T | undefined
): T | undefined => (next === undefined ? current : (next ?? undefined));

const merge = (
  current: Settings | null,
  update: SettingsUpdate
): SettingsDraft => ({
  accent: update.accent ?? current?.accent,
  address: update.address ?? current?.address,
  description: pick(update.description, current?.description),
  from: update.from ?? current?.from,
  links: update.links ?? current?.links,
  logo: pick(update.logo, current?.logo),
  name: update.name ?? current?.name,
  replyTo: pick(update.replyTo, current?.replyTo),
  tracking: {
    clicks: update.tracking?.clicks ?? current?.tracking.clicks,
    opens: update.tracking?.opens ?? current?.tracking.opens,
  },
});

/** Warn (don't block) when the sender's domain isn't ready in SES; sending checks again. */
const senderWarnings = async (
  config: Config,
  email: string
): Promise<string[]> => {
  const domain = email.split("@").at(-1) ?? "";

  try {
    const ses = createSes(config);

    const identity =
      (await ses.getEmailIdentity(domain)) ??
      (await ses.getEmailIdentity(email));

    if (!identity) {
      return [
        `${domain} isn't set up in SES (${config.sesRegion}) yet. Sending will be blocked until it's verified.`,
      ];
    }

    return identity.verifiedForSending
      ? []
      : [
          `${domain} is in SES but not verified yet (DKIM: ${identity.dkimStatus ?? "unknown"}).`,
        ];
  } catch (error) {
    return [
      `Couldn't check SES for ${domain}: ${error instanceof Error ? error.message : String(error)}`,
    ];
  }
};

const present = (settings: Settings): JsonObject => ({ ...settings });

export const registerSettingsTools = (
  server: McpServer,
  { config, db }: { config: Config; db: Database }
): void => {
  server.registerTool(
    "get_settings",
    {
      annotations: READ_ONLY,
      description:
        "Get Sendoff's settings: name, sender, postal address, accent color, logo, footer links, and whether clicks and opens are tracked. Returns a setup hint if nothing is configured yet.",
      inputSchema: z.object({}),
      title: "Get settings",
    },
    async () =>
      await run(async () => {
        const settings = await getSettings(db);

        if (!settings) {
          return result(
            "Sendoff isn't set up yet. Ask for a name (a newsletter or brand name, shown in every email's header), the sender's name and email, and a postal address, then call update_settings."
          );
        }

        return result(`Settings for ${settings.name}.`, present(settings));
      })
  );

  server.registerTool(
    "update_settings",
    {
      annotations: { idempotentHint: true },
      description:
        "Update Sendoff's settings. Pass only the fields to change; the first call must include name, from and address. Changes apply to the preview immediately and to every email sent afterwards.",
      inputSchema: updateSchema,
      title: "Update settings",
    },
    async (update) =>
      await run(async () => {
        const saved = await saveSettings(
          db,
          merge(await getSettings(db), update)
        );

        const warnings = update.from
          ? await senderWarnings(config, saved.from.email)
          : [];

        const notes = warnings
          .map((warning) => `\nWarning: ${warning}`)
          .join("");

        return result(
          `Saved settings for ${saved.name}.${notes}`,
          present(saved)
        );
      })
  );
};
