import { z } from "zod";

import type { ImportRow } from "../subscribers";

// Reads contacts from Resend so they can be passed to `importSubscribers`.
// Resend's API exposes `unsubscribed` but not bounces or suppressions, so
// those have to be imported separately (e.g. from a dashboard export).

const API_URL = "https://api.resend.com";
const PAGE_SIZE = 100;

// Resend's default rate limit is a few requests per second.
const PAGE_DELAY_MS = 600;
const MAX_RETRIES = 5;
const DEFAULT_RETRY_SECONDS = 1;
const MS_PER_SECOND = 1000;
const HTTP_TOO_MANY_REQUESTS = 429;

const contactSchema = z.object({
  email: z.string(),
  first_name: z.string().nullish(),
  id: z.string(),
  last_name: z.string().nullish(),
  unsubscribed: z.boolean(),
});

const pageSchema = z.object({
  data: z.array(contactSchema),
  has_more: z.boolean(),
});

export interface ResendImportOptions {
  apiKey: string;
  fetcher?: typeof fetch;
  /** Only import contacts in this segment. */
  segmentId?: string | undefined;
  /** Injected in tests to skip real delays. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => scheduler.wait(ms);

const toRow = (contact: z.infer<typeof contactSchema>): ImportRow => {
  const name = [contact.first_name, contact.last_name]
    .filter((part) => part !== null && part !== undefined && part.trim() !== "")
    .join(" ");

  return {
    email: contact.email,
    name: name === "" ? undefined : name,
    status: contact.unsubscribed ? "unsubscribed" : "active",
  };
};

const fetchPage = async (
  url: URL,
  { apiKey, fetcher = fetch, sleep = defaultSleep }: ResendImportOptions,
  attempt = 0
): Promise<z.infer<typeof pageSchema>> => {
  const response = await fetcher(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (response.status === HTTP_TOO_MANY_REQUESTS && attempt < MAX_RETRIES) {
    const retryAfter = Number(response.headers.get("retry-after"));

    const seconds =
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter
        : DEFAULT_RETRY_SECONDS;

    await sleep(seconds * MS_PER_SECOND);

    return await fetchPage(url, { apiKey, fetcher, sleep }, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(
      `Resend API returned ${response.status}: ${await response.text()}`
    );
  }

  return pageSchema.parse(await response.json());
};

/** Fetch every contact (or every contact in a segment), following the cursor. */
export const fetchResendContacts = async (
  options: ResendImportOptions
): Promise<ImportRow[]> => {
  const { segmentId, sleep = defaultSleep } = options;

  const path = segmentId
    ? `/segments/${encodeURIComponent(segmentId)}/contacts`
    : "/contacts";

  const rows: ImportRow[] = [];
  let after: string | undefined;

  for (;;) {
    const url = new URL(path, API_URL);

    url.searchParams.set("limit", String(PAGE_SIZE));

    if (after) {
      url.searchParams.set("after", after);
      // oxlint-disable-next-line no-await-in-loop -- pages are sequential by design
      await sleep(PAGE_DELAY_MS);
    }

    // oxlint-disable-next-line no-await-in-loop -- each page needs the previous cursor
    const page = await fetchPage(url, options);

    rows.push(...page.data.map((contact) => toRow(contact)));
    after = page.data.at(-1)?.id;

    if (!page.has_more || after === undefined) {
      return rows;
    }
  }
};
