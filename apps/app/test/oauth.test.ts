import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { BASE_URL } from "./helpers";

const RESOURCE = `${BASE_URL}/mcp`;
const REDIRECT_URI = "https://client.example.com/callback";
const HANDLE = /name="handle" value="(?<handle>[^"]+)"/u;
const BASE64_PLUS = /\+/gu;
const BASE64_SLASH = /\//gu;
const BASE64_PADDING = /[=]+$/u;

const workerFetch = (input: string | URL | Request, init?: RequestInit) =>
  exports.default.fetch(new Request(input, { redirect: "manual", ...init }));

/** A tiny cookie jar: enough to carry the session and consent cookies between steps. */
const createJar = () => {
  const cookies = new Map<string, string>();

  return {
    header: () =>
      [...cookies.entries()]
        .map(([name, value]) => `${name}=${value}`)
        .join("; "),
    store: (response: Response) => {
      for (const cookie of response.headers.getSetCookie()) {
        const [pair = ""] = cookie.split(";");
        const separator = pair.indexOf("=");

        cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
      }
    },
  };
};

const base64Url = (bytes: Uint8Array) =>
  btoa(String.fromCodePoint(...bytes))
    .replaceAll(BASE64_PLUS, "-")
    .replaceAll(BASE64_SLASH, "_")
    .replace(BASE64_PADDING, "");

const pkce = async () => {
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));

  const challenge = base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    )
  );

  return { challenge, verifier };
};

const registerClient = async () => {
  const response = await workerFetch(`${BASE_URL}/oauth/register`, {
    body: JSON.stringify({
      client_name: "Test client",
      grant_types: ["authorization_code", "refresh_token"],
      redirect_uris: [REDIRECT_URI],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const { client_id: clientId } = await response.json<{ client_id: string }>();

  return clientId;
};

const authorizeUrl = (clientId: string, challenge: string) => {
  const url = new URL("/authorize", BASE_URL);

  url.search = new URLSearchParams({
    client_id: clientId,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    response_type: "code",
    scope: "newsletter offline_access",
    state: "state-123",
  }).toString();

  return url;
};

/** Sign in with the admin token, then load the consent page and return its handle. */
const reachConsent = async (jar: ReturnType<typeof createJar>, url: URL) => {
  const signIn = await workerFetch(`${BASE_URL}/authorize/sign-in`, {
    body: new URLSearchParams({
      return_to: `${url.pathname}${url.search}`,
      token: env.MCP_TOKEN,
    }),
    method: "POST",
  });

  jar.store(signIn);

  const consent = await workerFetch(url, { headers: { cookie: jar.header() } });

  jar.store(consent);

  return {
    consent,
    handle: HANDLE.exec(await consent.text())?.groups?.handle ?? "",
  };
};

describe("discovery", () => {
  it("publishes protected resource and authorization server metadata", async () => {
    const resource = await workerFetch(
      `${BASE_URL}/.well-known/oauth-protected-resource/mcp`
    );

    const server = await workerFetch(
      `${BASE_URL}/.well-known/oauth-authorization-server`
    );

    const resourceMetadata = await resource.json<{
      authorization_servers: string[];
      resource: string;
    }>();

    const serverMetadata = await server.json<{
      authorization_endpoint: string;
      client_id_metadata_document_supported: boolean;
      code_challenge_methods_supported: string[];
      issuer: string;
      token_endpoint: string;
    }>();

    expect(resourceMetadata).toMatchObject({
      authorization_servers: [BASE_URL],
      resource: RESOURCE,
    });
    expect(serverMetadata).toMatchObject({
      authorization_endpoint: `${BASE_URL}/authorize`,
      client_id_metadata_document_supported: true,
      code_challenge_methods_supported: ["S256"],
      issuer: BASE_URL,
      token_endpoint: `${BASE_URL}/oauth/token`,
    });
  });

  it("points unauthenticated MCP requests at the resource metadata", async () => {
    const response = await workerFetch(RESOURCE, {
      body: "{}",
      method: "POST",
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`
    );
  });
});

describe("authorize", () => {
  it("asks for the admin token before showing consent, and rejects a wrong one", async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);

    const anonymous = await workerFetch(url);
    expect(await anonymous.text()).toContain("Enter your admin token");

    const wrong = await workerFetch(`${BASE_URL}/authorize/sign-in`, {
      body: new URLSearchParams({
        return_to: `${url.pathname}${url.search}`,
        token: "nope",
      }),
      method: "POST",
    });

    expect(wrong.status).toBe(401);
    expect(wrong.headers.getSetCookie()).toHaveLength(0);
  });

  it("never redirects sign-in anywhere but the authorize page", async () => {
    const response = await workerFetch(`${BASE_URL}/authorize/sign-in`, {
      body: new URLSearchParams({
        return_to: "https://evil.example.com/",
        token: env.MCP_TOKEN,
      }),
      method: "POST",
    });

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/authorize");
  });

  it("issues a resource-bound token that works with the MCP server", async () => {
    const jar = createJar();
    const clientId = await registerClient();
    const { challenge, verifier } = await pkce();

    const { consent, handle } = await reachConsent(
      jar,
      authorizeUrl(clientId, challenge)
    );

    expect(consent.status).toBe(200);
    expect(handle).not.toBe("");

    const approved = await workerFetch(`${BASE_URL}/authorize`, {
      body: new URLSearchParams({ decision: "approve", handle }),
      headers: { cookie: jar.header() },
      method: "POST",
    });

    expect(approved.status).toBe(302);

    const callback = new URL(approved.headers.get("location") ?? "");

    expect(`${callback.origin}${callback.pathname}`).toBe(REDIRECT_URI);
    expect(callback.searchParams.get("state")).toBe("state-123");
    expect(callback.searchParams.get("iss")).toBe(BASE_URL);

    const token = await workerFetch(`${BASE_URL}/oauth/token`, {
      body: new URLSearchParams({
        client_id: clientId,
        code: callback.searchParams.get("code") ?? "",
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        resource: RESOURCE,
      }),
      method: "POST",
    });

    const tokens = await token.json<{
      access_token: string;
      refresh_token?: string;
    }>();

    expect(token.status).toBe(200);
    expect(tokens.refresh_token).toBeTruthy();

    const client = new Client({ name: "oauth-test", version: "1.0.0" });

    await client.connect(
      new StreamableHTTPClientTransport(new URL(RESOURCE), {
        fetch: workerFetch,
        requestInit: {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        },
      })
    );

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toContain("create_draft");
    await client.close();
  });

  it("sends access_denied back to the client when the owner denies", async () => {
    const jar = createJar();
    const clientId = await registerClient();
    const { challenge } = await pkce();

    const { handle } = await reachConsent(
      jar,
      authorizeUrl(clientId, challenge)
    );

    const denied = await workerFetch(`${BASE_URL}/authorize`, {
      body: new URLSearchParams({ decision: "deny", handle }),
      headers: { cookie: jar.header() },
      method: "POST",
    });

    const callback = new URL(denied.headers.get("location") ?? "");

    expect(denied.status).toBe(302);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe("state-123");
  });
});
