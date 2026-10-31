import { render } from "@react-email/render";

import type { Settings } from "../settings";
import { renderBlocks } from "./blocks";
import { IssueEmail } from "./layout";
import { parseMarkdown } from "./markdown";
import type { MarkdownProblem } from "./markdown";
import { toPlainText } from "./text";
import { createTheme } from "./theme";

/**
 * Rendered once per issue at send time, then swapped per recipient with
 * `personalize()`. Rendering per recipient would blow the Workers CPU budget.
 */
export const UNSUBSCRIBE_URL_PLACEHOLDER = "%%sendoff_unsubscribe_url%%";

export interface IssueContent {
  body: string;
  preheader?: string | undefined;
  subject: string;
}

export interface RenderedIssue {
  html: string;
  text: string;
}

export type RenderResult =
  | ({ ok: true } & RenderedIssue)
  | { ok: false; problems: MarkdownProblem[] };

export const renderIssue = async (
  issue: IssueContent,
  settings: Settings,
  unsubscribeUrl: string = UNSUBSCRIBE_URL_PLACEHOLDER
): Promise<RenderResult> => {
  const parsed = parseMarkdown(issue.body);

  if (!parsed.ok) {
    return parsed;
  }

  const theme = createTheme(settings);

  const html = await render(
    <IssueEmail
      preheader={issue.preheader}
      settings={settings}
      subject={issue.subject}
      theme={theme}
      unsubscribeUrl={unsubscribeUrl}
    >
      {renderBlocks(parsed.tree.children, theme)}
    </IssueEmail>
  );

  return {
    html,
    ok: true,
    text: toPlainText(parsed.tree, settings, unsubscribeUrl),
  };
};

const escapeAttribute = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

/** Fill a once-rendered issue in for one recipient. */
export const personalize = (
  rendered: RenderedIssue,
  { unsubscribeUrl }: { unsubscribeUrl: string }
): RenderedIssue => ({
  html: rendered.html.replaceAll(
    UNSUBSCRIBE_URL_PLACEHOLDER,
    escapeAttribute(unsubscribeUrl)
  ),
  text: rendered.text.replaceAll(UNSUBSCRIBE_URL_PLACEHOLDER, unsubscribeUrl),
});
