import { describe, expect, it } from "vitest";

import {
  accountIdFromTopicArn,
  createAwsSetup,
  topicPolicy,
  xmlValues,
} from "../scripts/setup/aws";
import {
  clashes,
  createCloudflareApi,
  senderZoneOnCloudflare,
  zoneOnCloudflare,
} from "../scripts/setup/cloudflare";
import type { Confirm } from "../scripts/setup/cloudflare";
import { mailFromDomainFor, sesDnsRecords } from "../scripts/setup/dns";
import { deployConfig, instanceSchema } from "../scripts/setup/instance";
import {
  PAGES_WORKER,
  pagesCnameRecord,
  pagesConfig,
  pagesSubdomain,
} from "../scripts/setup/pages";
import {
  latestRelease,
  parseVersion,
  releaseNotes,
} from "../scripts/setup/releases";

const instance = instanceSchema.parse({
  accountId: "acct",
  databaseId: "db-123",
  hostname: "news.example.com",
  kvNamespaceId: "kv-123",
  publicUrl: "https://news.example.com",
  sesEventsTopicArn: "arn:aws:sns:us-east-1:123456789012:sendoff-events",
  sesRegion: "us-east-1",
  turnstileSiteKey: "site-key",
});

describe("sesDnsRecords", () => {
  it("lists DKIM, MAIL FROM and (when missing) DMARC records", () => {
    const records = sesDnsRecords({
      dkimTokens: ["aaa", "bbb", "ccc"],
      dmarc: true,
      domain: "example.com",
      mailFromDomain: mailFromDomainFor("example.com"),
      region: "eu-west-1",
    });

    expect(
      records.map((record) => [record.type, record.name, record.content])
    ).toStrictEqual([
      ["CNAME", "aaa._domainkey.example.com", "aaa.dkim.amazonses.com"],
      ["CNAME", "bbb._domainkey.example.com", "bbb.dkim.amazonses.com"],
      ["CNAME", "ccc._domainkey.example.com", "ccc.dkim.amazonses.com"],
      ["MX", "bounce.example.com", "feedback-smtp.eu-west-1.amazonses.com"],
      ["TXT", "bounce.example.com", "v=spf1 include:amazonses.com ~all"],
      ["TXT", "_dmarc.example.com", "v=DMARC1; p=none"],
    ]);
    expect(
      sesDnsRecords({
        dkimTokens: [],
        dmarc: false,
        domain: "example.com",
        mailFromDomain: "bounce.example.com",
        region: "us-east-1",
      })
    ).toHaveLength(2);
  });
});

describe("deployConfig", () => {
  it("fills in this instance's ids, paths, vars and custom domain", () => {
    const config = deployConfig(
      {
        $schema: "node_modules/wrangler/config-schema.json",
        compatibility_date: "2026-10-01",
        main: "src/index.ts",
        name: "sendoff",
        vars: {
          PUBLIC_URL: "",
          SES_REGION: "us-east-1",
          TURNSTILE_SITE_KEY: "",
        },
      },
      instance
    );

    expect(config).toMatchObject({
      account_id: "acct",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_id: "db-123",
          migrations_dir: "../migrations",
        },
      ],
      kv_namespaces: [{ binding: "OAUTH_KV", id: "kv-123" }],
      main: "../src/index.ts",
      routes: [{ custom_domain: true, pattern: "news.example.com" }],
      vars: {
        PUBLIC_URL: "https://news.example.com",
        SES_EVENTS_TOPIC_ARN: instance.sesEventsTopicArn,
        TURNSTILE_SITE_KEY: "site-key",
      },
      workers_dev: false,
    });
    expect(config).not.toHaveProperty("$schema");
  });

  it("leaves the Worker with no public route when a Pages project fronts it", () => {
    const config = deployConfig(
      { compatibility_date: "2026-10-01" },
      { ...instance, pagesProject: "sendoff-pages" }
    );

    expect(config).toMatchObject({
      routes: [],
      vars: { PUBLIC_URL: "https://news.example.com" },
      workers_dev: false,
    });
  });
});

describe("Pages front door", () => {
  it("binds the Pages project to the Worker and forwards every request", () => {
    expect(
      pagesConfig(
        { compatibility_date: "2026-10-01", main: "src/index.ts" },
        instance,
        "sendoff-pages"
      )
    ).toStrictEqual({
      compatibility_date: "2026-10-01",
      name: "sendoff-pages",
      pages_build_output_dir: "./dist",
      services: [{ binding: "SENDOFF", service: "sendoff" }],
    });
    expect(PAGES_WORKER).toContain("env.SENDOFF.fetch(request)");
  });

  it("finds the project's pages.dev hostname among its domains", () => {
    const rows = [
      { "Project Domains": "blog.pages.dev", "Project Name": "blog" },
      {
        "Project Domains": "sendoff-pages-4kd.pages.dev, news.example.com",
        "Project Name": "sendoff-pages",
      },
    ];

    expect(pagesSubdomain(rows, "sendoff-pages")).toBe(
      "sendoff-pages-4kd.pages.dev"
    );
    expect(pagesSubdomain(rows, "missing")).toBeUndefined();
    expect(
      pagesCnameRecord("news.example.com", "sendoff-pages-4kd.pages.dev")
    ).toMatchObject({
      content: "sendoff-pages-4kd.pages.dev",
      name: "news.example.com",
      type: "CNAME",
    });
  });
});

describe("AWS setup", () => {
  const recorded: {
    action?: string | null;
    body: string;
    method: string;
    url: string;
  }[] = [];

  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    const action = new URLSearchParams(body).get("Action");

    recorded.push({ action, body, method: request.method, url: request.url });

    if (request.url.startsWith("https://sns.")) {
      if (action === "CreateTopic") {
        return new Response(
          "<CreateTopicResponse><CreateTopicResult><TopicArn>arn:aws:sns:us-east-1:123456789012:sendoff-events</TopicArn></CreateTopicResult></CreateTopicResponse>"
        );
      }

      return new Response(
        `<ListSubscriptionsByTopicResponse><ListSubscriptionsByTopicResult><Subscriptions>
          <member><Endpoint>https://other.example.com/hook</Endpoint><SubscriptionArn>arn:aws:sns:x</SubscriptionArn></member>
          <member><Endpoint>https://news.example.com/webhooks/ses</Endpoint><SubscriptionArn>PendingConfirmation</SubscriptionArn></member>
        </Subscriptions></ListSubscriptionsByTopicResult></ListSubscriptionsByTopicResponse>`
      );
    }

    if (request.method === "POST" && request.url.endsWith("/identities")) {
      return Response.json(
        { message: "Exists" },
        {
          headers: { "x-amzn-ErrorType": "AlreadyExistsException" },
          status: 400,
        }
      );
    }

    if (request.url.endsWith("/identities/example.com")) {
      return Response.json({
        DkimAttributes: { Status: "PENDING", Tokens: ["t1", "t2", "t3"] },
        VerifiedForSendingStatus: false,
      });
    }

    return Response.json({});
  };

  const aws = createAwsSetup(
    { accessKeyId: "AKID", region: "us-east-1", secretAccessKey: "secret" },
    fetcher
  );

  it("reuses an existing domain identity and returns its DKIM tokens", async () => {
    const identity = await aws.ensureDomainIdentity("example.com");

    expect(identity).toMatchObject({
      dkimTokens: ["t1", "t2", "t3"],
      verified: false,
    });
  });

  it("creates the topic over SNS's Query API and reads subscription state", async () => {
    const topicArn = await aws.ensureTopic("sendoff-events");

    expect(topicArn).toBe("arn:aws:sns:us-east-1:123456789012:sendoff-events");
    expect(accountIdFromTopicArn(topicArn)).toBe("123456789012");
    expect(
      await aws.subscriptionState(
        topicArn,
        "https://news.example.com/webhooks/ses"
      )
    ).toBe("pending");
    expect(
      await aws.subscriptionState(topicArn, "https://missing.example.com")
    ).toBe("missing");
    expect(
      recorded.find((call) => call.action === "CreateTopic")?.body
    ).toContain("Version=2010-03-31");
  });

  it("only lets SES publish to the topic, for this configuration set", () => {
    const policy = topicPolicy({
      accountId: "123456789012",
      configurationSet: "sendoff",
      region: "us-east-1",
      topicArn: "arn:aws:sns:us-east-1:123456789012:sendoff-events",
    });

    expect(policy.Statement[0]).toMatchObject({
      Condition: {
        StringEquals: { "AWS:SourceAccount": "123456789012" },
        StringLike: {
          "AWS:SourceArn":
            "arn:aws:ses:us-east-1:123456789012:configuration-set/sendoff",
        },
      },
      Principal: { Service: "ses.amazonaws.com" },
    });
  });

  it("parses XML values and entities", () => {
    expect(
      xmlValues("<a><Code>X&amp;Y</Code><Code> Z </Code></a>", "Code")
    ).toStrictEqual(["X&Y", "Z"]);
  });
});

/** A Cloudflare API client whose requests are recorded and answered by `handle`. */
const recordingApi = (
  handle: (request: Request) => Response | Promise<Response>,
  requests: Request[]
) =>
  createCloudflareApi("token", async (input, init) => {
    const request = new Request(input, init);

    requests.push(request.clone());

    return await handle(request);
  });

describe("Cloudflare zones and Pages domains", () => {
  it("looks for the hostname's zone in this account, most specific first", async () => {
    const requests: Request[] = [];

    const cloudflare = recordingApi((request) => {
      const name = new URL(request.url).searchParams.get("name");

      return Response.json({
        result:
          name === "example.com"
            ? [{ id: "zone", name, status: "pending" }]
            : [],
        success: true,
      });
    }, requests);

    expect(await cloudflare.findZone("news.example.com", "acct")).toStrictEqual(
      {
        id: "zone",
        name: "example.com",
        status: "pending",
      }
    );
    expect(
      requests.map((request) => new URL(request.url).search)
    ).toStrictEqual([
      "?name=news.example.com&account.id=acct",
      "?name=example.com&account.id=acct",
    ]);
  });

  it("adds a Pages custom domain only if it isn't there yet", async () => {
    const requests: Request[] = [];
    const domains = [{ name: "old.example.com", status: "active" }];

    const cloudflare = recordingApi(async (request) => {
      if (request.method === "POST") {
        const { name } = await request.json<{ name: string }>();

        domains.push({ name, status: "initializing" });

        return Response.json({
          result: { name, status: "initializing" },
          success: true,
        });
      }

      return Response.json({ result: domains, success: true });
    }, requests);

    expect(
      await cloudflare.ensurePagesDomain(
        "acct",
        "sendoff-pages",
        "news.example.com"
      )
    ).toBe("initializing");
    expect(
      await cloudflare.ensurePagesDomain(
        "acct",
        "sendoff-pages",
        "news.example.com"
      )
    ).toBe("initializing");
    expect(
      requests.map(
        (request) => `${request.method} ${new URL(request.url).pathname}`
      )
    ).toStrictEqual([
      "GET /client/v4/accounts/acct/pages/projects/sendoff-pages/domains",
      "POST /client/v4/accounts/acct/pages/projects/sendoff-pages/domains",
      "GET /client/v4/accounts/acct/pages/projects/sendoff-pages/domains",
    ]);
  });
});

/** An API whose zones are `zones` (name to status), recording the names it's asked for. */
const zonesApi = (zones: Record<string, string>, looked: string[] = []) =>
  createCloudflareApi("token", (input, init) => {
    const name = new URL(new Request(input, init).url).searchParams.get("name");
    const status = name ? zones[name] : undefined;

    looked.push(name ?? "");

    return Promise.resolve(
      Response.json({
        result: name && status ? [{ id: name, name, status }] : [],
        success: true,
      })
    );
  });

/** An API whose every call fails, like a login without permission to read zones. */
const failingApi = createCloudflareApi("token", () =>
  Promise.resolve(
    Response.json(
      { errors: [{ message: "Authentication error" }], success: false },
      { status: 403 }
    )
  )
);

/** A confirm prompt that answers `reply`, recording what it was asked. */
const asker = (reply: boolean) => {
  const asked: string[] = [];

  const confirm: Confirm = (message) => {
    asked.push(message);

    return Promise.resolve(reply);
  };

  return { asked, confirm };
};

describe("whether DNS is on Cloudflare", () => {
  it("trusts a zone lookup, and only asks when there isn't one", async () => {
    const prompt = asker(true);
    const api = zonesApi({ "example.com": "active", "other.com": "pending" });

    expect(
      await zoneOnCloudflare({
        accountId: "acct",
        api,
        confirm: prompt.confirm,
        domain: "news.example.com",
      })
    ).toMatchObject({ active: true, zone: { name: "example.com" } });
    expect(
      await zoneOnCloudflare({
        accountId: "acct",
        api,
        confirm: prompt.confirm,
        domain: "news.other.com",
      })
    ).toMatchObject({ active: false, zone: { status: "pending" } });
    expect(prompt.asked).toStrictEqual([]);

    for (const unknown of [null, failingApi]) {
      // oxlint-disable-next-line no-await-in-loop -- one question each, in order
      const answered = await zoneOnCloudflare({
        accountId: "acct",
        api: unknown,
        confirm: prompt.confirm,
        domain: "news.example.com",
      });

      expect(answered).toStrictEqual({ active: true, zone: "unknown" });
    }

    expect(prompt.asked).toStrictEqual([
      "Is news.example.com's DNS on Cloudflare, in this account?",
      "Is news.example.com's DNS on Cloudflare, in this account?",
    ]);
  });

  it("assumes the sender's domain is on Cloudflare off Pages, without looking", async () => {
    const prompt = asker(false);
    const looked: string[] = [];

    expect(
      await senderZoneOnCloudflare({
        accountId: "acct",
        api: zonesApi({}, looked),
        confirm: prompt.confirm,
        domain: "example.com",
        hostname: "news.example.com",
        hostnameChecked: true,
        usePages: false,
      })
    ).toBe(true);
    expect(looked).toStrictEqual([]);
    expect(prompt.asked).toStrictEqual([]);
  });

  it("finds the sender's domain on Cloudflare behind Pages when the hostname is on another domain", async () => {
    const prompt = asker(false);
    const looked: string[] = [];

    expect(
      await senderZoneOnCloudflare({
        accountId: "acct",
        api: zonesApi({ "example.com": "active" }, looked),
        confirm: prompt.confirm,
        domain: "example.com",
        hostname: "news.other.com",
        hostnameChecked: true,
        usePages: true,
      })
    ).toBe(true);
    expect(looked).toStrictEqual(["example.com"]);
    expect(prompt.asked).toStrictEqual([]);
  });

  it("doesn't ask again about a sender's domain this run found the hostname's DNS isn't on", async () => {
    const prompt = asker(true);

    expect(
      await senderZoneOnCloudflare({
        accountId: "acct",
        api: failingApi,
        confirm: prompt.confirm,
        domain: "example.com",
        hostname: "news.example.com",
        hostnameChecked: true,
        usePages: true,
      })
    ).toBe(false);
    expect(prompt.asked).toStrictEqual([]);
  });

  it("asks when it can't tell, and the hostname is elsewhere or its DNS wasn't checked this run", async () => {
    const prompt = asker(true);

    const cases = [
      // Pages kept from an earlier run: the DNS may have moved to Cloudflare since.
      { hostname: "news.example.com", hostnameChecked: false },
      { hostname: "news.other.com", hostnameChecked: true },
    ];

    for (const { hostname, hostnameChecked } of cases) {
      // oxlint-disable-next-line no-await-in-loop -- one question each, in order
      const onCloudflare = await senderZoneOnCloudflare({
        accountId: "acct",
        api: null,
        confirm: prompt.confirm,
        domain: "example.com",
        hostname,
        hostnameChecked,
        usePages: true,
      });

      expect(onCloudflare).toBe(true);
    }

    expect(prompt.asked).toStrictEqual([
      "Is example.com's DNS on Cloudflare, in this account?",
      "Is example.com's DNS on Cloudflare, in this account?",
    ]);
  });
});

describe("Cloudflare DNS", () => {
  it("treats any CNAME or MX at the name, or a second SPF/DMARC record, as a clash", () => {
    const cname = {
      content: "x.dkim.amazonses.com",
      name: "x._domainkey.example.com",
      purpose: "",
      type: "CNAME" as const,
    };

    const spf = {
      content: "v=spf1 include:amazonses.com ~all",
      name: "bounce.example.com",
      purpose: "",
      type: "TXT" as const,
    };

    expect(clashes(cname, cname.content, ["something.else"])).toBe(true);
    expect(clashes(cname, cname.content, [])).toBe(false);
    expect(
      clashes(spf, spf.content, ["v=spf1 include:_spf.google.com ~all"])
    ).toBe(true);
    expect(clashes(spf, spf.content, ["google-site-verification=abc"])).toBe(
      false
    );
  });

  it("creates missing records and leaves existing ones alone", async () => {
    const created: string[] = [];

    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);

      if (request.method === "POST") {
        created.push(await request.text());

        return Response.json({
          result: { content: "x", id: "new", name: "x", type: "CNAME" },
          success: true,
        });
      }

      const name = new URL(request.url).searchParams.get("name");

      return Response.json({
        result:
          name === "a._domainkey.example.com"
            ? [
                {
                  content: "a.dkim.amazonses.com",
                  id: "1",
                  name,
                  type: "CNAME",
                },
              ]
            : [],
        success: true,
      });
    };

    const api = createCloudflareApi("token", fetcher);

    const exists = await api.ensureDnsRecord("zone", {
      content: "a.dkim.amazonses.com",
      name: "a._domainkey.example.com",
      purpose: "",
      type: "CNAME",
    });

    const added = await api.ensureDnsRecord("zone", {
      content: "b.dkim.amazonses.com",
      name: "b._domainkey.example.com",
      purpose: "",
      type: "CNAME",
    });

    expect([exists, added]).toStrictEqual(["exists", "created"]);
    expect(JSON.parse(created[0] ?? "{}")).toMatchObject({
      name: "b._domainkey.example.com",
      proxied: false,
    });
  });
});

describe("Worker releases", () => {
  it("picks the newest stable app@ tag, numerically", () => {
    expect(
      latestRelease([
        "app@0.0.0",
        "app@1.9.0",
        "app@1.10.0",
        "app@2.0.0-next.0",
        "create-sendoff@3.0.0",
        "",
      ])
    ).toStrictEqual({ tag: "app@1.10.0", version: [1, 10, 0] });
    expect(latestRelease(["create-sendoff@1.0.0"])).toBeNull();
    expect(parseVersion("1.2.3-next.0")).toBeNull();
  });

  it("keeps the changelog sections after the current version, up to the target", () => {
    const changelog = [
      "# app",
      "",
      "## 1.2.0",
      "",
      "### Minor Changes",
      "",
      "- abc: Something new.",
      "",
      "## 1.1.1",
      "",
      "- def: A fix.",
      "",
      "## 1.1.0",
      "",
      "- ghi: Already have this.",
    ].join("\n");

    expect(releaseNotes(changelog, [1, 1, 0], [1, 2, 0])).toBe(
      [
        "## 1.2.0",
        "",
        "### Minor Changes",
        "",
        "- abc: Something new.",
        "",
        "## 1.1.1",
        "",
        "- def: A fix.",
      ].join("\n")
    );
    expect(releaseNotes(changelog, [1, 1, 0], [1, 1, 1])).toBe(
      "## 1.1.1\n\n- def: A fix."
    );
    expect(releaseNotes(changelog, [1, 2, 0], [1, 2, 0])).toBe("");
  });
});
