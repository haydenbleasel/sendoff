import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { env, exports } from "cloudflare:workers";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { JsonValue } from "../src/json";
import { BASE_URL, mockNetwork, statusOf } from "./helpers";

let client: Client;
let network: ReturnType<typeof mockNetwork>;

const workerFetch = (input: string | URL | Request, init?: RequestInit) =>
  exports.default.fetch(new Request(input, init));

beforeAll(async () => {
  client = new Client({ name: "sendoff-tests", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      fetch: workerFetch,
      requestInit: { headers: { Authorization: `Bearer ${env.MCP_TOKEN}` } },
    })
  );
});

afterAll(async () => {
  await client.close();
});

beforeEach(() => {
  network = mockNetwork();
});

afterEach(() => network.restore());

const call = async (name: string, args: Record<string, JsonValue> = {}) => {
  const response = await client.callTool({ arguments: args, name });
  const content = Array.isArray(response.content) ? response.content : [];

  const text = content
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

  return { isError: response.isError === true, text };
};

/** The JSON block tool results end with. */
const dataOf = (text: string) =>
  JSON.parse(text.slice(text.indexOf("\n\n{") + 2));

describe("auth", () => {
  it("rejects requests without the bearer token", async () => {
    const response = await workerFetch(`${BASE_URL}/mcp`, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method: "tools/list" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });
});

describe("tools", () => {
  it("lists every tool with descriptions", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).toSorted();

    expect(names).toStrictEqual([
      "add_subscriber",
      "cancel_send",
      "check_promotion",
      "confirm_send",
      "create_api_key",
      "create_draft",
      "delete_draft",
      "doctor",
      "edit_draft",
      "get_draft",
      "get_settings",
      "import_csv",
      "import_issue",
      "import_subscribers",
      "issue_stats",
      "list_api_keys",
      "list_issues",
      "prepare_send",
      "preview_draft",
      "resume_send",
      "revoke_api_key",
      "search_subscribers",
      "send_status",
      "send_test",
      "set_draft_meta",
      "unsubscribe_subscriber",
      "update_settings",
    ]);
    expect(tools.every((tool) => (tool.description ?? "").length > 20)).toBe(
      true
    );
    expect(
      tools.find((tool) => tool.name === "delete_draft")?.annotations
        ?.destructiveHint
    ).toBe(true);
  });

  it("sets up the newsletter, warning that the sender isn't in SES yet", async () => {
    const empty = await call("get_settings");

    expect(empty.text).toContain("isn't set up yet");

    const incomplete = await call("update_settings", { name: "Only a name" });
    expect(incomplete.isError).toBe(true);

    const saved = await call("update_settings", {
      address: "1 Test Lane, Sydney",
      from: { email: "hello@example.com", name: "Tester" },
      name: "Test Newsletter",
    });

    expect(saved.isError).toBe(false);
    expect(saved.text).toContain("example.com isn't set up in SES");

    const renamed = await call("update_settings", {
      accent: "#FF0066",
      replyTo: null,
    });

    expect(dataOf(renamed.text)).toMatchObject({
      accent: "#ff0066",
      name: "Test Newsletter",
    });

    // Some clients can't send null, so an empty string clears it too.
    const cleared = await call("update_settings", { address: "" });

    expect(cleared.isError).toBe(false);
    expect(dataOf(cleared.text)).not.toHaveProperty("address");

    await call("update_settings", { address: "1 Test Lane, Sydney" });
  });

  it("drafts, edits and previews an issue", async () => {
    const created = await call("create_draft", {
      body: "# Hello\n\nFirst draft of the issue.",
      preheader: "A short preview",
      subject: "Issue one",
    });

    const draft = dataOf(created.text);

    expect(created.text).toContain(
      "Preview: https://news.example.com/preview/"
    );
    expect(draft).toMatchObject({
      slug: "issue-one",
      status: "draft",
      version: 1,
    });

    const edited = await call("edit_draft", {
      edits: [{ newText: "Second", oldText: "First" }],
      expectedVersion: 1,
      issue: "issue-one",
    });

    expect(dataOf(edited.text).version).toBe(2);

    const fetched = await call("get_draft", { issue: draft.id });
    expect(dataOf(fetched.text).body).toBe(
      "# Hello\n\nSecond draft of the issue."
    );

    const preview = await call("preview_draft", { issue: "issue-one" });
    expect(preview.text).toContain("Plain-text version:");
    expect(preview.text).toContain("Second draft of the issue.");

    const listed = await call("list_issues", { status: "draft" });
    expect(listed.text).toContain("issue-one");
  });

  it("reports Markdown problems and failed edits as tool errors the agent can fix", async () => {
    const created = await call("create_draft", {
      body: "<div>raw html</div>",
      subject: "Broken",
    });

    expect(created.isError).toBe(false);
    expect(created.text).toContain("Line 1: Raw HTML isn't supported");

    const missing = await call("edit_draft", {
      edits: [{ newText: "x", oldText: "not in the draft" }],
      issue: "broken",
    });

    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("isn't in the draft");

    const unknown = await call("get_draft", { issue: "nope" });
    expect(unknown).toMatchObject({ isError: true });

    const deleted = await call("delete_draft", { issue: "broken" });

    expect(deleted.text).toContain("Deleted");
  });

  it("imports, searches, adds and unsubscribes subscribers", async () => {
    const dryRun = await call("import_subscribers", {
      dryRun: true,
      subscribers: [{ email: "csv-a@example.com" }],
    });

    expect(dryRun.text).toContain("Nothing was written");
    expect(await statusOf("csv-a@example.com")).toBeUndefined();

    await call("import_subscribers", {
      subscribers: [
        { email: "csv-a@example.com" },
        { email: "csv-b@example.com", status: "unsubscribed" },
      ],
    });

    const csv =
      "email,unsubscribed\nfile-c@example.com,false\nfile-d@example.com,true\n";

    const preview = await call("import_csv", { csv, dryRun: true });

    expect(preview.text).toContain('Read 2 rows (emails from "email"');
    expect(preview.text).toContain("Would import: 2 new");
    expect(await statusOf("file-c@example.com")).toBeUndefined();

    await call("import_csv", { csv });
    expect(await statusOf("file-d@example.com")).toBe("unsubscribed");

    const noEmail = await call("import_csv", { csv: "name\nAda" });
    expect(noEmail).toMatchObject({ isError: true });
    expect(noEmail.text).toContain("Couldn't find an email column");

    const confirmed = await call("add_subscriber", {
      email: "new@example.com",
    });

    expect(confirmed.text).toContain("Sent a confirmation email");
    expect(network.sent.map((email) => email.to)).toContain("new@example.com");

    const direct = await call("add_subscriber", {
      email: "asked@example.com",
      skipConfirmation: true,
    });

    expect(direct.text).toContain("active subscriber");

    const refused = await call("add_subscriber", {
      email: "csv-b@example.com",
      skipConfirmation: true,
    });

    expect(refused.text).toContain("won't be re-added");

    await call("unsubscribe_subscriber", { email: "CSV-A@example.com" });
    expect(await statusOf("csv-a@example.com")).toBe("unsubscribed");

    const search = await call("search_subscribers", { query: "csv-" });
    expect(dataOf(search.text).subscribers).toHaveLength(2);
    expect(dataOf(search.text).counts).toMatchObject({ active: 2, pending: 1 });
  });

  it("creates API keys that work with the REST API until revoked", async () => {
    const created = await call("create_api_key", {
      name: "haydenbleasel.com signup form",
    });

    const key = /sendoff_[\w-]{43}/u.exec(created.text)?.[0] ?? "";
    const { prefix } = dataOf(created.text);

    const post = () =>
      workerFetch(`${BASE_URL}/api/v1/subscribers`, {
        body: JSON.stringify({ email: "from-site@example.com" }),
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        method: "POST",
      });

    const accepted = await post();
    expect(accepted.status).toBe(202);

    const listed = await call("list_api_keys");
    expect(listed.text).toContain("haydenbleasel.com signup form");
    expect(listed.text).not.toContain(key);

    await call("revoke_api_key", { key: prefix });
    const rejected = await post();

    expect(rejected.status).toBe(401);
  });
});

describe("import_issue", () => {
  it("keeps a past issue as sent, readable but not editable", async () => {
    const imported = await call("import_issue", {
      html: '<p>Hi {{{contact.first_name|there}}}, <a href="https://example.com">read this</a>.</p>',
      sentAt: "2025-02-03T04:05:06Z",
      subject: "An old issue from elsewhere",
    });

    expect(imported.isError).toBe(false);
    expect(imported.text).toContain(
      'Imported "An old issue from elsewhere" (sent 2025-02-03, slug an-old-issue-from-elsewhere).'
    );
    expect(imported.text).toContain("{{{contact.first_name|there}}}");

    const read = await call("get_draft", {
      issue: "an-old-issue-from-elsewhere",
    });

    expect(read.text).toContain("was imported: sent 2025-02-03");
    expect(read.text).toContain(
      "Hi {{{contact.first_name|there}}}, read this (https://example.com)."
    );

    const edit = await call("edit_draft", {
      body: "New body",
      issue: "an-old-issue-from-elsewhere",
    });

    expect(edit.isError).toBe(true);

    const badDate = await call("import_issue", {
      html: "<p>Hi</p>",
      sentAt: "last week",
      subject: "Undated",
    });

    expect(badDate.isError).toBe(true);
    expect(badDate.text).toContain("isn't a past send date");

    const deleted = await call("delete_draft", {
      issue: "an-old-issue-from-elsewhere",
    });

    expect(deleted.text).toBe(
      'Deleted the imported issue "An old issue from elsewhere".'
    );
  });
});
