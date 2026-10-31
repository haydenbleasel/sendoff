import type { Nodes, Parent, Root, RootContent } from "mdast";
import { directiveFromMarkdown } from "mdast-util-directive";
import { fromMarkdown } from "mdast-util-from-markdown";
import { directive } from "micromark-extension-directive";

// The subset of Markdown an issue body may use. Anything outside it is
// reported as a problem with a line number and a fix, so an agent can
// correct the draft instead of getting a silently degraded email.

export interface MarkdownProblem {
  line: number;
  message: string;
}

export type ParseResult =
  | { ok: true; tree: Root }
  | { ok: false; problems: MarkdownProblem[] };

const MAX_HEADING_DEPTH = 3;
const LINK_PROTOCOL = /^(?:https?:|mailto:)/iu;
const IMAGE_PROTOCOL = /^https:/iu;
const BUTTON_PROTOCOL = /^https?:/iu;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;

const ALLOWED_TYPES = new Set<Nodes["type"]>([
  "blockquote",
  "break",
  "code",
  "containerDirective",
  "emphasis",
  "heading",
  "image",
  "inlineCode",
  "leafDirective",
  "link",
  "list",
  "listItem",
  "paragraph",
  "root",
  "strong",
  "text",
  "thematicBreak",
]);

const UNSUPPORTED: Partial<Record<Nodes["type"], string>> = {
  definition:
    "Reference-style links aren't supported. Use inline links like [text](https://…).",
  footnoteDefinition: "Footnotes aren't supported.",
  footnoteReference: "Footnotes aren't supported.",
  html: "Raw HTML isn't supported. Use Markdown, or the ::button and :::callout directives.",
  imageReference:
    "Reference-style images aren't supported. Use ![alt text](https://…).",
  linkReference:
    "Reference-style links aren't supported. Use inline links like [text](https://…).",
};

const lineOf = (node: Nodes): number => node.position?.start.line ?? 1;

const isParent = (node: Nodes): node is Nodes & Parent => "children" in node;

const textContent = (node: Nodes): string => {
  if ("value" in node) {
    return node.value;
  }

  if (isParent(node)) {
    return node.children.map((child) => textContent(child)).join("");
  }

  return "";
};

/**
 * Text directives (`:name`) are easy to trigger by accident in prose, so we
 * don't support them: turn each one back into the literal source text.
 */
const restoreTextDirectives = (node: Nodes, source: string): void => {
  if (!isParent(node)) {
    return;
  }

  const children: RootContent[] = node.children;

  for (const [index, child] of children.entries()) {
    if (child.type === "textDirective") {
      const start = child.position?.start.offset;
      const end = child.position?.end.offset;

      const value =
        start === undefined || end === undefined
          ? `:${child.name}`
          : source.slice(start, end);

      children[index] = { position: child.position, type: "text", value };
    } else {
      restoreTextDirectives(child, source);
    }
  }
};

const checkDirective = (node: Nodes, problems: MarkdownProblem[]): void => {
  const line = lineOf(node);

  if (node.type === "leafDirective") {
    if (node.name !== "button") {
      problems.push({
        line,
        message: `Unknown directive "::${node.name}". Supported directives are ::button and :::callout.`,
      });

      return;
    }

    const href = node.attributes?.href ?? "";

    if (!BUTTON_PROTOCOL.test(href)) {
      problems.push({
        line,
        message:
          'Buttons need an http(s) link: ::button[Label]{href="https://…"}.',
      });
    }

    if (textContent(node).trim() === "") {
      problems.push({
        line,
        message: 'Buttons need a label: ::button[Label]{href="https://…"}.',
      });
    }

    return;
  }

  if (node.type === "containerDirective" && node.name !== "callout") {
    problems.push({
      line,
      message: `Unknown directive ":::${node.name}". Supported directives are ::button and :::callout.`,
    });
  }
};

const checkNode = (node: Nodes, problems: MarkdownProblem[]): void => {
  const line = lineOf(node);
  const unsupported = UNSUPPORTED[node.type];

  if (unsupported) {
    problems.push({ line, message: unsupported });

    return;
  }

  if (!ALLOWED_TYPES.has(node.type)) {
    problems.push({ line, message: `Unsupported Markdown: ${node.type}.` });

    return;
  }

  if (node.type === "heading" && node.depth > MAX_HEADING_DEPTH) {
    problems.push({
      line,
      message:
        "Use #, ## or ### headings. #### and deeper aren't supported in email.",
    });
  }

  if (node.type === "link" && !LINK_PROTOCOL.test(node.url)) {
    problems.push({
      line,
      message: `Links must start with https://, http:// or mailto: (got "${node.url}").`,
    });
  }

  if (node.type === "image") {
    if (!IMAGE_PROTOCOL.test(node.url)) {
      problems.push({
        line,
        message: `Image URLs must use https:// (got "${node.url}").`,
      });
    }

    if (!node.alt?.trim()) {
      problems.push({
        line,
        message: "Images need alt text: ![A short description](https://…).",
      });
    }
  }

  checkDirective(node, problems);

  if (isParent(node)) {
    for (const child of node.children) {
      checkNode(child, problems);
    }
  }
};

export const parseMarkdown = (source: string): ParseResult => {
  if (FRONTMATTER.test(source)) {
    return {
      ok: false,
      problems: [
        {
          line: 1,
          message:
            "Don't put frontmatter in the body. Set the subject and preheader separately.",
        },
      ],
    };
  }

  const tree = fromMarkdown(source, {
    extensions: [directive()],
    mdastExtensions: [directiveFromMarkdown()],
  });

  if (tree.children.length === 0) {
    return {
      ok: false,
      problems: [{ line: 1, message: "The body is empty." }],
    };
  }

  restoreTextDirectives(tree, source);

  const problems: MarkdownProblem[] = [];
  checkNode(tree, problems);

  return problems.length > 0 ? { ok: false, problems } : { ok: true, tree };
};

/** Plain text of a node, for labels and alt text. */
export const toText = textContent;

export type BlockNode = RootContent;
