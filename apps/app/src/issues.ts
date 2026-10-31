import { and, desc, eq, like, or } from "drizzle-orm";

import type { Database } from "./db/client";
import { issues } from "./db/schema";
import type { issueStatuses } from "./db/schema";
import { createId } from "./id";

export type Issue = typeof issues.$inferSelect;

export type IssueStatus = (typeof issueStatuses)[number];

const MAX_SLUG_LENGTH = 60;
const ID_PREFIX_LENGTH = 8;
const QUOTE_LENGTH = 60;
const HEX = 16;
const COMBINING_MARKS = /[̀-ͯ]/gu;
const NON_SLUG = /[^a-z\d]+/gu;
const EDGE_DASHES = /^-+|-+$/gu;
const SLUG_SUFFIX = /-\d+$/u;
const VALID_SLUG = /^[a-z\d]+(?:-[a-z\d]+)*$/u;

export class IssueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueError";
  }
}

export const slugify = (value: string): string =>
  value
    .normalize("NFKD")
    .replaceAll(COMBINING_MARKS, "")
    .toLowerCase()
    .replaceAll(NON_SLUG, "-")
    .replaceAll(EDGE_DASHES, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replaceAll(EDGE_DASHES, "");

export const isValidSlug = (slug: string): boolean =>
  slug.length <= MAX_SLUG_LENGTH && VALID_SLUG.test(slug);

/** Identifies the exact content of an issue; a test send records it, and sending requires a match. */
export const contentHash = async ({
  body,
  preheader,
  subject,
}: Pick<Issue, "body" | "preheader" | "subject">): Promise<string> => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([subject, preheader ?? "", body]))
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(HEX).padStart(2, "0"))
    .join("");
};

const uniqueSlug = async (
  db: Database,
  base: string,
  exceptId?: string
): Promise<string> => {
  // Slugs only contain [a-z0-9-], so there are no LIKE wildcards to escape.
  const rows = await db
    .select({ id: issues.id, slug: issues.slug })
    .from(issues)
    .where(or(eq(issues.slug, base), like(issues.slug, `${base}-%`)));

  const taken = new Set(
    rows.filter((row) => row.id !== exceptId).map((row) => row.slug)
  );

  if (!taken.has(base)) {
    return base;
  }

  const stem = base.replace(SLUG_SUFFIX, "");
  let suffix = 2;

  while (taken.has(`${stem}-${suffix}`)) {
    suffix += 1;
  }

  return `${stem}-${suffix}`;
};

/** Look an issue up by id or slug. */
export const findIssue = async (
  db: Database,
  ref: string
): Promise<Issue | undefined> =>
  await db.query.issues.findFirst({
    where: or(eq(issues.id, ref), eq(issues.slug, ref)),
  });

export const requireIssue = async (
  db: Database,
  ref: string
): Promise<Issue> => {
  const issue = await findIssue(db, ref);

  if (!issue) {
    throw new IssueError(
      `No issue with id or slug "${ref}". Use list_issues to find it.`
    );
  }

  return issue;
};

const requireDraft = async (db: Database, ref: string): Promise<Issue> => {
  const issue = await requireIssue(db, ref);

  if (issue.status !== "draft") {
    throw new IssueError(
      `"${issue.subject}" is ${issue.status}, so it can't be edited. Create a new draft instead.`
    );
  }

  return issue;
};

export const listIssues = async (
  db: Database,
  {
    limit = 20,
    status,
  }: { limit?: number; status?: IssueStatus | undefined } = {}
): Promise<Issue[]> =>
  await db
    .select()
    .from(issues)
    .where(status ? eq(issues.status, status) : undefined)
    .orderBy(desc(issues.updatedAt))
    .limit(limit);

export interface DraftInput {
  body: string;
  preheader?: string | undefined;
  subject: string;
}

export const createDraft = async (
  db: Database,
  input: DraftInput,
  now: Date = new Date()
): Promise<Issue> => {
  const id = createId(now.getTime());

  const base =
    slugify(input.subject) || `draft-${id.slice(0, ID_PREFIX_LENGTH)}`;

  const content = {
    body: input.body,
    preheader: input.preheader?.trim() || null,
    subject: input.subject.trim(),
  };

  const [created] = await db
    .insert(issues)
    .values({
      ...content,
      contentHash: await contentHash(content),
      id,
      slug: await uniqueSlug(db, base),
      status: "draft",
      updatedAt: now,
      version: 1,
    })
    .returning();

  if (!created) {
    throw new IssueError("Couldn't create the draft.");
  }

  return created;
};

const saveContent = async (
  db: Database,
  issue: Issue,
  changes: Partial<Pick<Issue, "body" | "preheader" | "slug" | "subject">>,
  now: Date
): Promise<Issue> => {
  const next = { ...issue, ...changes };

  const contentChanged =
    next.body !== issue.body ||
    next.preheader !== issue.preheader ||
    next.subject !== issue.subject;

  // Guard on version so two concurrent edits can't silently overwrite each other.
  const [saved] = await db
    .update(issues)
    .set({
      ...changes,
      contentHash: await contentHash(next),
      updatedAt: now,
      version: contentChanged ? issue.version + 1 : issue.version,
    })
    .where(and(eq(issues.id, issue.id), eq(issues.version, issue.version)))
    .returning();

  if (!saved) {
    throw new IssueError(
      "The draft changed while you were editing it. Fetch it again with get_draft and retry."
    );
  }

  return saved;
};

export interface TextEdit {
  newText: string;
  oldText: string;
  /** Replace every occurrence instead of requiring exactly one. */
  replaceAll?: boolean | undefined;
}

const quote = (text: string): string =>
  JSON.stringify(
    text.length > QUOTE_LENGTH ? `${text.slice(0, QUOTE_LENGTH)}…` : text
  );

const countOccurrences = (haystack: string, needle: string): number =>
  haystack.split(needle).length - 1;

/** Apply exact find/replace edits in order. All or nothing. */
export const applyEdits = (body: string, edits: TextEdit[]): string => {
  let current = body;

  for (const [index, edit] of edits.entries()) {
    const label = `Edit ${index + 1}`;

    if (edit.oldText === "") {
      throw new IssueError(
        `${label}: oldText is empty. Quote the text you want to replace.`
      );
    }

    const occurrences = countOccurrences(current, edit.oldText);

    if (occurrences === 0) {
      throw new IssueError(
        `${label}: ${quote(edit.oldText)} isn't in the draft. Copy it exactly from get_draft, including punctuation and line breaks.`
      );
    }

    if (occurrences > 1 && !edit.replaceAll) {
      throw new IssueError(
        `${label}: ${quote(edit.oldText)} appears ${occurrences} times. Include more surrounding text, or set replaceAll.`
      );
    }

    // A replacer function keeps `$&` and friends in newText literal.
    current = edit.replaceAll
      ? current.replaceAll(edit.oldText, () => edit.newText)
      : current.replace(edit.oldText, () => edit.newText);
  }

  return current;
};

export const editDraft = async (
  db: Database,
  ref: string,
  {
    body,
    edits,
    expectedVersion,
  }: {
    body?: string | undefined;
    edits?: TextEdit[] | undefined;
    expectedVersion?: number | undefined;
  },
  now: Date = new Date()
): Promise<Issue> => {
  const issue = await requireDraft(db, ref);

  if (expectedVersion !== undefined && expectedVersion !== issue.version) {
    throw new IssueError(
      `The draft is at version ${issue.version}, not ${expectedVersion}. Fetch it again with get_draft.`
    );
  }

  if ((body === undefined) === (edits === undefined)) {
    throw new IssueError(
      "Pass either edits (for targeted changes) or body (to replace everything)."
    );
  }

  const nextBody = body ?? applyEdits(issue.body, edits ?? []);

  return await saveContent(db, issue, { body: nextBody }, now);
};

export const setDraftMeta = async (
  db: Database,
  ref: string,
  {
    preheader,
    slug,
    subject,
  }: {
    preheader?: string | null | undefined;
    slug?: string | undefined;
    subject?: string | undefined;
  },
  now: Date = new Date()
): Promise<Issue> => {
  const issue = await requireDraft(db, ref);
  const changes: Partial<Pick<Issue, "preheader" | "slug" | "subject">> = {};

  if (subject !== undefined) {
    if (subject.trim() === "") {
      throw new IssueError("The subject can't be empty.");
    }

    changes.subject = subject.trim();
  }

  if (preheader !== undefined) {
    changes.preheader = preheader?.trim() || null;
  }

  if (slug !== undefined) {
    if (!isValidSlug(slug)) {
      throw new IssueError(
        `"${slug}" isn't a valid slug. Use lowercase letters, numbers and single dashes.`
      );
    }

    const unique = await uniqueSlug(db, slug, issue.id);

    if (unique !== slug) {
      throw new IssueError(`The slug "${slug}" is taken by another issue.`);
    }

    changes.slug = slug;
  }

  return await saveContent(db, issue, changes, now);
};

export const deleteDraft = async (
  db: Database,
  ref: string
): Promise<Issue> => {
  const issue = await requireDraft(db, ref);

  await db
    .delete(issues)
    .where(and(eq(issues.id, issue.id), eq(issues.status, "draft")));

  return issue;
};
