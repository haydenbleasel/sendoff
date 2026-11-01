import { AwsClient } from "aws4fetch";

// A minimal Amazon SES v2 client over aws4fetch (SigV4 with WebCrypto), so
// the Worker doesn't bundle the AWS SDK. Only the calls Sendoff needs.

export interface SesConfig {
  accessKeyId: string;
  region: string;
  secretAccessKey: string;
}

export interface Address {
  email: string;
  name?: string | undefined;
}

export interface SendEmailInput {
  configurationSet?: string | undefined;
  from: Address;
  headers?: Record<string, string> | undefined;
  html: string;
  replyTo?: string | undefined;
  subject: string;
  tags?: Record<string, string> | undefined;
  text: string;
  to: string;
}

export interface SesAccount {
  enforcementStatus: string | undefined;
  max24HourSend: number;
  maxSendRate: number;
  productionAccessEnabled: boolean;
  sendingEnabled: boolean;
  sentLast24Hours: number;
  /** Reasons the account-level suppression list covers, e.g. BOUNCE, COMPLAINT. */
  suppressedReasons: string[];
}

export interface SesEventDestination {
  enabled: boolean;
  eventTypes: string[];
  name: string;
  snsTopicArn: string | undefined;
}

export interface SesIdentity {
  dkimStatus: string | undefined;
  mailFromDomain: string | undefined;
  mailFromStatus: string | undefined;
  verifiedForSending: boolean;
}

const HTTP_NOT_FOUND = 404;

// SES tag values allow only letters, numbers, _ - . @
const TAG_INVALID_CHARACTERS = /[^\w.@-]/gu;

// Printable ASCII can go in a quoted string (with " and \ escaped).
const PLAIN_DISPLAY_NAME = /^[\u0020-\u007E]*$/u;

/** What to do about one is up to the caller: see `classify` in sending.ts. */
export class SesError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(`SES ${code}: ${message}`);
    this.name = "SesError";
    this.code = code;
    this.status = status;
  }
}

const encodeBase64 = (value: string): string => {
  let binary = "";

  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCodePoint(byte);
  }

  return btoa(binary);
};

/**
 * Format `"Name" <email>`. Non-ASCII names use RFC 2047 encoded-words,
 * which SES requires for the From header.
 */
export const formatAddress = ({ email, name }: Address): string => {
  if (!name) {
    return email;
  }

  if (PLAIN_DISPLAY_NAME.test(name)) {
    return `"${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}" <${email}>`;
  }

  return `=?UTF-8?B?${encodeBase64(name)}?= <${email}>`;
};

interface SesErrorBody {
  message?: string;
  Message?: string;
  __type?: string;
}

const parseError = async (response: Response): Promise<SesError> => {
  const headerCode = response.headers.get("x-amzn-ErrorType")?.split(":")[0];
  let body: SesErrorBody = {};

  try {
    body = await response.json<SesErrorBody>();
  } catch {
    // Some errors (e.g. from the load balancer) have no JSON body.
  }

  const code = headerCode ?? body.__type ?? `HTTP${response.status}`;
  const message = body.message ?? body.Message ?? response.statusText;

  return new SesError(code, message, response.status);
};

const content = (data: string) => ({ Charset: "utf-8", Data: data });

export const createSesClient = (
  config: SesConfig,
  fetcher: typeof fetch = fetch
) => {
  const aws = new AwsClient({
    accessKeyId: config.accessKeyId,
    region: config.region,
    secretAccessKey: config.secretAccessKey,
    service: "ses",
  });

  const baseUrl = `https://email.${config.region}.amazonaws.com/v2/email`;

  const request = async <T>(
    path: string,
    init: RequestInit = {}
  ): Promise<T> => {
    const signed = await aws.sign(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json" },
    });

    const response = await fetcher(signed);

    if (!response.ok) {
      throw await parseError(response);
    }

    return await response.json<T>();
  };

  return {
    getAccount: async (): Promise<SesAccount> => {
      const account = await request<{
        EnforcementStatus?: string;
        ProductionAccessEnabled?: boolean;
        SendQuota?: {
          Max24HourSend?: number;
          MaxSendRate?: number;
          SentLast24Hours?: number;
        };
        SendingEnabled?: boolean;
        SuppressionAttributes?: { SuppressedReasons?: string[] };
      }>("/account");

      return {
        enforcementStatus: account.EnforcementStatus,
        max24HourSend: account.SendQuota?.Max24HourSend ?? 0,
        maxSendRate: account.SendQuota?.MaxSendRate ?? 0,
        productionAccessEnabled: account.ProductionAccessEnabled ?? false,
        sendingEnabled: account.SendingEnabled ?? false,
        sentLast24Hours: account.SendQuota?.SentLast24Hours ?? 0,
        suppressedReasons:
          account.SuppressionAttributes?.SuppressedReasons ?? [],
      };
    },

    /** Returns null when the identity doesn't exist in this account/region. */
    getEmailIdentity: async (identity: string): Promise<SesIdentity | null> => {
      try {
        const result = await request<{
          DkimAttributes?: { Status?: string };
          MailFromAttributes?: {
            MailFromDomain?: string;
            MailFromDomainStatus?: string;
          };
          VerifiedForSendingStatus?: boolean;
        }>(`/identities/${encodeURIComponent(identity)}`);

        return {
          dkimStatus: result.DkimAttributes?.Status,
          mailFromDomain: result.MailFromAttributes?.MailFromDomain,
          mailFromStatus: result.MailFromAttributes?.MailFromDomainStatus,
          verifiedForSending: result.VerifiedForSendingStatus ?? false,
        };
      } catch (error) {
        if (error instanceof SesError && error.status === HTTP_NOT_FOUND) {
          return null;
        }

        throw error;
      }
    },

    /** Event destinations for a configuration set, or null if the set doesn't exist. */
    getEventDestinations: async (
      configurationSet: string
    ): Promise<SesEventDestination[] | null> => {
      try {
        const result = await request<{
          EventDestinations?: {
            Enabled?: boolean;
            MatchingEventTypes?: string[];
            Name: string;
            SnsDestination?: { TopicArn?: string };
          }[];
        }>(
          `/configuration-sets/${encodeURIComponent(configurationSet)}/event-destinations`
        );

        return (result.EventDestinations ?? []).map((destination) => ({
          enabled: destination.Enabled ?? false,
          eventTypes: destination.MatchingEventTypes ?? [],
          name: destination.Name,
          snsTopicArn: destination.SnsDestination?.TopicArn,
        }));
      } catch (error) {
        if (error instanceof SesError && error.status === HTTP_NOT_FOUND) {
          return null;
        }

        throw error;
      }
    },

    sendEmail: async (
      input: SendEmailInput
    ): Promise<{ messageId: string }> => {
      const body = {
        ConfigurationSetName: input.configurationSet,
        Content: {
          Simple: {
            Body: { Html: content(input.html), Text: content(input.text) },
            Headers: Object.entries(input.headers ?? {}).map(
              ([Name, Value]) => ({
                Name,
                Value,
              })
            ),
            Subject: content(input.subject),
          },
        },
        Destination: { ToAddresses: [input.to] },
        EmailTags: Object.entries(input.tags ?? {}).map(([Name, Value]) => ({
          Name,
          Value: Value.replaceAll(TAG_INVALID_CHARACTERS, "_"),
        })),
        FromEmailAddress: formatAddress(input.from),
        ReplyToAddresses: input.replyTo ? [input.replyTo] : undefined,
      };

      const result = await request<{ MessageId: string }>("/outbound-emails", {
        body: JSON.stringify(body),
        method: "POST",
      });

      return { messageId: result.MessageId };
    },
  };
};

export type SesClient = ReturnType<typeof createSesClient>;
