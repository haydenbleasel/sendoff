import { AwsClient } from "aws4fetch";

import type { JsonObject } from "../../src/json";

// Provisioning calls for setup only (the Worker uses src/ses.ts). SES v2 is
// a JSON API; SNS is the older form-encoded Query API with XML responses.

export interface AwsCredentials {
  accessKeyId: string;
  region: string;
  secretAccessKey: string;
}

export class AwsError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(`${code}: ${message}`);
    this.name = "AwsError";
    this.code = code;
    this.status = status;
  }
}

const SNS_VERSION = "2010-03-31";

const XML_TAG = (tag: string) =>
  new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "gu");

const XML_ENTITIES = new Map([
  ["&amp;", "&"],
  ["&apos;", "'"],
  ["&gt;", ">"],
  ["&lt;", "<"],
  ["&quot;", '"'],
]);

const XML_ENTITY = /&(?:amp|apos|gt|lt|quot);/gu;
const ACCOUNT_IN_ARN = /^arn:aws[\w-]*:sns:[\w-]+:(?<account>\d+):/u;

const unescapeXml = (value: string): string =>
  value.replaceAll(XML_ENTITY, (entity) => XML_ENTITIES.get(entity) ?? entity);

/** Every text value of <tag> in an XML document, in order. */
export const xmlValues = (xml: string, tag: string): string[] =>
  [...xml.matchAll(XML_TAG(tag))].map((match) =>
    unescapeXml(match[1] ?? "").trim()
  );

export const accountIdFromTopicArn = (topicArn: string): string => {
  const account = ACCOUNT_IN_ARN.exec(topicArn)?.groups?.account;

  if (!account) {
    throw new Error(`Couldn't read the AWS account id from ${topicArn}`);
  }

  return account;
};

/** Lets SES (and only for this configuration set) publish events to the topic. */
export const topicPolicy = ({
  accountId,
  configurationSet,
  region,
  topicArn,
}: {
  accountId: string;
  configurationSet: string;
  region: string;
  topicArn: string;
}) => ({
  Statement: [
    {
      Action: "SNS:Publish",
      Condition: {
        StringEquals: { "AWS:SourceAccount": accountId },
        StringLike: {
          "AWS:SourceArn": `arn:aws:ses:${region}:${accountId}:configuration-set/${configurationSet}`,
        },
      },
      Effect: "Allow",
      Principal: { Service: "ses.amazonaws.com" },
      Resource: topicArn,
      Sid: "AllowSesToPublishSendoffEvents",
    },
  ],
  Version: "2012-10-17",
});

export type TopicPolicy = ReturnType<typeof topicPolicy>;

/** The IAM policy setup prints for the keys Sendoff uses. */
export const IAM_POLICY = {
  Statement: [
    {
      Action: [
        "ses:CreateConfigurationSet",
        "ses:CreateConfigurationSetEventDestination",
        "ses:CreateEmailIdentity",
        "ses:GetAccount",
        "ses:GetConfigurationSet",
        "ses:GetConfigurationSetEventDestinations",
        "ses:GetEmailIdentity",
        "ses:PutAccountDetails",
        "ses:PutAccountSuppressionAttributes",
        "ses:PutEmailIdentityMailFromAttributes",
        "ses:SendEmail",
        "ses:UpdateConfigurationSetEventDestination",
      ],
      Effect: "Allow",
      Resource: "*",
      Sid: "SendoffSes",
    },
    {
      Action: [
        "sns:CreateTopic",
        "sns:GetTopicAttributes",
        "sns:ListSubscriptionsByTopic",
        "sns:SetTopicAttributes",
        "sns:Subscribe",
      ],
      Effect: "Allow",
      Resource: "arn:aws:sns:*:*:sendoff-*",
      Sid: "SendoffSns",
    },
  ],
  Version: "2012-10-17",
};

export type SubscriptionState = "confirmed" | "pending" | "missing";

/** Run a create call, treating "already exists" as success. */
const ignoreExisting = async (task: () => Promise<void>): Promise<void> => {
  try {
    await task();
  } catch (error) {
    if (
      !(error instanceof AwsError && error.code === "AlreadyExistsException")
    ) {
      throw error;
    }
  }
};

export const createAwsSetup = (
  credentials: AwsCredentials,
  fetcher: typeof fetch = fetch
) => {
  const { region } = credentials;
  const ses = new AwsClient({ ...credentials, service: "ses" });
  const sns = new AwsClient({ ...credentials, service: "sns" });
  const sesBase = `https://email.${region}.amazonaws.com/v2/email`;
  const snsBase = `https://sns.${region}.amazonaws.com/`;

  const sesCall = async <T>(
    method: string,
    path: string,
    body?: JsonObject
  ): Promise<T> => {
    const request = await ses.sign(`${sesBase}${path}`, {
      body: body ? JSON.stringify(body) : null,
      headers: { "content-type": "application/json" },
      method,
    });

    const response = await fetcher(request);
    const text = await response.text();

    if (!response.ok) {
      const parsed: { message?: string; Message?: string } = text
        ? JSON.parse(text)
        : {};

      const code =
        response.headers.get("x-amzn-ErrorType")?.split(":")[0] ??
        `HTTP${response.status}`;

      throw new AwsError(
        code,
        parsed.message ?? parsed.Message ?? response.statusText,
        response.status
      );
    }

    // SAFETY: each caller names the documented SES v2 response shape it reads.
    return (text ? JSON.parse(text) : {}) as T;
  };

  const snsCall = async (
    action: string,
    params: Record<string, string>
  ): Promise<string> => {
    const request = await sns.sign(snsBase, {
      body: new URLSearchParams({
        Action: action,
        Version: SNS_VERSION,
        ...params,
      }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
    });

    const response = await fetcher(request);
    const xml = await response.text();

    if (!response.ok) {
      throw new AwsError(
        xmlValues(xml, "Code")[0] ?? `HTTP${response.status}`,
        xmlValues(xml, "Message")[0] ?? response.statusText,
        response.status
      );
    }

    return xml;
  };

  return {
    enableSuppressionList: async (): Promise<void> => {
      await sesCall("PUT", "/account/suppression", {
        SuppressedReasons: ["BOUNCE", "COMPLAINT"],
      });
    },

    ensureConfigurationSet: async (name: string): Promise<void> => {
      await ignoreExisting(async () => {
        await sesCall("POST", "/configuration-sets", {
          ConfigurationSetName: name,
        });
      });
    },

    /** Create (or reuse) the domain identity with Easy DKIM; returns its DKIM tokens. */
    ensureDomainIdentity: async (domain: string) => {
      await ignoreExisting(async () => {
        await sesCall("POST", "/identities", { EmailIdentity: domain });
      });

      const identity = await sesCall<{
        DkimAttributes?: { Status?: string; Tokens?: string[] };
        MailFromAttributes?: {
          MailFromDomain?: string;
          MailFromDomainStatus?: string;
        };
        VerifiedForSendingStatus?: boolean;
      }>("GET", `/identities/${encodeURIComponent(domain)}`);

      return {
        dkimStatus: identity.DkimAttributes?.Status ?? "NOT_STARTED",
        dkimTokens: identity.DkimAttributes?.Tokens ?? [],
        mailFromDomain: identity.MailFromAttributes?.MailFromDomain,
        mailFromStatus: identity.MailFromAttributes?.MailFromDomainStatus,
        verified: identity.VerifiedForSendingStatus ?? false,
      };
    },

    /** Send bounces, complaints and rejects (not opens or clicks) to the topic. */
    ensureEventDestination: async (
      configurationSet: string,
      topicArn: string
    ): Promise<void> => {
      const destination = {
        Enabled: true,
        MatchingEventTypes: ["BOUNCE", "COMPLAINT", "REJECT"],
        SnsDestination: { TopicArn: topicArn },
      };

      const path = `/configuration-sets/${encodeURIComponent(configurationSet)}/event-destinations`;

      try {
        await sesCall("POST", path, {
          EventDestination: destination,
          EventDestinationName: "sendoff",
        });
      } catch (error) {
        if (
          !(
            error instanceof AwsError && error.code === "AlreadyExistsException"
          )
        ) {
          throw error;
        }

        await sesCall("PUT", `${path}/sendoff`, {
          EventDestination: destination,
        });
      }
    },

    ensureTopic: async (name: string): Promise<string> => {
      const xml = await snsCall("CreateTopic", { Name: name });
      const [topicArn] = xmlValues(xml, "TopicArn");

      if (!topicArn) {
        throw new Error("SNS didn't return a topic ARN.");
      }

      return topicArn;
    },

    getAccount: async () => {
      const account = await sesCall<{
        Details?: { ReviewDetails?: { Status?: string } };
        ProductionAccessEnabled?: boolean;
        SendQuota?: { Max24HourSend?: number; MaxSendRate?: number };
      }>("GET", "/account");

      return {
        maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
        productionAccessEnabled: account.ProductionAccessEnabled ?? false,
        reviewStatus: account.Details?.ReviewDetails?.Status,
      };
    },

    requestProductionAccess: async ({
      contactEmail,
      useCase,
      websiteUrl,
    }: {
      contactEmail: string;
      useCase: string;
      websiteUrl: string;
    }): Promise<void> => {
      await sesCall("POST", "/account/details", {
        AdditionalContactEmailAddresses: [contactEmail],
        ContactLanguage: "EN",
        MailType: "MARKETING",
        ProductionAccessEnabled: true,
        UseCaseDescription: useCase,
        WebsiteURL: websiteUrl,
      });
    },

    setMailFromDomain: async (
      domain: string,
      mailFromDomain: string
    ): Promise<void> => {
      await sesCall(
        "PUT",
        `/identities/${encodeURIComponent(domain)}/mail-from`,
        {
          BehaviorOnMxFailure: "USE_DEFAULT_VALUE",
          MailFromDomain: mailFromDomain,
        }
      );
    },

    setTopicPolicy: async (
      topicArn: string,
      policy: TopicPolicy
    ): Promise<void> => {
      await snsCall("SetTopicAttributes", {
        AttributeName: "Policy",
        AttributeValue: JSON.stringify(policy),
        TopicArn: topicArn,
      });
    },

    subscribeHttps: async (
      topicArn: string,
      endpoint: string
    ): Promise<void> => {
      await snsCall("Subscribe", {
        Endpoint: endpoint,
        Protocol: "https",
        TopicArn: topicArn,
      });
    },

    subscriptionState: async (
      topicArn: string,
      endpoint: string
    ): Promise<SubscriptionState> => {
      const xml = await snsCall("ListSubscriptionsByTopic", {
        TopicArn: topicArn,
      });

      const endpoints = xmlValues(xml, "Endpoint");
      const arns = xmlValues(xml, "SubscriptionArn");
      const index = endpoints.indexOf(endpoint);

      if (index === -1) {
        return "missing";
      }

      return arns[index]?.startsWith("arn:") ? "confirmed" : "pending";
    },
  };
};

export type AwsSetup = ReturnType<typeof createAwsSetup>;
