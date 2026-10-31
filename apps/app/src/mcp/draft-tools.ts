import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { Config } from "../config";
import type { Database } from "../db/client";
import { issueStatuses } from "../db/schema";
import { renderIssue } from "../email/render";
import { sampleSettings } from "../email/sample";
import {
  createDraft,
  deleteDraft,
  editDraft,
  listIssues,
  requireIssue,
  setDraftMeta,
} from "../issues";
import type { Issue } from "../issues";
import { getSettings } from "../settings";
import { MARKDOWN_GUIDE } from "./instructions";
import {
  describeProblems,
  presentIssue,
  previewUrl,
  problemsFor,
  result,
  run,
} from "./results";

const MAX_SUBJECT = 200;
const MAX_BODY = 100_000;
const MAX_EDITS = 50;
const MAX_LIST = 100;
const DEFAULT_LIST = 20;

const READ_ONLY = { idempotentHint: true, readOnlyHint: true } as const;

const issueRef = z
  .string()
  .min(1)
  .describe("The issue's id or slug, from create_draft or list_issues.");

const editSchema = z.object({
  newText: z.string().describe("The replacement text. Empty deletes oldText."),
  oldText: z
    .string()
    .min(1)
    .describe(
      "Exact text to replace, copied from get_draft. Must appear exactly once unless replaceAll is set."
    ),
  replaceAll: z.boolean().optional().describe("Replace every occurrence."),
});

export const registerDraftTools = (
  server: McpServer,
  { config, db }: { config: Config; db: Database }
): void => {
  const describeDraft = async (
    issue: Issue,
    verb: string
  ): Promise<{ summary: string; url: string }> => {
    const url = await previewUrl(config, issue.id);
    const problems = describeProblems(problemsFor(issue.body));

    return {
      summary: `${verb} "${issue.subject}" (slug ${issue.slug}, version ${issue.version}).\nPreview: ${url}${problems}`,
      url,
    };
  };

  server.registerTool(
    "create_draft",
    {
      description: `Start a new issue. Returns a live preview URL to share with the person; it refreshes as the draft changes.\n\n${MARKDOWN_GUIDE}`,
      inputSchema: z.object({
        body: z.string().max(MAX_BODY).describe("The issue body in Markdown."),
        preheader: z
          .string()
          .max(MAX_SUBJECT)
          .optional()
          .describe("Preview text shown after the subject in most inboxes."),
        subject: z
          .string()
          .min(1)
          .max(MAX_SUBJECT)
          .describe("The email subject line."),
      }),
      title: "Create draft",
    },
    async (input) =>
      await run(async () => {
        const issue = await createDraft(db, input);
        const { summary, url } = await describeDraft(issue, "Created");

        return result(summary, presentIssue(issue, { previewUrl: url }));
      })
  );

  server.registerTool(
    "get_draft",
    {
      annotations: READ_ONLY,
      description:
        "Get an issue's subject, preheader, Markdown body, version and preview URL. Read it before edit_draft so oldText matches exactly.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Get draft",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const issue = await requireIssue(db, ref);
        const { summary, url } = await describeDraft(issue, "Draft");

        return result(
          summary,
          presentIssue(issue, { body: issue.body, previewUrl: url })
        );
      })
  );

  server.registerTool(
    "edit_draft",
    {
      description:
        "Change a draft's body. Prefer edits (exact find/replace, applied in order, all or nothing). Pass body instead to replace the whole thing. Pass expectedVersion from get_draft to avoid overwriting someone else's change.",
      inputSchema: z.object({
        body: z
          .string()
          .max(MAX_BODY)
          .optional()
          .describe("A complete replacement body."),
        edits: z.array(editSchema).min(1).max(MAX_EDITS).optional(),
        expectedVersion: z.number().int().optional(),
        issue: issueRef,
      }),
      title: "Edit draft",
    },
    async ({ body, edits, expectedVersion, issue: ref }) =>
      await run(async () => {
        const issue = await editDraft(db, ref, {
          body,
          edits,
          expectedVersion,
        });

        const { summary, url } = await describeDraft(issue, "Updated");

        return result(summary, presentIssue(issue, { previewUrl: url }));
      })
  );

  server.registerTool(
    "set_draft_meta",
    {
      description:
        "Change a draft's subject, preheader (null clears it) or slug (used in its web address later).",
      inputSchema: z.object({
        issue: issueRef,
        preheader: z.string().max(MAX_SUBJECT).nullable().optional(),
        slug: z.string().optional(),
        subject: z.string().min(1).max(MAX_SUBJECT).optional(),
      }),
      title: "Set draft subject, preheader or slug",
    },
    async ({ issue: ref, ...meta }) =>
      await run(async () => {
        const issue = await setDraftMeta(db, ref, meta);
        const { summary, url } = await describeDraft(issue, "Updated");

        return result(summary, presentIssue(issue, { previewUrl: url }));
      })
  );

  server.registerTool(
    "list_issues",
    {
      annotations: READ_ONLY,
      description: "List issues, most recently updated first.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(MAX_LIST).optional(),
        status: z.enum(issueStatuses).optional(),
      }),
      title: "List issues",
    },
    async ({ limit = DEFAULT_LIST, status }) =>
      await run(async () => {
        const issues = await listIssues(db, { limit, status });

        if (issues.length === 0) {
          return result(
            status
              ? `No ${status} issues.`
              : "No issues yet. Start one with create_draft."
          );
        }

        return result(
          `${issues.length} issue${issues.length === 1 ? "" : "s"}.`,
          issues.map((issue) => presentIssue(issue))
        );
      })
  );

  server.registerTool(
    "preview_draft",
    {
      annotations: READ_ONLY,
      description:
        "Get the live preview URL for an issue, plus its plain-text version so you can proofread it yourself.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Preview draft",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const issue = await requireIssue(db, ref);
        const { summary, url } = await describeDraft(issue, "Preview of");
        const settings = (await getSettings(db)) ?? sampleSettings;

        const rendered = await renderIssue(
          {
            body: issue.body,
            preheader: issue.preheader ?? undefined,
            subject: issue.subject,
          },
          settings,
          "{unsubscribe link}"
        );

        return result(
          rendered.ok
            ? `${summary}\n\nPlain-text version:\n\n${rendered.text}`
            : summary,
          presentIssue(issue, { previewUrl: url })
        );
      })
  );

  server.registerTool(
    "delete_draft",
    {
      annotations: { destructiveHint: true },
      description: "Delete a draft. Sent issues can't be deleted.",
      inputSchema: z.object({ issue: issueRef }),
      title: "Delete draft",
    },
    async ({ issue: ref }) =>
      await run(async () => {
        const issue = await deleteDraft(db, ref);

        return result(`Deleted the draft "${issue.subject}".`);
      })
  );
};
