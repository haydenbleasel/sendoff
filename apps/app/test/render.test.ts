import { describe, expect, it } from "vitest";

import { contrast, ensureContrast, readableOn } from "../src/email/color";
import {
  personalize,
  renderIssue,
  UNSUBSCRIBE_URL_PLACEHOLDER,
} from "../src/email/render";
import { sampleIssue, sampleSettings } from "../src/email/sample";
import { createTheme } from "../src/email/theme";

const render = async (body: string, settings = sampleSettings) => {
  const result = await renderIssue(
    { body, preheader: "Preheader text", subject: "Subject line" },
    settings
  );

  if (!result.ok) {
    throw new Error(JSON.stringify(result.problems));
  }

  return result;
};

describe("renderIssue", () => {
  it("renders the sample issue to HTML and text", async () => {
    const result = await renderIssue(sampleIssue, sampleSettings);

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.html.startsWith("<!DOCTYPE html")).toBe(true);
      expect(result.html).toContain(sampleSettings.address);
      expect(result.text).toContain(
        "What I shipped this quarter\n==========================="
      );
    }
  });

  it("includes the preheader, dark-mode styles and the unsubscribe placeholder", async () => {
    const { html, text } = await render("Hello");

    expect(html).toContain("Preheader text");
    expect(html).toContain("prefers-color-scheme: dark");
    expect(html).toContain(`href="${UNSUBSCRIBE_URL_PLACEHOLDER}"`);
    expect(text).toContain(`Unsubscribe: ${UNSUBSCRIBE_URL_PLACEHOLDER}`);
  });

  it("returns problems instead of rendering invalid Markdown", async () => {
    const result = await renderIssue(
      { body: "<b>no</b>", subject: "Subject" },
      sampleSettings
    );

    expect(result.ok).toBe(false);
  });

  it("escapes user content", async () => {
    const { html } = await render('Is 1 < 2 & "yes"?');

    expect(html).toContain("Is 1 &lt; 2 &amp; &quot;yes&quot;?");
  });

  it("writes links and buttons readably in plain text", async () => {
    const { text } = await render(
      'Read [the post](https://example.com/post) or https://example.com.\n\n::button[Open]{href="https://example.com/open"}\n\n- a\n- b'
    );

    expect(text).toContain(
      "Read the post (https://example.com/post) or https://example.com."
    );
    expect(text).toContain("Open: https://example.com/open");
    expect(text).toContain("- a\n- b");
  });

  it("uses the logo with explicit dimensions when configured", async () => {
    const { html } = await render("Hello", {
      ...sampleSettings,
      logo: { height: 32, url: "https://example.com/logo.png", width: 120 },
    });

    expect(html).toMatch(
      /<img[^>]+src="https:\/\/example\.com\/logo\.png"[^>]+>/u
    );
    expect(html).toContain('width="120"');
    expect(html).toContain('height="32"');
  });
});

describe("without a postal address", () => {
  it("leaves the address out of the footer", async () => {
    const { address, ...settings } = sampleSettings;
    const result = await renderIssue(sampleIssue, settings);

    if (!result.ok) {
      throw new Error("The sample should render");
    }

    expect(result.html).not.toContain(address ?? "");
    expect(result.text).not.toContain(address ?? "");
    expect(
      result.text.endsWith("Unsubscribe: %%sendoff_unsubscribe_url%%")
    ).toBe(true);
  });
});

describe("personalize", () => {
  it("swaps the placeholder and escapes the URL for HTML", () => {
    const result = personalize(
      {
        html: `<a href="${UNSUBSCRIBE_URL_PLACEHOLDER}">x</a>`,
        text: UNSUBSCRIBE_URL_PLACEHOLDER,
      },
      { unsubscribeUrl: "https://example.com/u?a=1&b=2" }
    );

    expect(result.html).toBe(
      '<a href="https://example.com/u?a=1&amp;b=2">x</a>'
    );
    expect(result.text).toBe("https://example.com/u?a=1&b=2");
  });
});

describe("theme", () => {
  it("picks a readable button label and AA link colors for any accent", () => {
    for (const accent of ["#2563eb", "#facc15", "#111111", "#ffffff"]) {
      const theme = createTheme({ accent });

      expect(contrast(theme.link, "#ffffff")).toBeGreaterThanOrEqual(4.5);
      expect(contrast(theme.linkDark, "#0b0b0d")).toBeGreaterThanOrEqual(4.5);
      expect(theme.onAccent).toBe(readableOn(accent, "#ffffff", "#09090b"));
    }
  });

  it("leaves colors that already pass alone", () => {
    expect(ensureContrast("#1d4ed8", "#ffffff", "#000000")).toBe("#1d4ed8");
  });
});
