import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { createDb } from "../src/db/client";
import { getSettings, saveSettings } from "../src/settings";

const settingsInput = {
  accent: "#FF0066",
  address: "1 Test Lane, Sydney",
  from: { email: "hello@example.com", name: "Tester" },
  name: "Test Newsletter",
};

describe("settings", () => {
  it("returns null before setup, then round-trips validated settings", async () => {
    const db = createDb(env.DB);

    expect(await getSettings(db)).toBeNull();

    await saveSettings(db, settingsInput);
    await saveSettings(db, { ...settingsInput, name: "Renamed" });

    expect(await getSettings(db)).toStrictEqual({
      ...settingsInput,
      accent: "#ff0066",
      links: [],
      name: "Renamed",
    });
  });

  it("rejects invalid settings", async () => {
    await expect(
      saveSettings(createDb(env.DB), { ...settingsInput, accent: "red" })
    ).rejects.toThrow("6-digit hex");
  });
});

describe("worker", () => {
  it("serves the health check", async () => {
    const response = await exports.default.fetch("https://sendoff.test/health");

    expect(await response.json()).toStrictEqual({ ok: true });
  });

  it("renders the sample preview as HTML and text", async () => {
    const html = await exports.default.fetch(
      "https://sendoff.test/preview/sample"
    );

    const text = await exports.default.fetch(
      "https://sendoff.test/preview/sample?format=text"
    );

    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("What I shipped this quarter");
    expect(await text.text()).toContain("Unsubscribe: #unsubscribe");
  });
});
