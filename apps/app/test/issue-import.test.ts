import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createApiKey } from "../src/api-keys";
import { issueImportResponse } from "../src/api/schemas";
import { getConfig } from "../src/config";
import { events, issues, sends } from "../src/db/schema";
import {
  findMergeTags,
  htmlToText,
  importIssue,
  importedIssueSchema,
  parseSentAt,
} from "../src/importers/issues";
import { createDraft, deleteDraft } from "../src/issues";
import { sendStatus } from "../src/sending";
import { issueReport } from "../src/stats";
import { createToken } from "../src/tokens";
import { BASE_URL, db } from "./helpers";

const SENT_AT = "2025-03-01T09:00:00.000Z";

const ORIGINAL = `<!DOCTYPE html><html><head><title>Spring</title><style>p { color: red; }</style></head><body><h1>Spring update</h1><p>Hi {{{contact.first_name|there}}}, it&#39;s been a while &amp; here&rsquo;s news.</p><p><a href="https://example.com/post">Read the post</a><br>or <a href="https://example.com/raw">https://example.com/raw</a></p><ul><li>One</li><li>Two</li></ul><p><a href="{{{RESEND_UNSUBSCRIBE_URL}}}">Unsubscribe</a></p></body></html>`;

const input = (overrides: Record<string, string> = {}) =>
  importedIssueSchema.parse({
    html: ORIGINAL,
    preheader: "What happened this spring",
    sentAt: SENT_AT,
    subject: "Spring update",
    ...overrides,
  });

beforeEach(async () => {
  const database = db();

  await database.delete(events);
  await database.delete(sends);
  await database.delete(issues);
});

describe("parseSentAt", () => {
  it("reads ISO 8601 and the close variants providers export", () => {
    expect(parseSentAt(SENT_AT)?.toISOString()).toBe(SENT_AT);
    expect(parseSentAt("2025-03-01T19:00:00+10:00")?.toISOString()).toBe(
      SENT_AT
    );
    expect(parseSentAt("2025-03-01 09:00:00.000+00")?.toISOString()).toBe(
      SENT_AT
    );
    expect(parseSentAt("2025-03-01 14:30:00+0530")?.toISOString()).toBe(
      SENT_AT
    );
    expect(parseSentAt("2025-03-01T09:00")?.toISOString()).toBe(SENT_AT);
    expect(parseSentAt("March 1, 2025")).toBeNull();
    expect(parseSentAt("2025-13-45T09:00:00Z")).toBeNull();
  });

  it("only accepts send dates in the past", () => {
    expect(
      importedIssueSchema.safeParse({
        html: "<p>Hi</p>",
        sentAt: "2999-01-01T00:00:00Z",
        subject: "Future",
      }).success
    ).toBe(false);
  });
});

describe("htmlToText", () => {
  it("keeps the words, links and lists, and drops styles", () => {
    expect(htmlToText(ORIGINAL)).toBe(
      [
        "Spring update",
        "",
        "Hi {{{contact.first_name|there}}}, it's been a while & here’s news.",
        "",
        "Read the post (https://example.com/post)",
        "or https://example.com/raw",
        "",
        "- One",
        "",
        "- Two",
        "",
        "Unsubscribe",
      ].join("\n")
    );
  });
});

describe("findMergeTags", () => {
  it("finds the old provider's placeholders, once each", () => {
    expect(
      findMergeTags(
        ORIGINAL,
        "Hello *|FNAME|*, and {{ subscriber.first_name }} and {{{contact.first_name|there}}}"
      )
    ).toStrictEqual([
      "{{{contact.first_name|there}}}",
      "{{{RESEND_UNSUBSCRIBE_URL}}}",
      "*|FNAME|*",
      "{{ subscriber.first_name }}",
    ]);
    expect(findMergeTags("<p>No tags, just {braces}.</p>")).toStrictEqual([]);
  });
});

describe("importIssue", () => {
  it("keeps the issue exactly as sent, as a sent issue marked imported", async () => {
    const { issue, mergeTags, outcome } = await importIssue(db(), input());

    expect(outcome).toBe("created");
    expect(issue).toMatchObject({
      body: "",
      preheader: "What happened this spring",
      renderedHtml: ORIGINAL,
      slug: "spring-update",
      status: "sent",
      subject: "Spring update",
      version: 1,
    });
    expect(issue.importedAt).toBeInstanceOf(Date);
    expect(issue.sentAt?.toISOString()).toBe(SENT_AT);
    expect(issue.updatedAt.toISOString()).toBe(SENT_AT);
    expect(issue.sendStartedAt).toBeNull();
    expect(issue.renderedText).toContain(
      "Read the post (https://example.com/post)"
    );
    expect(mergeTags).toStrictEqual([
      "{{{contact.first_name|there}}}",
      "{{{RESEND_UNSUBSCRIBE_URL}}}",
    ]);
  });

  it("replaces an earlier import of the same subject and date, and keeps others apart", async () => {
    const first = await importIssue(db(), input());

    const again = await importIssue(
      db(),
      input({ html: "<p>Hi there</p>", text: "Hi there" })
    );

    expect(again.outcome).toBe("updated");
    expect(again.issue).toMatchObject({
      id: first.issue.id,
      renderedHtml: "<p>Hi there</p>",
      renderedText: "Hi there",
      slug: "spring-update",
      version: 2,
    });
    expect(again.mergeTags).toStrictEqual([]);

    const later = await importIssue(
      db(),
      input({ sentAt: "2026-03-01T09:00:00Z" })
    );

    expect(later.outcome).toBe("created");
    expect(later.issue.slug).toBe("spring-update-2");

    await expect(
      importIssue(
        db(),
        input({ sentAt: "2024-01-01T00:00:00Z", slug: "spring-update" })
      )
    ).rejects.toThrow("taken");
    await expect(
      importIssue(db(), input({ slug: "Not A Slug" }))
    ).rejects.toThrow("isn't a valid slug");
  });

  it("is never sent, counted or reported on, and can be deleted", async () => {
    const { issue } = await importIssue(db(), input());

    const deps = {
      config: getConfig(env),
      db: db(),
      queue: { send: () => Promise.resolve(undefined) },
    };

    await expect(issueReport(db())).rejects.toThrow("Nothing has been sent");
    await expect(issueReport(db(), { ref: issue.id })).rejects.toThrow(
      "imported from another provider"
    );
    await expect(sendStatus(deps, issue.id)).rejects.toThrow(
      "imported from another provider"
    );

    const draft = await createDraft(db(), { body: "Hi", subject: "Draft" });
    await expect(deleteDraft(db(), issue.id)).resolves.toMatchObject({
      id: issue.id,
    });
    await expect(deleteDraft(db(), draft.id)).resolves.toMatchObject({
      id: draft.id,
    });
  });

  it("shows the stored HTML in the preview, with links opening in a new tab", async () => {
    const { issue } = await importIssue(db(), input());
    const token = await createToken(env.TOKEN_SECRET, "preview", issue.id);

    const response = await exports.default.fetch(
      `${BASE_URL}/preview/${token}/render`
    );

    const data = await response.json<{
      html: string;
      ok: boolean;
      status: string;
      text: string;
    }>();

    expect(data).toMatchObject({ ok: true, status: "imported" });
    expect(data.html).toBe(
      ORIGINAL.replace("<head>", '<head><base target="_blank">')
    );
    expect(data.text).toBe(issue.renderedText);
  });
});

/** POST a raw body to the import endpoint with a new key holding `scopes`. */
const post = async (
  body: string,
  scopes: ("issues:import" | "subscribers:write")[]
) => {
  const { key } = await createApiKey(db(), { name: "Import", scopes });

  return await exports.default.fetch(
    new Request(`${BASE_URL}/api/v1/issues/import`, {
      body,
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
};

const issuesBody = (...items: Record<string, string>[]) =>
  JSON.stringify({ issues: items });

describe("POST /api/v1/issues/import", () => {
  it("needs the issues:import scope", async () => {
    const response = await post(
      issuesBody({ html: "<p>Hi</p>", sentAt: SENT_AT, subject: "Hi" }),
      ["subscribers:write"]
    );

    expect(response.status).toBe(403);
  });

  it("imports each issue in order, reporting the ones it couldn't", async () => {
    await createDraft(db(), { body: "Hi", subject: "Taken" });

    const response = await post(
      issuesBody(
        {
          html: ORIGINAL,
          sentAt: "2025-03-01 09:00:00.000+00",
          subject: "Spring update",
        },
        {
          html: "<p>Summer</p>",
          sentAt: "2025-06-01T09:00:00Z",
          slug: "taken",
          subject: "Summer",
        },
        {
          html: "<p>Autumn</p>",
          sentAt: "2025-09-01T09:00:00Z",
          subject: "Autumn",
        }
      ),
      ["issues:import"]
    );

    expect(response.status).toBe(200);

    const { issues: results } = issueImportResponse.parse(
      await response.json()
    );

    expect(results.map((entry) => entry.outcome)).toStrictEqual([
      "created",
      "failed",
      "created",
    ]);
    expect(results[0]).toMatchObject({
      mergeTags: [
        "{{{contact.first_name|there}}}",
        "{{{RESEND_UNSUBSCRIBE_URL}}}",
      ],
      sentAt: SENT_AT,
      slug: "spring-update",
    });
    expect(results[1]?.error).toContain("taken");
  });

  it("rejects a body it can't read", async () => {
    const responses = await Promise.all([
      post("not json", ["issues:import"]),
      post(issuesBody(), ["issues:import"]),
      post(
        issuesBody({ html: "<p>Hi</p>", sentAt: "last March", subject: "Hi" }),
        ["issues:import"]
      ),
    ]);

    expect(responses.map((response) => response.status)).toStrictEqual([
      400, 400, 400,
    ]);
  });
});
