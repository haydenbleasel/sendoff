import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "../db/client";
import { issues } from "../db/schema";
import { createId } from "../id";
import {
  IssueError,
  contentHash,
  isValidSlug,
  slugify,
  uniqueSlug,
} from "../issues";
import type { Issue } from "../issues";

// Past issues sent with another provider, kept exactly as they were sent:
// the original HTML and plain text, the subject, preview text and send date.
// They're stored as sent issues marked imported, so they can never be sent
// again, and stats and send status know Sendoff has no data for them.

export const MAX_ISSUE_HTML = 1_000_000;
export const MAX_ISSUE_TEXT = 500_000;
export const MAX_ISSUES_PER_IMPORT = 50;
export const MAX_ISSUE_IMPORT_BYTES = 10 * 1024 * 1024;

const MAX_SUBJECT = 200;
const MAX_MERGE_TAGS = 10;
const MS_PER_DAY = 86_400_000;
const EARLIEST_YEAR = 1990;
const ID_PREFIX_LENGTH = 8;
const HEX = 16;
const MAX_CODE_POINT = 0x10_ff_ff;

/**
 * ISO 8601, and the close variants providers export, like Resend's
 * `2025-03-01 09:00:00.123+00`. With no time zone, it's UTC.
 */
const TIMESTAMP =
  /^(?<date>\d{4}-\d{2}-\d{2})[T ](?<time>\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(?<zone>Z|[+-]\d{2}(?::?\d{2})?)?$/iu;

const ZONE_PARTS = /^(?<sign>[+-])(?<hours>\d{2}):?(?<minutes>\d{2})?$/u;

export const parseSentAt = (value: string): Date | null => {
  const match = TIMESTAMP.exec(value.trim());

  if (!match?.groups) {
    return null;
  }

  const { date = "", time = "", zone = "Z" } = match.groups;
  const parts = ZONE_PARTS.exec(zone)?.groups;

  const offset = parts
    ? `${parts.sign}${parts.hours}:${parts.minutes ?? "00"}`
    : "Z";

  const parsed = new Date(`${date}T${time}${offset}`);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

export const importedIssueSchema = z.object({
  html: z
    .string()
    .min(1)
    .max(MAX_ISSUE_HTML)
    .describe("The HTML as it was sent, kept exactly as given."),
  preheader: z
    .string()
    .trim()
    .max(MAX_SUBJECT)
    .optional()
    .describe("The preview text, if it had one."),
  sentAt: z
    .string()
    .describe(
      "When it was sent, in ISO 8601 (like 2025-03-01T09:00:00Z). Without a time zone, it's read as UTC."
    )
    .transform((value, context) => {
      const parsed = parseSentAt(value);
      const latest = Date.now() + MS_PER_DAY;

      if (
        !parsed ||
        parsed.getTime() > latest ||
        parsed.getUTCFullYear() < EARLIEST_YEAR
      ) {
        context.addIssue({
          code: "custom",
          message: `"${value}" isn't a past send date. Use ISO 8601, like 2025-03-01T09:00:00Z.`,
        });

        return z.NEVER;
      }

      return parsed;
    }),
  slug: z
    .string()
    .optional()
    .describe("Its web address slug. Defaults to one made from the subject."),
  subject: z.string().trim().min(1).max(MAX_SUBJECT),
  text: z
    .string()
    .max(MAX_ISSUE_TEXT)
    .optional()
    .describe(
      "The plain-text version. If it's missing, one is made from the HTML."
    ),
});

export type ImportedIssueInput = z.output<typeof importedIssueSchema>;

// --- Plain text from HTML -----------------------------------------------

// Comments, and elements whose contents aren't text a reader sees.
const HIDDEN =
  /<!--[\s\S]*?-->|<(?<tag>head|style|script|title|noscript)\b[^>]*>[\s\S]*?<\/\k<tag>\s*>/giu;

const LINK =
  /<a\b[^>]*?\shref="(?<href>https?:[^"]*)"[^>]*>(?<label>[\s\S]*?)<\/a\s*>/giu;

const LINE_BREAK = /<br\b[^>]*>/giu;
const LIST_ITEM = /<li\b[^>]*>/giu;

const BLOCK_END =
  /<\/(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|blockquote|section|article|header|footer)\s*>/giu;

// A tag, or one left unclosed at the end.
const TAG = /<[^>]+(?:>|$)/gu;
const ENTITY = /&(?:#(?<decimal>\d+)|#x(?<hex>[\da-f]+)|(?<name>[a-z]+));/giu;
const HORIZONTAL_SPACE = /[ \t\f\v\u00A0]+/gu;

// Zero-width and joiner characters, which emails pad their preheaders with.
const INVISIBLE = /\u00AD|\u034F|[\u200B-\u200D]|\u2060|\uFEFF/gu;
const BLANK_LINES = /\n{3,}/gu;

const NAMED_ENTITIES = new Map([
  ["amp", "&"],
  ["apos", "'"],
  ["bull", "•"],
  ["copy", "©"],
  ["gt", ">"],
  ["hellip", "…"],
  ["laquo", "«"],
  ["ldquo", "“"],
  ["lsquo", "‘"],
  ["lt", "<"],
  ["mdash", "—"],
  ["middot", "·"],
  ["nbsp", " "],
  ["ndash", "–"],
  ["quot", '"'],
  ["raquo", "»"],
  ["rdquo", "”"],
  ["reg", "®"],
  ["rsquo", "’"],
  ["shy", ""],
  ["trade", "™"],
  ["zwj", ""],
  ["zwnj", ""],
]);

const decodeEntity = (
  entity: string,
  decimal: string | undefined,
  hex: string | undefined,
  name: string | undefined
): string => {
  const code = decimal
    ? Math.trunc(Number(decimal))
    : Number.parseInt(hex ?? "", HEX);

  if (Number.isInteger(code) && code > 0 && code <= MAX_CODE_POINT) {
    return String.fromCodePoint(code);
  }

  return NAMED_ENTITIES.get(name?.toLowerCase() ?? "") ?? entity;
};

// Removing a match can join what was around it into a new one, as
// `<scr<script>…</script>ipt>` becomes `<script>`, so removals repeat until
// nothing changes. Real emails settle in a pass or two, and the cap keeps a
// pathological import within the CPU limit. Whatever a capped pass leaves of
// a hidden element is only its contents, as text, since the tags are removed
// last and TAG leaves none.
const MAX_REMOVAL_PASSES = 10;

const removeAll = (value: string, pattern: RegExp): string => {
  let current = value;

  for (let pass = 0; pass < MAX_REMOVAL_PASSES; pass += 1) {
    const next = current.replaceAll(pattern, "");

    if (next === current) {
      break;
    }

    current = next;
  }

  return current;
};

const linkText = (_link: string, href: string, label: string): string => {
  const words = removeAll(label, TAG).trim();

  return words && words !== href ? `${label} (${href})` : href;
};

/**
 * A readable plain-text version, for providers that only export HTML. It's
 * text, not HTML: markup the email showed escaped, like `&lt;b&gt;`, comes
 * out as the characters a reader saw, so it's escaped wherever it's shown.
 */
export const htmlToText = (html: string): string => {
  const marked = removeAll(html, HIDDEN)
    .replaceAll(LINK, linkText)
    .replaceAll(LINE_BREAK, "\n")
    .replaceAll(LIST_ITEM, "\n- ")
    .replaceAll(BLOCK_END, "\n\n");

  const text = removeAll(marked, TAG)
    .replaceAll(ENTITY, decodeEntity)
    .replaceAll(INVISIBLE, "");

  return text
    .split("\n")
    .map((line) => line.replaceAll(HORIZONTAL_SPACE, " ").trim())
    .join("\n")
    .replaceAll(BLANK_LINES, "\n\n")
    .trim();
};

// --- Merge tags ------------------------------------------------------------

/**
 * Placeholders the old provider filled in per recipient: Handlebars-style
 * {{{contact.first_name|there}}} or {{ first_name }}, and Mailchimp's *|FNAME|*.
 */
const MERGE_TAG =
  /\{\{\{[^{}]{1,100}\}\}\}|\{\{\s*[\w.]{1,60}\s*(?:\|[^{}]{0,60})?\}\}|\*\|[A-Z\d_:]{1,40}\|\*/gu;

export const findMergeTags = (...values: string[]): string[] => {
  const found = new Set<string>();

  for (const value of values) {
    for (const match of value.matchAll(MERGE_TAG)) {
      found.add(match[0]);
    }
  }

  return [...found].slice(0, MAX_MERGE_TAGS);
};

// --- Import ------------------------------------------------------------------

export interface ImportedIssue {
  issue: Issue;
  /** Leftover merge tags, which readers of the archived copy would see as-is. */
  mergeTags: string[];
  outcome: "created" | "updated";
}

const chooseSlug = async (
  db: Database,
  input: ImportedIssueInput,
  existing: Issue | undefined
): Promise<string> => {
  if (input.slug === undefined) {
    return (
      existing?.slug ??
      (await uniqueSlug(
        db,
        slugify(input.subject) ||
          `issue-${createId().slice(0, ID_PREFIX_LENGTH)}`
      ))
    );
  }

  if (!isValidSlug(input.slug)) {
    throw new IssueError(
      `"${input.slug}" isn't a valid slug. Use lowercase letters, numbers and single dashes.`
    );
  }

  if ((await uniqueSlug(db, input.slug, existing?.id)) !== input.slug) {
    throw new IssueError(`The slug "${input.slug}" is taken by another issue.`);
  }

  return input.slug;
};

/**
 * Import one past issue. The same subject and send date again replaces the
 * earlier import, so a corrected copy can be imported over it.
 */
export const importIssue = async (
  db: Database,
  input: ImportedIssueInput,
  now: Date = new Date()
): Promise<ImportedIssue> => {
  const content = {
    body: "",
    preheader: input.preheader || null,
    subject: input.subject,
  };

  const existing = await db.query.issues.findFirst({
    where: and(
      isNotNull(issues.importedAt),
      eq(issues.subject, content.subject),
      eq(issues.sentAt, input.sentAt)
    ),
  });

  const text = input.text?.trim() ? input.text : htmlToText(input.html);

  const values = {
    ...content,
    contentHash: await contentHash(content),
    renderedHtml: input.html,
    renderedText: text,
    sentAt: input.sentAt,
    slug: await chooseSlug(db, input, existing),
    status: "sent" as const,
    // Lists sort by this, so imported issues sit at the date they went out.
    updatedAt: input.sentAt,
  };

  const mergeTags = findMergeTags(
    content.subject,
    content.preheader ?? "",
    input.html,
    text
  );

  if (existing) {
    const [updated] = await db
      .update(issues)
      .set({ ...values, version: existing.version + 1 })
      .where(eq(issues.id, existing.id))
      .returning();

    return { issue: updated ?? existing, mergeTags, outcome: "updated" };
  }

  const [created] = await db
    .insert(issues)
    .values({
      ...values,
      id: createId(input.sentAt.getTime()),
      importedAt: now,
      version: 1,
    })
    .returning();

  if (!created) {
    throw new IssueError(`Couldn't import "${content.subject}".`);
  }

  return { issue: created, mergeTags, outcome: "created" };
};
