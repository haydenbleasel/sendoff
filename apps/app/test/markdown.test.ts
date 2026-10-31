import { describe, expect, it } from "vitest";

import { parseMarkdown, toText } from "../src/email/markdown";

const problemsFor = (source: string) => {
  const result = parseMarkdown(source);

  return result.ok ? [] : result.problems;
};

describe("parseMarkdown", () => {
  it("accepts every supported block", () => {
    const result = parseMarkdown(
      [
        "# Title",
        "Some *emphasis*, **strong**, `code` and a [link](https://example.com).",
        "![Alt](https://example.com/a.png)",
        "- one\n- two",
        "> quoted",
        "```\ncode\n```",
        "---",
        '::button[Go]{href="https://example.com"}',
        ":::callout[Heads up]\nBody\n:::",
      ].join("\n\n")
    );

    expect(result.ok).toBe(true);
  });

  it("rejects raw HTML with a line number", () => {
    expect(problemsFor("Hello\n\n<div>hi</div>")).toStrictEqual([
      expect.objectContaining({
        line: 3,
        message: expect.stringContaining("Raw HTML"),
      }),
    ]);
  });

  it("rejects deep headings, unsafe links and images without alt text", () => {
    const messages = problemsFor(
      "#### Deep\n\n[x](javascript:alert(1))\n\n![](https://example.com/a.png)\n\n![Alt](http://example.com/a.png)"
    ).map((problem) => problem.message);

    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain("####");
    expect(messages[1]).toContain("Links must start with");
    expect(messages[2]).toContain("alt text");
    expect(messages[3]).toContain("https://");
  });

  it("rejects unknown directives and buttons without a link", () => {
    const messages = problemsFor("::video[x]\n\n::button[Go]").map(
      (p) => p.message
    );

    expect(messages[0]).toContain('Unknown directive "::video"');
    expect(messages[1]).toContain("Buttons need an http(s) link");
  });

  it("keeps accidental text directives as literal text", () => {
    const result = parseMarkdown("Meet at 10:30, see note:here.");

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(toText(result.tree)).toBe("Meet at 10:30, see note:here.");
    }
  });

  it("rejects frontmatter and empty bodies", () => {
    expect(problemsFor("---\nsubject: Hi\n---\n\nBody")[0]?.message).toContain(
      "frontmatter"
    );
    expect(problemsFor("   \n")[0]?.message).toBe("The body is empty.");
  });

  it("rejects reference-style links", () => {
    expect(
      problemsFor("[a][b]\n\n[b]: https://example.com")[0]?.message
    ).toContain("Reference-style");
  });
});
