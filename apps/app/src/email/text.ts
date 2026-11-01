import type { ListItem, PhrasingContent, Root, RootContent } from "mdast";

import type { Settings } from "../settings";
import { toText } from "./markdown";

// The plain-text alternative, written from the Markdown tree rather than
// scraped from the HTML, so it reads like a hand-written text email.

const INDENT = "  ";

const indent = (value: string, prefix: string): string =>
  value
    .split("\n")
    .map((line) => (line === "" ? prefix.trimEnd() : `${prefix}${line}`))
    .join("\n");

const inline = (nodes: PhrasingContent[]): string =>
  nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "inlineCode": {
          return node.value;
        }

        case "emphasis":
        case "strong": {
          return inline(node.children);
        }

        case "break": {
          return "\n";
        }

        case "image": {
          return node.alt ? `[${node.alt}]` : "";
        }

        case "link": {
          const label = inline(node.children);
          const url = node.url.replace(/^mailto:/iu, "");

          return label === "" || label === url || label === node.url
            ? url
            : `${label} (${url})`;
        }

        default: {
          return "";
        }
      }
    })
    .join("");

const underline = (value: string, character: string): string =>
  `${value}\n${character.repeat([...value].length)}`;

const listItem = (node: ListItem, marker: string): string => {
  // eslint-disable-next-line no-use-before-define -- list items nest blocks
  const body = blocks(node.children);
  const [first = "", ...rest] = body.split("\n");
  const continuation = " ".repeat(marker.length + 1);

  return [
    `${marker} ${first}`,
    ...rest.map((line) => (line === "" ? "" : `${continuation}${line}`)),
  ].join("\n");
};

const block = (node: RootContent): string => {
  switch (node.type) {
    case "paragraph": {
      return inline(node.children);
    }

    case "heading": {
      const value = inline(node.children);

      if (node.depth === 1) {
        return underline(value, "=");
      }

      return node.depth === 2 ? underline(value, "-") : value;
    }

    case "list": {
      const start = node.start ?? 1;
      const separator = node.spread ? "\n\n" : "\n";

      return node.children
        .map((item, index) =>
          listItem(item, node.ordered ? `${start + index}.` : "-")
        )
        .join(separator);
    }

    case "blockquote": {
      // eslint-disable-next-line no-use-before-define -- blockquotes nest blocks
      return indent(blocks(node.children), "> ");
    }

    case "code": {
      return indent(node.value, INDENT);
    }

    case "thematicBreak": {
      return "---";
    }

    case "leafDirective": {
      return `${toText(node)}: ${node.attributes?.href ?? ""}`;
    }

    case "containerDirective": {
      // eslint-disable-next-line no-use-before-define -- callouts nest blocks
      return blocks(node.children);
    }

    default: {
      return "";
    }
  }
};

const blocks = (nodes: RootContent[]): string =>
  nodes
    .flatMap((node) => {
      const value = block(node);

      return value === "" ? [] : [value];
    })
    .join("\n\n");

export const toPlainText = (
  tree: Root,
  settings: Settings,
  unsubscribeUrl: string
): string =>
  [
    blocks(tree.children),
    "--",
    `You're receiving this because you subscribed to ${settings.name}.`,
    `Unsubscribe: ${unsubscribeUrl}`,
    settings.address,
  ]
    .filter(Boolean)
    .join("\n\n");
