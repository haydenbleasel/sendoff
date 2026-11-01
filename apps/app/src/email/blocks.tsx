import {
  Button,
  Column,
  Heading,
  Hr,
  Img,
  Link,
  Row,
  Section,
  Text,
} from "@react-email/components";
import type {
  Blockquote,
  Code,
  Heading as HeadingNode,
  Image,
  List,
  ListItem,
  Nodes,
  Paragraph,
  PhrasingContent,
  RootContent,
} from "mdast";
import type { ContainerDirective, LeafDirective } from "mdast-util-directive";
import type { CSSProperties, ReactNode } from "react";

import { toText } from "./markdown";
import { CONTENT_WIDTH, darkClass, fonts, light } from "./theme";
import type { Theme } from "./theme";

// Turns a validated Markdown tree into React Email components. Every style
// is inline because most email clients drop <style> blocks; the dark-mode
// classes are a progressive enhancement on top.

interface Placement {
  first: boolean;
  last: boolean;
}

const BLOCK_GAP = 20;
const BODY_FONT_SIZE = 16;
const BODY_LINE_HEIGHT = "26px";
const RADIUS = 8;

const headingStyles: Record<1 | 2 | 3, CSSProperties> = {
  1: {
    fontSize: 28,
    letterSpacing: "-0.02em",
    lineHeight: "36px",
    marginTop: 40,
  },
  2: {
    fontSize: 21,
    letterSpacing: "-0.01em",
    lineHeight: "28px",
    marginTop: 36,
  },
  3: { fontSize: 17, lineHeight: "26px", marginTop: 28 },
};

const headingGap: Record<1 | 2 | 3, number> = { 1: 16, 2: 12, 3: 8 };

const clampDepth = (depth: number): 1 | 2 | 3 => {
  if (depth <= 1) {
    return 1;
  }

  return depth === 2 ? 2 : 3;
};

const keyOf = (node: Nodes): string =>
  `${node.type}:${node.position?.start.offset ?? 0}`;

const spacing = (
  { first, last }: Placement,
  top: number,
  bottom = BLOCK_GAP
): CSSProperties => ({
  marginBottom: last ? 0 : bottom,
  marginLeft: 0,
  marginRight: 0,
  marginTop: first ? 0 : top,
});

export const textStyle: CSSProperties = {
  color: light.text,
  fontSize: BODY_FONT_SIZE,
  lineHeight: BODY_LINE_HEIGHT,
};

const inlineCodeStyle: CSSProperties = {
  backgroundColor: light.subtle,
  borderRadius: 4,
  fontFamily: fonts.mono,
  fontSize: "0.875em",
  padding: "2px 5px",
};

const imageStyle: CSSProperties = {
  border: 0,
  borderRadius: RADIUS,
  display: "block",
  height: "auto",
  maxWidth: "100%",
  outline: "none",
  width: "100%",
};

// Inside a line of text: the image's own size, capped at the column width.
// Only an image on a line of its own spans the full width.
const inlineImageStyle: CSSProperties = {
  border: 0,
  display: "inline",
  height: "auto",
  maxWidth: "100%",
  outline: "none",
  verticalAlign: "middle",
};

const renderInlineImage = (node: Image) => (
  <Img
    alt={node.alt ?? ""}
    key={keyOf(node)}
    src={node.url}
    style={inlineImageStyle}
  />
);

const renderImage = (node: Image) => (
  <Img
    alt={node.alt ?? ""}
    key={keyOf(node)}
    src={node.url}
    style={imageStyle}
    width={CONTENT_WIDTH}
  />
);

const renderInline = (nodes: PhrasingContent[], theme: Theme): ReactNode[] =>
  // eslint-disable-next-line no-use-before-define -- mutually recursive with renderPhrasing
  nodes.map((node) => renderPhrasing(node, theme));

const renderPhrasing = (node: PhrasingContent, theme: Theme): ReactNode => {
  switch (node.type) {
    case "text": {
      return node.value;
    }

    case "emphasis": {
      return <em key={keyOf(node)}>{renderInline(node.children, theme)}</em>;
    }

    case "strong": {
      return (
        <strong key={keyOf(node)} style={{ fontWeight: 600 }}>
          {renderInline(node.children, theme)}
        </strong>
      );
    }

    case "inlineCode": {
      return (
        <code
          className={darkClass.subtle}
          key={keyOf(node)}
          style={inlineCodeStyle}
        >
          {node.value}
        </code>
      );
    }

    case "break": {
      return <br key={keyOf(node)} />;
    }

    case "link": {
      return (
        <Link
          className={darkClass.link}
          href={node.url}
          key={keyOf(node)}
          style={{ color: theme.link, textDecoration: "underline" }}
        >
          {renderInline(node.children, theme)}
        </Link>
      );
    }

    case "image": {
      return renderInlineImage(node);
    }

    default: {
      return null;
    }
  }
};

/** A paragraph that is only an image (optionally linked) renders as a block. */
const renderStandaloneImage = (
  node: Paragraph,
  placement: Placement
): ReactNode | null => {
  const [only] = node.children;

  if (node.children.length !== 1 || !only) {
    return null;
  }

  const wrapper: CSSProperties = spacing(placement, 8, 24);

  if (only.type === "image") {
    return (
      <Section key={keyOf(node)} style={wrapper}>
        {renderImage(only)}
      </Section>
    );
  }

  const [linked] = only.type === "link" ? only.children : [];

  if (
    only.type === "link" &&
    only.children.length === 1 &&
    linked?.type === "image"
  ) {
    return (
      <Section key={keyOf(node)} style={wrapper}>
        <Link href={only.url}>{renderImage(linked)}</Link>
      </Section>
    );
  }

  return null;
};

const renderParagraph = (node: Paragraph, theme: Theme, placement: Placement) =>
  renderStandaloneImage(node, placement) ?? (
    <Text
      className={darkClass.text}
      key={keyOf(node)}
      style={{ ...textStyle, ...spacing(placement, 0) }}
    >
      {renderInline(node.children, theme)}
    </Text>
  );

const renderHeading = (
  node: HeadingNode,
  theme: Theme,
  placement: Placement
) => {
  const depth = clampDepth(node.depth);
  const { marginTop, ...style } = headingStyles[depth];

  return (
    <Heading
      as={`h${depth}`}
      className={darkClass.heading}
      key={keyOf(node)}
      style={{
        ...style,
        color: light.heading,
        fontWeight: 600,
        ...spacing(placement, Number(marginTop), headingGap[depth]),
      }}
    >
      {renderInline(node.children, theme)}
    </Heading>
  );
};

const renderListItem = (node: ListItem, theme: Theme, spread: boolean) => (
  <li key={keyOf(node)} style={{ margin: "0 0 6px", paddingLeft: 4 }}>
    {node.children.map((child, index) => {
      const placement = {
        first: index === 0,
        last: index === node.children.length - 1,
      };

      if (child.type === "paragraph" && !spread) {
        return (
          <span key={keyOf(child)}>{renderInline(child.children, theme)}</span>
        );
      }

      // eslint-disable-next-line no-use-before-define -- lists nest blocks
      return renderBlock(child, theme, { ...placement, first: true });
    })}
  </li>
);

const renderList = (node: List, theme: Theme, placement: Placement) => {
  const Tag = node.ordered ? "ol" : "ul";

  const spread =
    node.spread === true || node.children.some((item) => item.spread);

  return (
    <Tag
      className={darkClass.text}
      key={keyOf(node)}
      start={
        node.ordered && node.start !== 1 ? (node.start ?? undefined) : undefined
      }
      style={{ ...textStyle, ...spacing(placement, 0), paddingLeft: 24 }}
    >
      {node.children.map((item) => renderListItem(item, theme, spread))}
    </Tag>
  );
};

// Outlook for Windows only pads table cells, so quotes and code blocks put
// their bar, background and padding on one (as callouts do), and keep the
// <blockquote> or <pre> inside for its meaning.

const renderBlockquote = (
  node: Blockquote,
  theme: Theme,
  placement: Placement
) => (
  <Section key={keyOf(node)} style={spacing(placement, 0)}>
    <Row>
      <Column
        className={darkClass.border}
        style={{ borderLeft: `3px solid ${light.border}`, paddingLeft: 16 }}
      >
        <blockquote style={{ margin: 0 }}>
          {/* eslint-disable-next-line no-use-before-define -- blockquotes nest blocks */}
          {renderBlocks(node.children, theme)}
        </blockquote>
      </Column>
    </Row>
  </Section>
);

const renderCode = (node: Code, placement: Placement) => (
  <Section key={keyOf(node)} style={spacing(placement, 0)}>
    <Row>
      <Column
        className={darkClass.subtle}
        style={{
          backgroundColor: light.subtle,
          borderRadius: RADIUS,
          padding: "14px 16px",
        }}
      >
        <pre
          className={darkClass.text}
          style={{
            color: light.text,
            fontFamily: fonts.mono,
            fontSize: 13,
            lineHeight: "20px",
            margin: 0,
            overflowWrap: "anywhere",
            whiteSpace: "pre-wrap",
          }}
        >
          <code>{node.value}</code>
        </pre>
      </Column>
    </Row>
  </Section>
);

export const buttonStyle = (theme: Theme): CSSProperties => ({
  backgroundColor: theme.accent,
  borderRadius: RADIUS,
  color: theme.onAccent,
  display: "inline-block",
  fontSize: 15,
  fontWeight: 600,
  lineHeight: "20px",
  padding: "12px 20px",
  textDecoration: "none",
});

const renderButton = (
  node: LeafDirective,
  theme: Theme,
  placement: Placement
) => (
  <Section key={keyOf(node)} style={spacing(placement, 8, 28)}>
    <Button href={node.attributes?.href ?? ""} style={buttonStyle(theme)}>
      {toText(node)}
    </Button>
  </Section>
);

const renderCallout = (
  node: ContainerDirective,
  theme: Theme,
  placement: Placement
) => {
  const [first, ...rest] = node.children;

  const hasTitle =
    first?.type === "paragraph" && first.data?.directiveLabel === true;

  const body = hasTitle ? rest : node.children;

  return (
    <Section key={keyOf(node)} style={spacing(placement, 4, 24)}>
      <Row>
        <Column
          className={darkClass.callout}
          style={{
            backgroundColor: theme.callout,
            borderRadius: RADIUS,
            padding: "16px 20px",
          }}
        >
          {hasTitle ? (
            <Text
              className={darkClass.heading}
              style={{
                ...textStyle,
                color: light.heading,
                fontWeight: 600,
                margin: body.length > 0 ? "0 0 4px" : 0,
              }}
            >
              {renderInline(first.children, theme)}
            </Text>
          ) : null}
          {/* eslint-disable-next-line no-use-before-define -- callouts nest blocks */}
          {renderBlocks(body, theme)}
        </Column>
      </Row>
    </Section>
  );
};

const renderBlock = (
  node: RootContent,
  theme: Theme,
  placement: Placement
): ReactNode => {
  switch (node.type) {
    case "paragraph": {
      return renderParagraph(node, theme, placement);
    }

    case "heading": {
      return renderHeading(node, theme, placement);
    }

    case "list": {
      return renderList(node, theme, placement);
    }

    case "blockquote": {
      return renderBlockquote(node, theme, placement);
    }

    case "code": {
      return renderCode(node, placement);
    }

    case "thematicBreak": {
      return (
        <Hr
          className={darkClass.border}
          key={keyOf(node)}
          style={{
            border: "none",
            borderTop: `1px solid ${light.border}`,
            ...spacing(placement, 36, 36),
          }}
        />
      );
    }

    case "leafDirective": {
      return renderButton(node, theme, placement);
    }

    case "containerDirective": {
      return renderCallout(node, theme, placement);
    }

    default: {
      return null;
    }
  }
};

export const renderBlocks = (nodes: RootContent[], theme: Theme): ReactNode[] =>
  nodes.map((node, index) =>
    renderBlock(node, theme, {
      first: index === 0,
      last: index === nodes.length - 1,
    })
  );
