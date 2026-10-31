import { describe, expect, it } from "vitest";

import {
  accountIdFromTopicArn,
  createAwsSetup,
  topicPolicy,
  xmlValues,
} from "../scripts/setup/aws";
import { clashes, createCloudflareApi } from "../scripts/setup/cloudflare";
import { mailFromDomainFor, sesDnsRecords } from "../scripts/setup/dns";
import { deployConfig, instanceSchema } from "../scripts/setup/instance";

const instance = instanceSchema.parse({
  accountId: "acct",
  databaseId: "db-123",
  hostname: "news.example.com",
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
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_id: "db-123",
          migrations_dir: "../migrations",
        },
      ],
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
