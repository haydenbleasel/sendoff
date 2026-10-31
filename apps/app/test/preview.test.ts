import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createDraft, editDraft } from "../src/issues";
import { saveSettings } from "../src/settings";
import { createToken } from "../src/tokens";
import { BASE_URL, db, testSettings } from "./helpers";

const get = (path: string) => exports.default.fetch(`${BASE_URL}${path}`);

const previewPath = async (issueId: string) =>
  `/preview/${await createToken(env.TOKEN_SECRET, "preview", issueId)}`;

describe("preview", () => {
  it("serves the page and rejects forged tokens", async () => {
    const draft = await createDraft(db(), {
      body: "Hello",
      subject: "Preview <me>",
    });

    const page = await get(await previewPath(draft.id));
    const html = await page.text();

    expect(page.status).toBe(200);
    expect(html).toContain("Preview · Preview &lt;me&gt;");
    expect(page.headers.get("cache-control")).toBe("no-store");

    const forged = await get("/preview/forged.token");

    expect(forged.status).toBe(404);

    const unsubscribeToken = await createToken(
      env.TOKEN_SECRET,
      "unsubscribe",
      draft.id
    );

    const wrongPurpose = await get(`/preview/${unsubscribeToken}`);

    expect(wrongPurpose.status).toBe(404);
  });

  it("changes state when the draft or settings change", async () => {
    const draft = await createDraft(db(), { body: "Hello", subject: "Live" });
    const path = await previewPath(draft.id);

    const version = async () => {
      const response = await get(`${path}/state`);
      const { version: value } = await response.json<{ version: string }>();

      return value;
    };

    const initial = await version();
    await editDraft(db(), draft.id, { body: "Hello again" });
    const afterEdit = await version();
    await saveSettings(db(), testSettings);
    const afterSettings = await version();

    expect(new Set([initial, afterEdit, afterSettings]).size).toBe(3);
  });

  it("renders HTML that opens links in a new tab, or the problems", async () => {
    const good = await createDraft(db(), {
      body: "[Link](https://example.com)",
      subject: "Good",
    });

    const bad = await createDraft(db(), {
      body: "#### Too deep",
      subject: "Bad",
    });

    const goodResponse = await get(`${await previewPath(good.id)}/render`);
    const badResponse = await get(`${await previewPath(bad.id)}/render`);

    const rendered = await goodResponse.json<{
      html: string;
      ok: boolean;
      text: string;
    }>();

    const broken = await badResponse.json<{
      ok: boolean;
      problems: { line: number }[];
    }>();

    expect(rendered.ok).toBe(true);
    expect(rendered.html).toContain('<head><base target="_blank">');
    expect(rendered.text).toContain("Link (https://example.com)");
    expect(broken).toMatchObject({ ok: false, problems: [{ line: 1 }] });
  });
});
