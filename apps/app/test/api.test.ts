import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  API_KEY_PREFIX,
  createApiKey,
  findApiKey,
  listApiKeys,
  revokeApiKey,
} from "../src/api-keys";
import { apiKeys } from "../src/db/schema";
import { createId } from "../src/id";
import { saveSettings } from "../src/settings";
import { findSubscriberByEmail, importSubscribers } from "../src/subscribers";
import { BASE_URL, db, mockNetwork, sesError, testSettings } from "./helpers";

let network: ReturnType<typeof mockNetwork>;

beforeEach(() => {
  network = mockNetwork();
});

afterEach(() => network.restore());

const subscribe = (body: string, key?: string) => {
  const headers = new Headers({ "content-type": "application/json" });

  if (key) {
    headers.set("authorization", `Bearer ${key}`);
  }

  return exports.default.fetch(
    new Request(`${BASE_URL}/api/v1/subscribers`, {
      body,
      headers,
      method: "POST",
    })
  );
};

const errorCode = async (response: Response) => {
  const { error } = await response.json<{ error: { code: string } }>();

  return error.code;
};

const newKey = async () => {
  const { key } = await createApiKey(db(), {
    name: "Website",
    scopes: ["subscribers:write"],
  });

  return key;
};

describe("api keys", () => {
  it("stores only a hash and finds active keys", async () => {
    const { apiKey, key } = await createApiKey(db(), {
      name: "  Script ",
      scopes: ["subscribers:write", "subscribers:write"],
    });

    expect(key).toMatch(/^sendoff_[\w-]{43}$/u);
    expect(apiKey).toMatchObject({
      name: "Script",
      scopes: ["subscribers:write"],
    });
    expect(apiKey.prefix).toBe(key.slice(0, API_KEY_PREFIX.length + 6));
    expect(JSON.stringify(await listApiKeys(db()))).not.toContain(key);
    const found = await findApiKey(db(), key);

    expect(found?.id).toBe(apiKey.id);
    expect(await findApiKey(db(), `${key}x`)).toBeNull();

    await revokeApiKey(db(), apiKey.prefix);

    expect(await findApiKey(db(), key)).toBeNull();
    await expect(
      createApiKey(db(), { name: " ", scopes: ["subscribers:write"] })
    ).rejects.toThrow("Give the key a name");
  });
});

describe("before setup", () => {
  it("serves the OpenAPI document and explains the newsletter isn't set up", async () => {
    const document = await exports.default.fetch(
      `${BASE_URL}/api/v1/openapi.json`
    );

    const spec = await document.json<{
      components: {
        schemas: {
          CreateSubscriber: {
            properties: { email: { format: string } };
            required: string[];
          };
        };
      };
      paths: Record<string, { post: { "x-scopes": string[] } }>;
      servers: { url: string }[];
    }>();

    expect(spec.servers[0]?.url).toBe("https://news.example.com/api/v1");
    expect(spec.paths["/subscribers"]?.post["x-scopes"]).toStrictEqual([
      "subscribers:write",
    ]);
    expect(
      spec.components.schemas.CreateSubscriber.properties.email.format
    ).toBe("email");
    expect(spec.components.schemas.CreateSubscriber.required).toStrictEqual([
      "email",
    ]);

    const response = await subscribe(
      '{"email":"early@example.com"}',
      await newKey()
    );

    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("not_configured");
  });
});

describe("POST /api/v1/subscribers", () => {
  beforeEach(async () => {
    await saveSettings(db(), testSettings);
  });

  it("rejects missing, wrong and revoked keys, and keys without the scope", async () => {
    const { apiKey, key } = await createApiKey(db(), {
      name: "Old",
      scopes: ["subscribers:write"],
    });

    await revokeApiKey(db(), apiKey.id);

    const scopeless = `${API_KEY_PREFIX}scopeless-test-key`;
    await db()
      .insert(apiKeys)
      .values({
        hash: await crypto.subtle
          .digest("SHA-256", new TextEncoder().encode(scopeless))
          .then((digest) =>
            [...new Uint8Array(digest)]
              .map((byte) => byte.toString(16).padStart(2, "0"))
              .join("")
          ),
        id: createId(),
        name: "No scopes",
        prefix: "sendoff_scopel",
        scopes: [],
      });

    const body = '{"email":"a@example.com"}';
    const missing = await subscribe(body);
    const wrong = await subscribe(body, `${API_KEY_PREFIX}nope`);
    const revoked = await subscribe(body, key);
    const unscoped = await subscribe(body, scopeless);

    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(await errorCode(wrong)).toBe("invalid_api_key");
    expect(revoked.status).toBe(401);
    expect(unscoped.status).toBe(403);
    expect(await errorCode(unscoped)).toBe("insufficient_scope");
    expect(network.sent).toHaveLength(0);
  });

  it("validates the body", async () => {
    const key = await newKey();
    const notJson = await subscribe("email=a@example.com", key);
    const badEmail = await subscribe('{"email":"nope"}', key);

    expect(notJson.status).toBe(400);
    expect(await errorCode(notJson)).toBe("invalid_request");

    const { error } = await badEmail.json<{
      error: { code: string; message: string };
    }>();

    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain("email");
  });

  it("starts double opt-in and records the key's use", async () => {
    const { apiKey, key } = await createApiKey(db(), {
      name: "Site",
      scopes: ["subscribers:write"],
    });

    const response = await subscribe(
      '{"email":"Reader@Example.com","name":"Reader"}',
      key
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toStrictEqual({ status: "accepted" });
    expect(network.sent.map((email) => email.to)).toStrictEqual([
      "reader@example.com",
    ]);
    expect(network.sent[0]?.text).toContain(
      "https://news.example.com/confirm/"
    );

    const subscriber = await findSubscriberByEmail(db(), "reader@example.com");
    expect(subscriber).toMatchObject({
      name: "Reader",
      source: "api",
      status: "pending",
    });

    const used = await findApiKey(db(), key);
    expect(used?.id).toBe(apiKey.id);
    expect(used?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("responds the same for existing subscribers without emailing them", async () => {
    await importSubscribers(db(), [
      { email: "member@example.com", status: "active" },
    ]);

    const response = await subscribe(
      '{"email":"member@example.com"}',
      await newKey()
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toStrictEqual({ status: "accepted" });
    expect(network.sent).toHaveLength(0);
  });

  it("reports a failed confirmation email so the caller can retry", async () => {
    network.restore();
    network = mockNetwork({
      onSend: () => sesError("MessageRejected", 400, "Rejected"),
    });

    const response = await subscribe(
      '{"email":"retry@example.com"}',
      await newKey()
    );

    expect(response.status).toBe(502);
    expect(await errorCode(response)).toBe("confirmation_failed");
  });

  it("answers unknown endpoints with JSON", async () => {
    const response = await exports.default.fetch(`${BASE_URL}/api/v1/nope`);

    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("not_found");
  });
});
