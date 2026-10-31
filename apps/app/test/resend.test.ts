import { describe, expect, it } from "vitest";

import { fetchResendContacts } from "../src/importers/resend";

const contact = (id: string, email: string, unsubscribed = false) => ({
  created_at: "2026-10-06 23:47:56.678+00",
  email,
  first_name: id === "1" ? "Ada" : null,
  id,
  last_name: id === "1" ? "Lovelace" : null,
  unsubscribed,
});

const unauthorized: typeof fetch = () =>
  Promise.resolve(
    new Response('{"message":"Invalid API key"}', { status: 401 })
  );

describe("fetchResendContacts", () => {
  it("follows the cursor, maps statuses and retries on 429", async () => {
    const urls: string[] = [];
    const sleeps: number[] = [];
    let rateLimited = false;

    const fetcher: typeof fetch = (input, init) => {
      const request = new Request(input, init);
      urls.push(request.url);
      expect(request.headers.get("authorization")).toBe("Bearer re_test");

      const after = new URL(request.url).searchParams.get("after");

      if (after === "2" && !rateLimited) {
        rateLimited = true;

        return Promise.resolve(
          new Response("slow down", {
            headers: { "retry-after": "2" },
            status: 429,
          })
        );
      }

      const page =
        after === null
          ? {
              data: [
                contact("1", "ada@example.com"),
                contact("2", "bob@example.com", true),
              ],
              has_more: true,
            }
          : { data: [contact("3", "cy@example.com")], has_more: false };

      return Promise.resolve(Response.json({ object: "list", ...page }));
    };

    const rows = await fetchResendContacts({
      apiKey: "re_test",
      fetcher,
      sleep: (ms) => {
        sleeps.push(ms);

        return Promise.resolve();
      },
    });

    expect(rows).toStrictEqual([
      { email: "ada@example.com", name: "Ada Lovelace", status: "active" },
      { email: "bob@example.com", name: undefined, status: "unsubscribed" },
      { email: "cy@example.com", name: undefined, status: "active" },
    ]);
    expect(urls[0]).toBe("https://api.resend.com/contacts?limit=100");
    expect(urls.at(-1)).toBe(
      "https://api.resend.com/contacts?limit=100&after=2"
    );
    expect(sleeps).toContain(2000);
  });

  it("reads a segment and surfaces API errors", async () => {
    await expect(
      fetchResendContacts({
        apiKey: "bad",
        fetcher: unauthorized,
        segmentId: "seg_1",
      })
    ).rejects.toThrow("Resend API returned 401");
  });
});
