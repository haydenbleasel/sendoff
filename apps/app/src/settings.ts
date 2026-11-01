import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "./db/client";
import { settings as settingsTable } from "./db/schema";

const SETTINGS_ROW_ID = 1;
const MAX_LOGO_WIDTH = 560;
const MAX_LOGO_HEIGHT = 200;
const MAX_LINKS = 6;

const httpsUrl = z.url({ protocol: /^https$/u });

export const settingsSchema = z.object({
  /** Accent color for links, buttons and callouts, as #rrggbb. */
  accent: z
    .string()
    .regex(/^#[\da-f]{6}$/iu, "Use a 6-digit hex color like #2563eb")
    .transform((value) => value.toLowerCase())
    .default("#2563eb"),
  /**
   * Postal address shown in the footer. Commercial email needs one (CAN-SPAM,
   * CASL); without it, prepare_send checks each issue isn't promotional.
   */
  address: z.string().trim().min(1).max(300).optional(),
  /** One or two sentences for the subscribe page. */
  description: z.string().trim().min(1).max(280).optional(),
  from: z.object({
    email: z.email(),
    name: z.string().trim().min(1).max(100),
  }),
  links: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(40),
        url: z.url({ protocol: /^https?$/u }),
      })
    )
    .max(MAX_LINKS)
    .default([]),
  /** Display size in CSS pixels. Email clients need explicit dimensions. */
  logo: z
    .object({
      darkUrl: httpsUrl.optional(),
      height: z.int().min(1).max(MAX_LOGO_HEIGHT),
      url: httpsUrl,
      width: z.int().min(1).max(MAX_LOGO_WIDTH),
    })
    .optional(),
  name: z.string().trim().min(1).max(100),
  replyTo: z.email().optional(),
  tracking: z
    .object({
      /** Count clicks by sending links through Sendoff's own domain. */
      clicks: z.boolean().default(true),
      /** Count opens with a 1×1 image. Apple Mail's automatic loads are counted separately. */
      opens: z.boolean().default(false),
    })
    .prefault({}),
});

export type Settings = z.output<typeof settingsSchema>;

export type SettingsInput = z.input<typeof settingsSchema>;

/** Possibly incomplete settings, validated by saveSettings. */
export type SettingsDraft = {
  [Key in keyof SettingsInput]?: SettingsInput[Key] | undefined;
};

export interface SettingsRecord {
  settings: Settings;
  updatedAt: Date;
}

export const getSettingsRecord = async (
  db: Database
): Promise<SettingsRecord | null> => {
  const row = await db.query.settings.findFirst({
    where: eq(settingsTable.id, SETTINGS_ROW_ID),
  });

  if (!row) {
    return null;
  }

  return { settings: settingsSchema.parse(row.data), updatedAt: row.updatedAt };
};

export const getSettings = async (db: Database): Promise<Settings | null> => {
  const record = await getSettingsRecord(db);

  return record?.settings ?? null;
};

export const saveSettings = async (
  db: Database,
  input: SettingsDraft
): Promise<Settings> => {
  const data = settingsSchema.parse(input);
  const updatedAt = new Date();

  await db
    .insert(settingsTable)
    .values({ data, id: SETTINGS_ROW_ID, updatedAt })
    .onConflictDoUpdate({
      set: { data, updatedAt },
      target: settingsTable.id,
    });

  return data;
};
