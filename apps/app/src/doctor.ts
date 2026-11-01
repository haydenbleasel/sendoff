import { z } from "zod";

import { createSes } from "./config";
import type { Config } from "./config";
import type { Database } from "./db/client";
import type { SesAccount, SesClient } from "./ses";
import { getSettings } from "./settings";
import type { Settings } from "./settings";
import { countSubscribers } from "./subscribers";

// Preflight checks before a send. A "fail" blocks prepare_send; a "warn"
// is worth fixing but doesn't stop anything.

export type CheckStatus = "pass" | "warn" | "fail";

export interface Check {
  detail: string;
  name: string;
  status: CheckStatus;
}

export interface DoctorReport {
  account: SesAccount | null;
  activeSubscribers: number;
  checks: Check[];
  ok: boolean;
  settings: Settings | null;
}

const DOH_URL = "https://cloudflare-dns.com/dns-query";
const TXT_RECORD = 16;
const MIN_DOMAIN_LABELS = 2;
const TRAILING_PERIOD = /\.+$/u;
const QUOTED_CHUNK = /"(?<chunk>[^"]*)"/gu;
const REQUIRED_EVENTS = ["BOUNCE", "COMPLAINT"] as const;

const dohSchema = z.object({
  Answer: z.array(z.object({ data: z.string(), type: z.number() })).optional(),
  Status: z.number(),
});

const check = (status: CheckStatus, name: string, detail: string): Check => ({
  detail,
  name,
  status,
});

/** TXT records come back as one or more quoted chunks; join them. */
const txtValue = (data: string): string => {
  const chunks = [...data.matchAll(QUOTED_CHUNK)].map(
    (match) => match.groups?.chunk ?? ""
  );

  return chunks.length > 0 ? chunks.join("") : data;
};

const lookupDmarc = async (
  domain: string,
  fetcher: typeof fetch
): Promise<string | null> => {
  const url = new URL(DOH_URL);
  url.searchParams.set("name", `_dmarc.${domain}`);
  url.searchParams.set("type", "TXT");

  const response = await fetcher(url, {
    headers: { accept: "application/dns-json" },
  });

  if (!response.ok) {
    throw new Error(`DNS lookup failed (${response.status})`);
  }

  const result = dohSchema.parse(await response.json());

  const record = (result.Answer ?? [])
    .filter((answer) => answer.type === TXT_RECORD)
    .map((answer) => txtValue(answer.data))
    .find((value) => value.toLowerCase().startsWith("v=dmarc1"));

  return record ?? null;
};

/** A subdomain without its own DMARC record inherits the parent's policy. */
const findDmarc = async (
  domain: string,
  fetcher: typeof fetch
): Promise<{ domain: string; record: string } | null> => {
  let labels = domain.split(".");

  while (labels.length >= MIN_DOMAIN_LABELS) {
    const candidate = labels.join(".");
    // oxlint-disable-next-line no-await-in-loop -- checked from the most specific domain up
    const record = await lookupDmarc(candidate, fetcher);

    if (record) {
      return { domain: candidate, record };
    }

    labels = labels.slice(1);
  }

  return null;
};

const accountChecks = (
  account: SesAccount,
  recipients: { count: number; label: string }
): Check[] => {
  const checks: Check[] = [
    account.productionAccessEnabled
      ? check("pass", "SES production access", "Approved")
      : check(
          "fail",
          "SES production access",
          "SES is in the sandbox, so it can only send to verified addresses. Request production access (setup does this) and wait for AWS to approve it."
        ),
    account.sendingEnabled
      ? check("pass", "SES sending", "Enabled")
      : check(
          "fail",
          "SES sending",
          "Sending is disabled for this SES account."
        ),
  ];

  if (account.enforcementStatus === "SHUTDOWN") {
    checks.push(
      check(
        "fail",
        "SES account health",
        "AWS has shut down sending for this account."
      )
    );
  } else if (account.enforcementStatus === "PROBATION") {
    checks.push(
      check(
        "warn",
        "SES account health",
        "AWS has this account on probation because of bounces or complaints. Keep the list clean."
      )
    );
  } else {
    checks.push(
      check(
        "pass",
        "SES account health",
        account.enforcementStatus ?? "Healthy"
      )
    );
  }

  // A negative quota means unlimited.
  const remaining =
    account.max24HourSend < 0
      ? Number.POSITIVE_INFINITY
      : account.max24HourSend - account.sentLast24Hours;

  checks.push(
    remaining >= recipients.count
      ? check(
          "pass",
          "Sending quota",
          `${Number.isFinite(remaining) ? remaining.toLocaleString("en-US") : "Unlimited"} left today, up to ${account.maxSendRate} per second`
        )
      : check(
          "fail",
          "Sending quota",
          `Only ${remaining.toLocaleString("en-US")} emails left in today's SES quota, but there are ${recipients.count.toLocaleString("en-US")} ${recipients.label}. Ask AWS to raise the quota, or wait for it to reset.`
        ),
    REQUIRED_EVENTS.every((reason) =>
      account.suppressedReasons.includes(reason)
    )
      ? check(
          "pass",
          "Suppression list",
          "SES suppresses bounced and complaining addresses account-wide"
        )
      : check(
          "warn",
          "Suppression list",
          "Turn on SES's account-level suppression list for bounces and complaints as a second line of defense."
        )
  );

  return checks;
};

const senderChecks = async (
  ses: SesClient,
  email: string
): Promise<Check[]> => {
  const domain = email.split("@").at(-1) ?? "";

  const identity =
    (await ses.getEmailIdentity(domain)) ?? (await ses.getEmailIdentity(email));

  if (!identity) {
    return [
      check(
        "fail",
        "Sender identity",
        `${domain} isn't set up in SES. Verify the domain (setup does this) before sending.`
      ),
    ];
  }

  const checks = [
    identity.verifiedForSending
      ? check(
          "pass",
          "Sender identity",
          `${domain} is verified (DKIM ${identity.dkimStatus ?? "unknown"})`
        )
      : check(
          "fail",
          "Sender identity",
          `${domain} isn't verified yet (DKIM ${identity.dkimStatus ?? "unknown"}). Check its DNS records.`
        ),
  ];

  if (identity.mailFromStatus === "SUCCESS") {
    checks.push(
      check(
        "pass",
        "Custom MAIL FROM",
        `${identity.mailFromDomain ?? "Set"} is verified`
      )
    );
  } else {
    checks.push(
      check(
        "warn",
        "Custom MAIL FROM",
        identity.mailFromDomain
          ? `${identity.mailFromDomain} is ${identity.mailFromStatus ?? "not verified"}. Until it's verified, SPF won't align with your domain.`
          : "No custom MAIL FROM domain, so SPF won't align with your domain. DMARC still passes through DKIM, but setting one helps deliverability."
      )
    );
  }

  return checks;
};

const dmarcCheck = async (
  email: string,
  fetcher: typeof fetch
): Promise<Check> => {
  const domain = email.split("@").at(-1) ?? "";

  try {
    const found = await findDmarc(domain, fetcher);

    return found
      ? check("pass", "DMARC", `${found.domain}: ${found.record}`)
      : check(
          "fail",
          "DMARC",
          `No DMARC record for ${domain}. Gmail, Yahoo and Outlook require one for bulk mail. Add a TXT record at _dmarc.${domain}: v=DMARC1; p=none`
        );
  } catch (error) {
    return check(
      "warn",
      "DMARC",
      `Couldn't look up DMARC for ${domain}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
};

const eventsChecks = async (
  config: Config,
  ses: SesClient
): Promise<Check[]> => {
  const name = config.sesConfigurationSet;

  if (!name) {
    return [
      check(
        "warn",
        "Bounce and complaint tracking",
        "No SES configuration set, so bounces and complaints won't reach Sendoff."
      ),
    ];
  }

  const destinations = await ses.getEventDestinations(name);

  if (destinations === null) {
    return [
      check(
        "fail",
        "Bounce and complaint tracking",
        `The SES configuration set "${name}" doesn't exist, and sends that name it will fail. Run setup.`
      ),
    ];
  }

  const ours = destinations.filter(
    (destination) =>
      destination.enabled &&
      destination.snsTopicArn !== undefined &&
      destination.snsTopicArn === config.sesEventsTopicArn
  );

  const wired = ours.some((destination) =>
    REQUIRED_EVENTS.every((type) => destination.eventTypes.includes(type))
  );

  if (!wired) {
    return [
      check(
        "warn",
        "Bounce and complaint tracking",
        `"${name}" doesn't send bounces and complaints to Sendoff's SNS topic, so bad addresses won't be suppressed here.`
      ),
    ];
  }

  const deliveries = ours.some((destination) =>
    destination.eventTypes.includes("DELIVERY")
  );

  return [
    check(
      "pass",
      "Bounce and complaint tracking",
      `"${name}" sends bounces and complaints to Sendoff`
    ),
    deliveries
      ? check(
          "pass",
          "Delivery reports",
          `"${name}" reports deliveries to Sendoff`
        )
      : check(
          "warn",
          "Delivery reports",
          `"${name}" doesn't report deliveries to Sendoff, so issue_stats can't count how many emails arrived. Run \`bun run setup\` again to turn them on.`
        ),
  ];
};

export const runDoctor = async ({
  config,
  db,
  fetcher = fetch,
  toSend,
}: {
  config: Config;
  db: Database;
  fetcher?: typeof fetch;
  /** When resuming a send: the recipients it still has to reach, which the quota must cover. */
  toSend?: number;
}): Promise<DoctorReport> => {
  const [settings, counts] = await Promise.all([
    getSettings(db),
    countSubscribers(db),
  ]);

  const ses = createSes(config);
  const checks: Check[] = [];
  let account: SesAccount | null = null;

  checks.push(
    settings
      ? check(
          "pass",
          "Settings",
          `${settings.name}, from ${settings.from.name} <${settings.from.email}>`
        )
      : check(
          "fail",
          "Settings",
          "There are no settings yet. Call update_settings."
        ),
    counts.active > 0
      ? check(
          "pass",
          "Subscribers",
          `${counts.active.toLocaleString("en-US")} active`
        )
      : check(
          "fail",
          "Subscribers",
          "There are no active subscribers to send to."
        )
  );

  if (settings) {
    checks.push(
      settings.address
        ? check("pass", "Postal address", settings.address)
        : check(
            "warn",
            "Postal address",
            "None set. US and Canadian law require one in commercial email (launches, promotions), so prepare_send checks each issue with AI and blocks any that read as commercial."
          )
    );
  }

  try {
    account = await ses.getAccount();
    checks.push(
      ...accountChecks(account, {
        count: toSend ?? counts.active,
        label: toSend === undefined ? "subscribers" : "recipients left to send",
      })
    );
  } catch (error) {
    checks.push(
      check(
        "fail",
        "SES account",
        `Couldn't reach SES: ${(error instanceof Error ? error.message : String(error)).replace(TRAILING_PERIOD, "")}. Check the AWS keys and region.`
      )
    );
  }

  if (account && settings) {
    const [sender, dmarc, events] = await Promise.all([
      senderChecks(ses, settings.from.email).catch((error: Error) => [
        check(
          "fail",
          "Sender identity",
          `Couldn't check SES: ${error.message}`
        ),
      ]),
      dmarcCheck(settings.from.email, fetcher),
      eventsChecks(config, ses).catch((error: Error) => [
        check(
          "warn",
          "Bounce and complaint tracking",
          `Couldn't check: ${error.message}`
        ),
      ]),
    ]);

    checks.push(...sender, dmarc, ...events);
  }

  return {
    account,
    activeSubscribers: counts.active,
    checks,
    ok: checks.every((item) => item.status !== "fail"),
    settings,
  };
};

const ICONS: Record<CheckStatus, string> = { fail: "✗", pass: "✓", warn: "!" };

export const formatChecks = (checks: Check[]): string =>
  checks
    .map((item) => `${ICONS[item.status]} ${item.name}: ${item.detail}`)
    .join("\n");
