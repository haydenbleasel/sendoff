import { z } from "zod";

import type { DnsRecord } from "./dns";

// Cloudflare API calls setup makes. With the person's optional API token:
// DNS records and a Turnstile widget. With Wrangler's own login, whose OAuth
// scopes cover reading zones and editing Pages but not DNS or Turnstile:
// finding the hostname's and sender's domain's zones, and adding a Pages
// custom domain. Workers, D1, queues and secrets go through Wrangler itself.

const API = "https://api.cloudflare.com/client/v4";
const MIN_ZONE_LABELS = 2;

const envelope = <T extends z.ZodType>(result: T) =>
  z.object({
    errors: z
      .array(z.object({ code: z.number().optional(), message: z.string() }))
      .default([]),
    result: result.nullable().optional(),
    success: z.boolean(),
  });

export class CloudflareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CloudflareError";
  }
}

const zoneSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** "active" once its nameservers point at Cloudflare. */
  status: z.string().optional(),
});

const pagesDomainSchema = z.object({
  name: z.string(),
  status: z.string().optional(),
});

const dnsRecordSchema = z.object({
  content: z.string(),
  id: z.string(),
  name: z.string(),
  priority: z.number().optional(),
  type: z.string(),
});

const widgetSchema = z.object({ secret: z.string(), sitekey: z.string() });

/** TXT contents come back quoted; compare without the quotes. */
const unquote = (value: string): string => value.replaceAll('"', "");

export type RecordOutcome = "created" | "exists" | "conflict";

/** SPF and DMARC allow one record per name; other TXT records can coexist. */
const exclusiveTxtKind = (value: string): string | null => {
  if (value.startsWith("v=spf1")) {
    return "v=spf1";
  }

  return value.startsWith("v=dmarc1") ? "v=dmarc1" : null;
};

/**
 * Whether adding `record` would clash with what's already at that name: any
 * CNAME or MX, or another SPF or DMARC record. Clashes are left for a person
 * to resolve rather than overwritten.
 */
export const clashes = (
  record: DnsRecord,
  wanted: string,
  existing: string[]
): boolean => {
  if (record.type !== "TXT") {
    return existing.length > 0;
  }

  const kind = exclusiveTxtKind(wanted);

  return kind !== null && existing.some((value) => value.startsWith(kind));
};

/** Asks a yes-or-no question; setup passes clack's `confirm`. */
export type Confirm = (message: string) => Promise<boolean>;

/** A zone `findZone` found, null if none, or "unknown" when it couldn't look. */
export type ZoneLookup = z.output<typeof zoneSchema> | null | "unknown";

/**
 * Whether `domain`'s DNS is an active zone in `accountId`. It looks with
 * `api` (Wrangler's login), and only asks with `confirm` when it can't tell:
 * with no API, or when the lookup fails. `zone` is what the lookup found.
 */
export const zoneOnCloudflare = async ({
  accountId,
  api,
  confirm,
  domain,
}: {
  accountId: string;
  api: CloudflareApi | null;
  confirm: Confirm;
  domain: string;
}): Promise<{ active: boolean; zone: ZoneLookup }> => {
  const zone: ZoneLookup = api
    ? await api.findZone(domain, accountId).catch(() => "unknown" as const)
    : "unknown";

  return {
    active:
      zone === "unknown"
        ? await confirm(`Is ${domain}'s DNS on Cloudflare, in this account?`)
        : zone?.status === "active",
    zone,
  };
};

/**
 * Whether the API token can add SES's records to the sender's domain
 * (`domain`), because it's an active zone in `accountId`.
 *
 * Off Pages, setup assumes so: it asks for DNS permissions, and says so if
 * the token can't see the zone when it adds them. Behind Pages, the sender's
 * domain can still be on Cloudflare: when the hostname is on another domain,
 * like news.other.com sending from example.com, or when the DNS moved to
 * Cloudflare after Pages was set up. A hostname on the sender's domain shares
 * its DNS, so when `hostnameChecked` (this run found the hostname's DNS isn't
 * on Cloudflare, rather than keeping Pages from an earlier run), it doesn't
 * ask again.
 */
export const senderZoneOnCloudflare = async ({
  accountId,
  api,
  confirm,
  domain,
  hostname,
  hostnameChecked,
  usePages,
}: {
  accountId: string;
  api: CloudflareApi | null;
  confirm: Confirm;
  domain: string;
  hostname: string;
  hostnameChecked: boolean;
  usePages: boolean;
}): Promise<boolean> => {
  if (!usePages) {
    return true;
  }

  const sharesDns =
    hostnameChecked && (hostname === domain || hostname.endsWith(`.${domain}`));

  const { active } = await zoneOnCloudflare({
    accountId,
    api,
    // Already answered: the hostname's DNS, which is the domain's, isn't on Cloudflare.
    confirm: sharesDns ? () => Promise.resolve(false) : confirm,
    domain,
  });

  return active;
};

export const createCloudflareApi = (
  token: string,
  fetcher: typeof fetch = fetch
) => {
  const call = async <T extends z.ZodType>(
    path: string,
    schema: T,
    init: RequestInit = {}
  ): Promise<z.output<T>> => {
    const response = await fetcher(`${API}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    });

    const parsed = envelope(schema).parse(await response.json());

    if (
      !parsed.success ||
      parsed.result === undefined ||
      parsed.result === null
    ) {
      throw new CloudflareError(
        parsed.errors.map((error) => error.message).join("; ") ||
          `Cloudflare API error (${response.status})`
      );
    }

    return parsed.result;
  };

  /** The zone `domain` belongs to, if it's on Cloudflare (in `accountId`, when given). */
  const findZone = async (domain: string, accountId?: string) => {
    let labels = domain.split(".");

    while (labels.length >= MIN_ZONE_LABELS) {
      const query = new URLSearchParams({ name: labels.join(".") });

      if (accountId) {
        query.set("account.id", accountId);
      }

      // oxlint-disable-next-line no-await-in-loop -- most specific zone first
      const [zone] = await call(`/zones?${query}`, z.array(zoneSchema));

      if (zone) {
        return zone;
      }

      labels = labels.slice(1);
    }

    return null;
  };

  return {
    createTurnstileWidget: async (
      accountId: string,
      name: string,
      domains: string[]
    ) =>
      await call(`/accounts/${accountId}/challenges/widgets`, widgetSchema, {
        body: JSON.stringify({ domains, mode: "managed", name }),
        method: "POST",
      }),

    /** Add a record unless an identical one exists. A different value at the same name and type is left alone. */
    ensureDnsRecord: async (
      zoneId: string,
      record: DnsRecord
    ): Promise<RecordOutcome> => {
      const existing = await call(
        `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
        z.array(dnsRecordSchema)
      );

      const wanted = unquote(record.content).toLowerCase();

      if (
        existing.some((item) => unquote(item.content).toLowerCase() === wanted)
      ) {
        return "exists";
      }

      if (
        clashes(
          record,
          wanted,
          existing.map((item) => unquote(item.content).toLowerCase())
        )
      ) {
        return "conflict";
      }

      await call(`/zones/${zoneId}/dns_records`, dnsRecordSchema, {
        body: JSON.stringify({
          content: record.content,
          name: record.name,
          priority: record.priority,
          proxied: false,
          ttl: 1,
          type: record.type,
        }),
        method: "POST",
      });

      return "created";
    },

    /** Add `hostname` as a custom domain of a Pages project, unless it already is one. Returns its status. */
    ensurePagesDomain: async (
      accountId: string,
      project: string,
      hostname: string
    ): Promise<string | undefined> => {
      const path = `/accounts/${accountId}/pages/projects/${encodeURIComponent(project)}/domains`;
      const domains = await call(path, z.array(pagesDomainSchema));
      const existing = domains.find((domain) => domain.name === hostname);

      if (existing) {
        return existing.status;
      }

      const added = await call(path, pagesDomainSchema, {
        body: JSON.stringify({ name: hostname }),
        method: "POST",
      });

      return added.status;
    },

    findZone,

    getTurnstileWidget: async (accountId: string, sitekey: string) =>
      await call(
        `/accounts/${accountId}/challenges/widgets/${sitekey}`,
        widgetSchema
      ),

    verifyToken: async (): Promise<void> => {
      await call("/user/tokens/verify", z.object({ status: z.string() }));
    },
  };
};

export type CloudflareApi = ReturnType<typeof createCloudflareApi>;
