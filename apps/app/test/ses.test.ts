import { describe, expect, it } from "vitest";

import { createSesClient, formatAddress, SesError } from "../src/ses";

const config = {
  accessKeyId: "AKIDEXAMPLE",
  region: "us-east-1",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

const capture = (response: Response) => {
  const requests: Request[] = [];

  const fetcher: typeof fetch = (input, init) => {
    requests.push(new Request(input, init));

    return Promise.resolve(response);
  };

  return { fetcher, requests };
};

describe("formatAddress", () => {
  it("quotes plain names, escapes quotes and encodes non-ASCII names", () => {
    expect(formatAddress({ email: "a@example.com" })).toBe("a@example.com");
    expect(
      formatAddress({ email: "a@example.com", name: 'Hayden "H" B' })
    ).toBe('"Hayden \\"H\\" B" <a@example.com>');
    expect(formatAddress({ email: "a@example.com", name: "Zoë" })).toBe(
      "=?UTF-8?B?Wm/Dqw==?= <a@example.com>"
    );
  });
});

describe("createSesClient", () => {
  it("sends a signed SendEmail request with headers and tags", async () => {
    const { fetcher, requests } = capture(
      Response.json({ MessageId: "abc-123" })
    );

    const ses = createSesClient(config, fetcher);

    const result = await ses.sendEmail({
      configurationSet: "sendoff",
      from: { email: "hello@example.com", name: "Sendoff" },
      headers: {
        "List-Unsubscribe": "<https://example.com/unsubscribe/token>",
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
      html: "<p>Hi</p>",
      replyTo: "reply@example.com",
      subject: "Hello",
      tags: { issue: "q4 2026" },
      text: "Hi",
      to: "reader@example.com",
    });

    expect(result).toStrictEqual({ messageId: "abc-123" });

    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      "https://email.us-east-1.amazonaws.com/v2/email/outbound-emails"
    );
    expect(request?.headers.get("authorization")).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request/u
    );

    const body = await request?.json();
    expect(body).toMatchObject({
      ConfigurationSetName: "sendoff",
      Content: {
        Simple: {
          Headers: [
            {
              Name: "List-Unsubscribe",
              Value: "<https://example.com/unsubscribe/token>",
            },
            {
              Name: "List-Unsubscribe-Post",
              Value: "List-Unsubscribe=One-Click",
            },
          ],
          Subject: { Charset: "utf-8", Data: "Hello" },
        },
      },
      Destination: { ToAddresses: ["reader@example.com"] },
      EmailTags: [{ Name: "issue", Value: "q4_2026" }],
      FromEmailAddress: '"Sendoff" <hello@example.com>',
      ReplyToAddresses: ["reply@example.com"],
    });
  });

  it("maps throttling to a retryable SesError", async () => {
    const { fetcher } = capture(
      Response.json(
        { message: "Maximum sending rate exceeded." },
        {
          headers: { "x-amzn-ErrorType": "TooManyRequestsException:" },
          status: 429,
        }
      )
    );

    const ses = createSesClient(config, fetcher);

    const sending = ses.sendEmail({
      from: { email: "a@example.com" },
      html: "",
      subject: "",
      text: "",
      to: "b@example.com",
    });

    await expect(sending).rejects.toBeInstanceOf(SesError);
    await expect(sending).rejects.toMatchObject({
      code: "TooManyRequestsException",
      retryable: true,
    });
  });

  it("treats a rejected message as permanent", () => {
    const error = new SesError(
      "MessageRejected",
      "Email address is not verified.",
      400
    );

    expect(error.retryable).toBe(false);
  });

  it("returns null for a missing identity and maps account details", async () => {
    const missing = capture(
      Response.json(
        { message: "Not found" },
        {
          headers: { "x-amzn-ErrorType": "NotFoundException" },
          status: 404,
        }
      )
    );

    expect(
      await createSesClient(config, missing.fetcher).getEmailIdentity(
        "example.com"
      )
    ).toBeNull();

    const account = capture(
      Response.json({
        ProductionAccessEnabled: true,
        SendQuota: {
          Max24HourSend: 50_000,
          MaxSendRate: 14,
          SentLast24Hours: 12,
        },
        SendingEnabled: true,
      })
    );

    expect(
      await createSesClient(config, account.fetcher).getAccount()
    ).toStrictEqual({
      enforcementStatus: undefined,
      max24HourSend: 50_000,
      maxSendRate: 14,
      productionAccessEnabled: true,
      sendingEnabled: true,
      sentLast24Hours: 12,
      suppressedReasons: [],
    });
  });
});
