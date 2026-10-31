import type { CallToolResult } from "@modelcontextprotocol/server";
import { ZodError, z } from "zod";

import type { Config } from "../config";
import { parseMarkdown } from "../email/markdown";
import type { MarkdownProblem } from "../email/markdown";
import { IssueError } from "../issues";
import type { Issue } from "../issues";
import type { JsonObject, JsonValue } from "../json";
import type { Subscriber } from "../subscribers";
import { createToken } from "../tokens";

export type ToolResult = CallToolResult;

/** A readable summary first, then the data as JSON for the agent to use. */
export const result = (summary: string, data?: JsonValue): ToolResult => ({
  content: [
    {
      text:
        data === undefined
          ? summary
          : `${summary}\n\n${JSON.stringify(data, null, 2)}`,
      type: "text",
    },
  ],
});

export const failure = (message: string): ToolResult => ({
  content: [{ text: message, type: "text" }],
  isError: true,
});

/** Turn expected errors into tool errors the agent can act on; rethrow bugs. */
export const run = async (
  task: () => Promise<ToolResult>
): Promise<ToolResult> => {
  try {
    return await task();
  } catch (error) {
    if (error instanceof IssueError) {
      return failure(error.message);
    }

    if (error instanceof ZodError) {
      return failure(z.prettifyError(error));
    }

    throw error;
  }
};

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

export const previewUrl = async (
  config: Config,
  issueId: string
): Promise<string> =>
  `${config.publicUrl}/preview/${await createToken(config.tokenSecret, "preview", issueId)}`;

export const problemsFor = (body: string): MarkdownProblem[] => {
  const parsed = parseMarkdown(body);

  return parsed.ok ? [] : parsed.problems;
};

export const describeProblems = (problems: MarkdownProblem[]): string =>
  problems.length === 0
    ? ""
    : `\n\nThe body has ${problems.length} problem${problems.length === 1 ? "" : "s"} to fix before it can render:\n${problems
        .map((problem) => `- Line ${problem.line}: ${problem.message}`)
        .join("\n")}`;

export const presentIssue = (
  issue: Issue,
  extra: JsonObject = {}
): JsonObject => ({
  id: issue.id,
  preheader: issue.preheader,
  sentAt: iso(issue.sentAt),
  slug: issue.slug,
  status: issue.status,
  subject: issue.subject,
  updatedAt: iso(issue.updatedAt),
  version: issue.version,
  ...extra,
});

export const presentSubscriber = (subscriber: Subscriber): JsonObject => ({
  confirmedAt: iso(subscriber.confirmedAt),
  createdAt: iso(subscriber.createdAt),
  email: subscriber.email,
  id: subscriber.id,
  lastEngagedAt: iso(subscriber.lastEngagedAt),
  name: subscriber.name,
  source: subscriber.source,
  status: subscriber.status,
  unsubscribedAt: iso(subscriber.unsubscribedAt),
});
