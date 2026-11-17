// `bun run setup`: connect Sendoff to your Cloudflare and AWS accounts and
// deploy it. Every step checks what already exists, so it's safe to re-run.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
  password,
  select,
  spinner,
  text,
} from "@clack/prompts";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import { parseJsonWith } from "../src/json";
import type { JsonObject } from "../src/json";
import {
  IAM_POLICY,
  accountIdFromTopicArn,
  createAwsSetup,
  topicPolicy,
  AwsError,
} from "./setup/aws";
import type { AwsCredentials, AwsSetup } from "./setup/aws";
import {
  MAX_KEYS_PER_USER,
  RUNTIME_USER,
  cliCredentials,
  cliIdentity,
  createRuntimeKey,
  deleteRuntimeKey,
  describeRuntimeKey,
  ensureRuntimeUser,
  runtimeKeyIds,
} from "./setup/aws-cli";
import {
  createCloudflareApi,
  senderZone,
  zoneOnCloudflare,
} from "./setup/cloudflare";
import type { CloudflareApi, Confirm, ZoneLookup } from "./setup/cloudflare";
import { deploy } from "./setup/deploy";
import type { Secrets } from "./setup/deploy";
import { formatRecords, mailFromDomainFor, sesDnsRecords } from "./setup/dns";
import type { DnsRecord } from "./setup/dns";
import {
  INSTANCE_DIR,
  readInstanceDraft,
  writeInstanceDraft,
} from "./setup/files";
import type { InstanceDraft } from "./setup/files";
import {
  PAGES_BRANCH,
  PAGES_PROJECT,
  pagesCnameRecord,
  pagesSubdomain,
} from "./setup/pages";
import { wrangler, wranglerJson } from "./setup/wrangler";

const WORKER_NAME = "sendoff";
const DATABASE_NAME = "sendoff";
const QUEUE_NAME = "sendoff-send";
const KV_NAMESPACE = "sendoff-oauth";
const CONFIGURATION_SET = "sendoff";
const TOPIC_NAME = "sendoff-events";
const SECRET_BYTES = 32;
const HEX = 16;
const POLL_MS = 5000;
const POLL_ATTEMPTS = 24;

/** Certificates for a new custom domain can take a few minutes. */
const REACHABLE_ATTEMPTS = 60;

/** example.com: DMARC lookups stop before a bare TLD. */
const MIN_DOMAIN_LABELS = 2;

const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-2",
  "eu-west-1",
  "eu-central-1",
  "ap-southeast-2",
];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const HOSTNAME = /^(?:[a-z\d](?:[a-z\d-]*[a-z\d])?\.)+[a-z]{2,}$/u;

// --- Prompt helpers -------------------------------------------------------------

// The shell's code for Ctrl+C. Not 0, so `bun create sendoff` doesn't report
// a cancelled setup as finished.
const EXIT_CANCELLED = 130;

const CANCELLED =
  "Setup cancelled. Run it again any time; finished steps are kept.";

const cancelSetup = (): never => {
  cancel(CANCELLED);
  process.exit(EXIT_CANCELLED);
};

const exitCancelled = (code: number) => {
  if (code === 0) {
    process.exitCode = EXIT_CANCELLED;
  }
};

/**
 * clack's spinner handles Ctrl+C itself. For the key press it prints the
 * cancel message and exits with 0, without calling onCancel (that's only for
 * a signal), so an exit while a spinner is running gets the cancelled code.
 */
const progressSpinner = () => {
  const progress = spinner({
    cancelMessage: CANCELLED,
    onCancel: () => process.exit(EXIT_CANCELLED),
  });

  return {
    start: (message: string) => {
      process.on("exit", exitCancelled);
      progress.start(message);
    },
    stop: (message: string) => {
      process.off("exit", exitCancelled);
      progress.stop(message);
    },
  };
};

const answer = <T>(value: T): Exclude<T, symbol> => {
  if (isCancel(value)) {
    cancelSetup();
  }

  // SAFETY: isCancel is true for the only symbol a clack prompt returns.
  return value as Exclude<T, symbol>;
};

const askYesNo: Confirm = async (message) => answer(await confirm({ message }));

const ask = async (
  message: string,
  options: {
    initial?: string | undefined;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  } = {}
) =>
  answer(
    await text({
      initialValue: options.initial ?? "",
      message,
      placeholder: options.placeholder ?? "",
      validate: (value) => options.validate?.(value ?? ""),
    })
  ).trim();

const required = (label: string) => (value: string) =>
  value.trim() ? undefined : `${label} is required.`;

const validEmail = (value: string) =>
  EMAIL.test(value.trim()) ? undefined : "Enter a valid email address.";

const randomSecret = () =>
  [...crypto.getRandomValues(new Uint8Array(SECRET_BYTES))]
    .map((byte) => byte.toString(HEX).padStart(2, "0"))
    .join("");

const fail = (message: string): never => {
  log.error(message);
  process.exit(1);
};

// --- Steps --------------------------------------------------------------------------

interface Newsletter {
  address?: string | undefined;
  fromEmail: string;
  fromName: string;
  name: string;
  replyTo?: string | undefined;
  /** Where people sign up today; shown to AWS when requesting production access. */
  website: string;
}

interface AwsAccess {
  /** Signs setup's own SES and SNS calls. */
  provisioning: AwsCredentials;
  /** A new key for the Worker to upload; undefined keeps the one it already has. */
  runtime?: { accessKeyId: string; secretAccessKey: string } | undefined;
  /** The Worker key's ID when setup created it, so re-runs can reuse it. */
  runtimeKeyId?: string | undefined;
}

const cloudflareAccount = async (draft: InstanceDraft) => {
  let whoami = wranglerJson<{
    accounts?: { id: string; name: string }[];
    email?: string;
  }>(["whoami"]);

  if (!whoami) {
    log.step("Log in to Cloudflare in the browser window that opens.");
    wrangler(["login"], { interactive: true });
    whoami = wranglerJson(["whoami"]);
  }

  const accounts = whoami?.accounts ?? [];

  if (accounts.length === 0) {
    return fail(
      "Couldn't find a Cloudflare account. Run `bunx wrangler login` and try again."
    );
  }

  const accountId =
    accounts.length === 1
      ? (accounts[0]?.id ?? "")
      : answer(
          await select<string>({
            initialValue: draft.accountId ?? accounts[0]?.id ?? "",
            message: "Which Cloudflare account?",
            options: accounts.map((account) => ({
              label: account.name,
              value: account.id,
            })),
          })
        );

  const paid = answer(
    await confirm({
      message:
        "Sendoff needs the Workers Paid plan ($5/month): rendering an email can take more CPU than the free plan allows. Is this account on it?",
    })
  );

  if (!paid) {
    fail(
      "Upgrade at https://dash.cloudflare.com/?to=/:account/workers/plans, then run setup again."
    );
  }

  return accountId;
};

const newsletterDetails = async (
  previous?: Newsletter
): Promise<Newsletter> => {
  note(
    "These go in every email's header and footer. Change them later by asking your agent.",
    "Your list"
  );

  const name = await ask("Name (a newsletter or brand name)", {
    initial: previous?.name,
    placeholder: "The Weekly Thing",
    validate: required("A name"),
  });

  const fromName = await ask("Sender name", {
    initial: previous?.fromName,
    placeholder: "Jane Doe",
    validate: required("A sender name"),
  });

  const senderEmail = await ask("Sender email (its domain must be yours)", {
    initial: previous?.fromEmail,
    placeholder: "hello@example.com",
    validate: validEmail,
  });

  const fromEmail = senderEmail.toLowerCase();

  const replyTo = await ask("Reply-to address (optional)", {
    initial: previous?.replyTo,
    placeholder: "Leave empty to use the sender",
    validate: (value) => (value.trim() === "" ? undefined : validEmail(value)),
  });

  const address = await ask(
    "Postal address for the footer (optional; commercial email, like launches, needs one)",
    {
      initial: previous?.address,
      placeholder: "A street address, PO box or private mailbox",
    }
  );

  const website = await ask("Your website (where people sign up today)", {
    initial: previous?.website ?? `https://${fromEmail.split("@")[1] ?? ""}`,
    validate: (value) =>
      URL.canParse(value.trim())
        ? undefined
        : "Enter a URL like https://example.com.",
  });

  return {
    address: address.trim() || undefined,
    fromEmail,
    fromName,
    name,
    replyTo: replyTo || undefined,
    website,
  };
};

const manualAwsKeys = async (region: string): Promise<AwsCredentials> => {
  const policyFile = path.join(INSTANCE_DIR, "iam-policy.json");

  writeFileSync(policyFile, `${JSON.stringify(IAM_POLICY, null, 2)}\n`);
  note(
    [
      "Create an IAM user for Sendoff in the AWS console, attach this policy, and create an access key:",
      policyFile,
      "",
      "It allows SES and Sendoff's own SNS topics, nothing else. The keys are stored as Worker secrets.",
    ].join("\n"),
    "AWS access"
  );

  const accessKeyId = await ask("AWS access key ID", {
    validate: required("The access key ID"),
  });

  const secretAccessKey = answer(
    await password({
      message: "AWS secret access key",
      validate: (value) => required("The secret")(value ?? ""),
    })
  ).trim();

  return { accessKeyId, region, secretAccessKey };
};

/**
 * Once the Worker has a new key, list the IAM user's other keys rather than
 * delete them: one may belong to another Sendoff instance in the same AWS
 * account. Left there, a stale one blocks the next new key.
 */
const warnAboutOldKeys = ({ runtime, runtimeKeyId }: AwsAccess): void => {
  // Only when this run gave the Worker a key of the sendoff user's.
  if (!runtime || !runtimeKeyId) {
    return;
  }

  let others: string[];

  try {
    others = runtimeKeyIds().filter((key) => key !== runtimeKeyId);
  } catch {
    return;
  }

  if (others.length > 0) {
    log.warn(
      [
        `The Worker has a new AWS key. The ${RUNTIME_USER} IAM user still has:`,
        ...others.map((key) => `  ${describeRuntimeKey(key)}`),
        `If no other Sendoff instance in this AWS account uses it, delete it (IAM console › Users › ${RUNTIME_USER} › Security credentials). IAM allows ${MAX_KEYS_PER_USER} keys per user, so a leftover one blocks the next new key.`,
      ].join("\n")
    );
  }
};

/**
 * Prefer the AWS CLI's login: setup provisions with it, and the Worker gets a
 * send-only key for a dedicated IAM user. Otherwise ask for keys by hand.
 */
const awsAccess = async (
  region: string,
  draft: InstanceDraft,
  workerSecrets: Set<string>
): Promise<AwsAccess> => {
  const identity = cliIdentity();
  const credentials = identity ? cliCredentials(region) : null;

  if (identity && credentials) {
    const useCli = answer(
      await confirm({
        message: `Use your AWS CLI login (${identity.Arn}) for setup, and create a send-only IAM user "sendoff" for the Worker?`,
      })
    );

    if (useCli) {
      if (identity.Arn.endsWith(":root")) {
        log.warn(
          "The AWS CLI is logged in as the root user. That works for setup, but AWS recommends an IAM Identity Center user for everyday use."
        );
      }

      try {
        ensureRuntimeUser();
        const listed = runtimeKeyIds();

        // A key from a run that stopped before its deploy: the secret never
        // reached the Worker, and can't be recovered.
        const abandoned = draft.pendingAwsAccessKeyId;

        if (abandoned && listed.includes(abandoned)) {
          deleteRuntimeKey(abandoned);
        }

        const keys = listed.filter((key) => key !== abandoned);

        const known =
          draft.awsAccessKeyId !== undefined &&
          keys.includes(draft.awsAccessKeyId);

        const workerHasKey =
          workerSecrets.has("AWS_ACCESS_KEY_ID") &&
          workerSecrets.has("AWS_SECRET_ACCESS_KEY");

        if (known && workerHasKey) {
          return {
            provisioning: credentials,
            runtimeKeyId: draft.awsAccessKeyId,
          };
        }

        // A key from an earlier run whose secret never reached the Worker can't be recovered.
        if (known && draft.awsAccessKeyId) {
          deleteRuntimeKey(draft.awsAccessKeyId);
        }

        const others = keys.filter((key) => key !== draft.awsAccessKeyId);

        // Without instance.json, setup can't tell which key this Worker uses,
        // or whether another Sendoff instance in the account uses the other.
        if (others.length >= MAX_KEYS_PER_USER) {
          return fail(
            [
              `The ${RUNTIME_USER} IAM user already has ${MAX_KEYS_PER_USER} access keys, IAM's limit, so setup can't make one for the Worker:`,
              ...others.map((key) => `  ${describeRuntimeKey(key)}`),
              `Delete one that no Sendoff instance uses (IAM console › Users › ${RUNTIME_USER} › Security credentials), then run setup again.`,
            ].join("\n")
          );
        }

        const runtime = createRuntimeKey();

        return {
          provisioning: credentials,
          runtime,
          runtimeKeyId: runtime.accessKeyId,
        };
      } catch (error) {
        return fail(
          `Setting up the sendoff IAM user failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  }

  const manual = await manualAwsKeys(region);

  return {
    provisioning: manual,
    runtime: {
      accessKeyId: manual.accessKeyId,
      secretAccessKey: manual.secretAccessKey,
    },
  };
};

/** The sendoff user's key this run made for the Worker, if it made one. */
const createdKeyId = (access: AwsAccess): string | undefined =>
  access.runtime ? access.runtimeKeyId : undefined;

const workerSecretsSchema = z.array(z.object({ name: z.string() }));

/**
 * The Worker's secret names, or none before its first deploy. Any other
 * failure stops setup: guessing "none" would rotate TOKEN_SECRET, breaking
 * the unsubscribe links in every email already sent, and replace the MCP
 * token and AWS key the Worker is using.
 */
const workerSecretNames = (): Set<string> => {
  // `secret list` prints JSON by default and rejects a --json flag.
  const listed = wrangler(["secret", "list", "--name", WORKER_NAME]);

  if (!listed.ok) {
    if (listed.output.includes(`Worker "${WORKER_NAME}" not found`)) {
      return new Set();
    }

    return fail(
      `Couldn't list the Worker's secrets, so setup can't tell which to keep:\n${listed.output}`
    );
  }

  const parsed = parseJsonWith(
    workerSecretsSchema,
    listed.stdout.slice(Math.max(0, listed.stdout.indexOf("[")))
  );

  return parsed.success
    ? new Set(parsed.data.map((secret) => secret.name))
    : fail(
        `Couldn't read the Worker's secrets from Wrangler:\n${listed.output}`
      );
};

/**
 * `zone` is the sender's domain's zone when the token should add SES's
 * records to it, and its DNS permissions are for that zone, which can differ
 * from Sendoff's hostname's. Null when there are no records to add or that
 * domain isn't on Cloudflare, so the token is only for Turnstile.
 */
const cloudflareToken = async (
  zone: string | null,
  domain: string
): Promise<CloudflareApi | null> => {
  // Token permissions name zones, so a sender on mail.example.com needs example.com.
  const which =
    zone === domain
      ? "your sender's domain"
      : `the zone your sender's domain, ${domain}, is in`;

  note(
    (zone
      ? [
          `With an API token, setup adds SES's DNS records to ${zone} and creates the Turnstile widget for the signup page.`,
          "Create one at https://dash.cloudflare.com/profile/api-tokens with:",
          `  Zone > DNS > Edit, Zone > Zone > Read (for ${zone}, ${which})`,
          "  Account > Turnstile > Edit",
          "It's only used now and isn't stored. Leave it empty to do those steps by hand.",
        ]
      : [
          "With an API token, setup creates the Turnstile widget for the signup page.",
          "Create one at https://dash.cloudflare.com/profile/api-tokens with:",
          "  Account > Turnstile > Edit",
          "It's only used now and isn't stored. Leave it empty to make the widget by hand.",
        ]
    ).join("\n"),
    "Cloudflare API token (optional)"
  );

  const token = answer(
    await password({ message: "Cloudflare API token" })
  ).trim();

  if (!token) {
    return null;
  }

  const api = createCloudflareApi(token);

  try {
    await api.verifyToken();

    return api;
  } catch (error) {
    log.warn(
      `That token didn't work (${error instanceof Error ? error.message : String(error)}). Continuing without it.`
    );

    return null;
  }
};

/**
 * Cloudflare's API with Wrangler's own login, so setup can find zones and add
 * a Pages custom domain without asking for more token permissions. Null when
 * Wrangler is logged in some way that has no bearer token.
 */
const wranglerApi = (): CloudflareApi | null => {
  const auth = wranglerJson<{ token?: string }>(["auth", "token"]);

  return auth?.token ? createCloudflareApi(auth.token) : null;
};

/**
 * Whether the hostname's DNS is an active zone in this account, which a
 * Workers Custom Domain needs. If not, a Pages project serves it instead.
 * `zone` is what the lookup found, which can answer for the sender's domain.
 */
const hostnameOnCloudflare = async (
  api: CloudflareApi | null,
  accountId: string,
  hostname: string
): Promise<{ active: boolean; zone: ZoneLookup }> => {
  const lookup = await zoneOnCloudflare({
    accountId,
    api,
    confirm: askYesNo,
    domain: hostname,
  });

  if (lookup.active) {
    return lookup;
  }

  const { zone } = lookup;

  const pending =
    zone !== "unknown" && zone && zone.status !== "active"
      ? ` (${zone.name} is on Cloudflare but isn't active yet)`
      : "";

  note(
    [
      `${hostname}'s DNS isn't on Cloudflare${pending}, so the Worker can't serve it directly.`,
      `Setup puts a small Cloudflare Pages project in front of it instead, and you'll add one CNAME record for ${hostname} at your DNS provider.`,
    ].join("\n"),
    "Hostname"
  );

  return lookup;
};

const pagesProjectsSchema = z.array(
  z.object({ "Project Domains": z.string(), "Project Name": z.string() })
);

/** Create the Pages project (if it's new) and return its `*.pages.dev` hostname. */
const ensurePagesProject = (accountId: string): string => {
  const find = () => {
    const parsed = pagesProjectsSchema.safeParse(
      wranglerJson(["pages", "project", "list"], { accountId })
    );

    return parsed.success
      ? pagesSubdomain(parsed.data, PAGES_PROJECT)
      : undefined;
  };

  const existing = find();

  if (existing) {
    return existing;
  }

  const created = wrangler(
    [
      "pages",
      "project",
      "create",
      PAGES_PROJECT,
      "--production-branch",
      PAGES_BRANCH,
    ],
    { accountId }
  );

  if (!created.ok) {
    return fail(`Creating the Pages project failed:\n${created.output}`);
  }

  return (
    find() ?? fail("Created the Pages project but couldn't find its domain.")
  );
};

const ensureDatabase = (): string => {
  const find = () =>
    wranglerJson<{ name: string; uuid: string }[]>(["d1", "list"])?.find(
      (database) => database.name === DATABASE_NAME
    )?.uuid;

  const existing = find();

  if (existing) {
    return existing;
  }

  const created = wrangler(["d1", "create", DATABASE_NAME]);

  if (!created.ok) {
    return fail(`Creating the D1 database failed:\n${created.output}`);
  }

  return find() ?? fail("Created the D1 database but couldn't find its ID.");
};

const kvNamespacesSchema = z.array(
  z.object({ id: z.string(), title: z.string() })
);

const ensureKvNamespace = (): string => {
  const find = () => {
    const listed = wrangler(["kv", "namespace", "list"]);

    const parsed = parseJsonWith(
      kvNamespacesSchema,
      listed.stdout.slice(Math.max(0, listed.stdout.indexOf("[")))
    );

    return parsed.success
      ? parsed.data.find((namespace) => namespace.title === KV_NAMESPACE)?.id
      : undefined;
  };

  const existing = find();

  if (existing) {
    return existing;
  }

  const created = wrangler(["kv", "namespace", "create", KV_NAMESPACE]);

  if (!created.ok) {
    return fail(`Creating the KV namespace failed:\n${created.output}`);
  }

  return find() ?? fail("Created the KV namespace but couldn't find its ID.");
};

const ensureQueue = () => {
  const created = wrangler(["queues", "create", QUEUE_NAME]);

  if (!created.ok && !created.output.toLowerCase().includes("already")) {
    fail(`Creating the queue failed:\n${created.output}`);
  }
};

const turnstileKeys = async (
  cloudflare: CloudflareApi | null,
  accountId: string,
  hostname: string,
  existingSiteKey: string | undefined
) => {
  if (cloudflare) {
    const widget = existingSiteKey
      ? await cloudflare
          .getTurnstileWidget(accountId, existingSiteKey)
          .catch(() => null)
      : null;

    return (
      widget ??
      (await cloudflare.createTurnstileWidget(accountId, "Sendoff signup", [
        hostname,
      ]))
    );
  }

  note(
    `Create a Turnstile widget for ${hostname} at https://dash.cloudflare.com/?to=/:account/turnstile and paste its keys.`,
    "Turnstile (protects the signup page from bots)"
  );

  const sitekey = await ask("Turnstile site key", {
    initial: existingSiteKey,
    validate: required("The site key"),
  });

  const secret = answer(
    await password({
      message: "Turnstile secret key",
      validate: (value) => required("The secret")(value ?? ""),
    })
  ).trim();

  return { secret, sitekey };
};

const configureSes = async (aws: AwsSetup, domain: string, region: string) => {
  const identity = await aws.ensureDomainIdentity(domain);
  const mailFromDomain = mailFromDomainFor(domain);

  if (identity.mailFromDomain !== mailFromDomain) {
    await aws.setMailFromDomain(domain, mailFromDomain);
  }

  await aws.ensureConfigurationSet(CONFIGURATION_SET);
  const topicArn = await aws.ensureTopic(TOPIC_NAME);

  await aws.setTopicPolicy(
    topicArn,
    topicPolicy({
      accountId: accountIdFromTopicArn(topicArn),
      configurationSet: CONFIGURATION_SET,
      region,
      topicArn,
    })
  );
  await aws.ensureEventDestination(CONFIGURATION_SET, topicArn);
  await aws.enableSuppressionList();

  return { identity, mailFromDomain, topicArn };
};

/** A public DNS answer, as lowercase JSON text. */
const lookup = async (name: string, type: "CNAME" | "TXT"): Promise<string> => {
  const response = await fetch(
    `https://cloudflare-dns.com/dns-query?name=${name}&type=${type}`,
    {
      headers: { accept: "application/dns-json" },
    }
  );

  const body = await response.text();

  return body.toLowerCase();
};

/**
 * DMARC on the domain or a parent, from the most specific up (as doctor
 * checks it): mail from a subdomain falls back to its parent's policy, and a
 * new `p=none` record on the subdomain would weaken a stricter parent's.
 */
const hasDmarc = async (domain: string): Promise<boolean> => {
  const labels = domain.split(".");

  for (let start = 0; labels.length - start >= MIN_DOMAIN_LABELS; start += 1) {
    // oxlint-disable-next-line no-await-in-loop -- most specific first, and usually one lookup
    const records = await lookup(
      `_dmarc.${labels.slice(start).join(".")}`,
      "TXT"
    );

    if (records.includes("v=dmarc1")) {
      return true;
    }
  }

  return false;
};

const hasCname = async (hostname: string, target: string): Promise<boolean> => {
  const records = await lookup(hostname, "CNAME");

  return records.includes(target.toLowerCase());
};

const addRecordsByHand = async (records: DnsRecord[]): Promise<void> => {
  note(formatRecords(records), "Add these DNS records at your DNS provider");
  answer(
    await confirm({
      message: "Added them? (Setup checks they've verified at the end.)",
    })
  );
};

/**
 * The zone the API token adds `domain`'s records to: an active one in
 * `accountId`, since records in a zone that isn't serving DNS do nothing.
 * When it can't find one, it says why, since setup then lists the records to
 * add by hand. `zone` is the zone setup expects, to name in the warning.
 */
const tokenZone = async ({
  accountId,
  cloudflare,
  domain,
  zone,
}: {
  accountId: string;
  cloudflare: CloudflareApi;
  domain: string;
  zone: string;
}) => {
  const permissions = `Give the token Zone > DNS > Edit and Zone > Zone > Read for ${zone}, so setup can add them next time.`;

  try {
    const found = await cloudflare.findZone(domain, accountId);

    if (found?.status === "active") {
      return found;
    }

    log.warn(
      found
        ? `${found.name} is on Cloudflare but isn't active yet, so setup lists ${domain}'s records to add where its DNS is now.`
        : `Your Cloudflare API token can't see a zone for ${domain} in this account, so setup lists its records to add by hand. ${permissions}`
    );

    return null;
  } catch (error) {
    log.warn(
      `Couldn't look up ${domain}'s zone with your Cloudflare API token (${error instanceof Error ? error.message : String(error)}), so setup lists its records to add by hand. ${permissions}`
    );

    return null;
  }
};

/**
 * Add the SES records through the API token when the domain's zone is on
 * Cloudflare, or list them to add by hand. `byHand` records (the Pages CNAME,
 * on DNS that isn't Cloudflare's) are always listed.
 */
const configureDns = async ({
  accountId,
  byHand,
  cloudflare,
  domain,
  records,
  senderZoneName,
}: {
  accountId: string;
  byHand: DnsRecord[];
  cloudflare: CloudflareApi | null;
  domain: string;
  records: DnsRecord[];
  /** The zone setup expects `domain` in, from Wrangler's login or the person. */
  senderZoneName: string;
}) => {
  const zone =
    cloudflare && records.length > 0
      ? await tokenZone({
          accountId,
          cloudflare,
          domain,
          zone: senderZoneName,
        })
      : null;

  if (!(cloudflare && zone)) {
    await addRecordsByHand([...records, ...byHand]);

    return;
  }

  const outcomes = [];
  const refused: DnsRecord[] = [];
  const reasons = new Set<string>();

  for (const record of records) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a handful of records, in order
      const outcome = await cloudflare.ensureDnsRecord(zone.id, record);

      outcomes.push({ outcome, record });
    } catch (error) {
      // Cloudflare turns a record down when the token can't edit DNS, or when
      // the name already has a record of another type (a CNAME left by
      // another email provider, say). The rest still go in.
      refused.push(record);
      reasons.add(error instanceof Error ? error.message : String(error));
    }
  }

  const conflicts = outcomes.flatMap((item) =>
    item.outcome === "conflict" ? [item.record] : []
  );

  log.success(
    `DNS: ${outcomes.filter((item) => item.outcome === "created").length} records added, ${outcomes.filter((item) => item.outcome === "exists").length} already there.`
  );

  if (conflicts.length > 0) {
    note(
      formatRecords(conflicts),
      "These clash with existing records. Fix them by hand"
    );
  }

  if (refused.length > 0) {
    note(
      `${formatRecords(refused)}\n\nCloudflare said: ${[...reasons].join("; ")}`,
      "Cloudflare wouldn't add these. Add them by hand"
    );
  }

  if (byHand.length > 0) {
    await addRecordsByHand(byHand);
  }
};

/** Point the hostname at the Pages project. Its certificate follows once the CNAME resolves. */
const attachPagesDomain = async (
  api: CloudflareApi | null,
  accountId: string,
  hostname: string
): Promise<void> => {
  if (api) {
    try {
      const status = await api.ensurePagesDomain(
        accountId,
        PAGES_PROJECT,
        hostname
      );

      log.success(
        `Pages: ${hostname} is the project's custom domain${status ? ` (${status})` : ""}.`
      );

      return;
    } catch (error) {
      log.warn(
        `Couldn't add ${hostname} to the Pages project (${error instanceof Error ? error.message : String(error)}).`
      );
    }
  }

  note(
    [
      `In the Cloudflare dashboard, open Workers & Pages, then the "${PAGES_PROJECT}" Pages project, then Custom domains, and add ${hostname}:`,
      `https://dash.cloudflare.com/${accountId}/workers-and-pages`,
    ].join("\n"),
    "Add your hostname to the Pages project"
  );
  answer(await confirm({ message: "Added it?" }));
};

const waitFor = async (
  label: string,
  check: () => Promise<boolean>,
  attempts = POLL_ATTEMPTS
): Promise<boolean> => {
  const progress = progressSpinner();

  progress.start(label);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    // oxlint-disable-next-line no-await-in-loop -- polling
    if (await check().catch(() => false)) {
      progress.stop(`${label}: done`);

      return true;
    }

    // oxlint-disable-next-line no-await-in-loop -- polling
    await wait(POLL_MS);
  }

  progress.stop(
    `${label}: not yet (it can take a while; run setup again later)`
  );

  return false;
};

/** A brand-new custom domain needs a minute for its certificate before SNS can reach it. */
const waitUntilReachable = async (publicUrl: string): Promise<boolean> =>
  await waitFor(
    `Waiting for ${publicUrl} to come online`,
    async () => {
      const response = await fetch(`${publicUrl}/health`);

      return response.ok;
    },
    REACHABLE_ATTEMPTS
  );

const UNREACHABLE = "Unreachable Endpoint";
const SUBSCRIBE_ATTEMPTS = 6;

const subscribeWebhook = async (
  aws: AwsSetup,
  topicArn: string,
  webhook: string
): Promise<void> => {
  for (let attempt = 1; attempt <= SUBSCRIBE_ATTEMPTS; attempt += 1) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- retried until the endpoint is reachable
      await aws.subscribeHttps(topicArn, webhook);

      return;
    } catch (error) {
      if (
        !(error instanceof AwsError && error.message.includes(UNREACHABLE)) ||
        attempt === SUBSCRIBE_ATTEMPTS
      ) {
        throw error;
      }

      // oxlint-disable-next-line no-await-in-loop -- see above
      await wait(POLL_MS);
    }
  }
};

/**
 * The MCP token can't be read back from the Worker. If one exists, keep it
 * (the person has it saved) or replace it; rotating it is harmless.
 */
const chooseMcpToken = async (
  workerSecrets: Set<string>
): Promise<{ created: boolean; token: string | undefined }> => {
  if (!workerSecrets.has("MCP_TOKEN")) {
    return { created: true, token: randomSecret() };
  }

  const choice = answer(
    await select({
      message: "Sendoff already has an MCP token. Do you have it saved?",
      options: [
        { label: "Yes, keep it", value: "keep" },
        {
          label:
            "No, create a new one (connected agents will need the new token)",
          value: "new",
        },
      ],
    })
  );

  if (choice === "new") {
    return { created: true, token: randomSecret() };
  }

  const saved = answer(
    await password({
      message:
        "Paste it to finish setup, or leave empty to skip the steps that need it",
    })
  ).trim();

  return { created: false, token: saved || undefined };
};

const showMcpToken = (publicUrl: string, token: string): void => {
  note(
    [
      "Connect your agent with this token. It's shown once, so save it now:",
      "",
      token,
      "",
      "Claude Code:",
      `  claude mcp add --scope user --transport http sendoff ${publicUrl}/mcp --header "Authorization: Bearer ${token}"`,
      "  (--scope user makes Sendoff available from any folder, not just this one.)",
      "",
      "Codex: add a custom MCP server, type Streamable HTTP,",
      `  URL ${publicUrl}/mcp. Under Headers, add Authorization with the value:`,
      `  Bearer ${token}`,
      '  Leave "Bearer token env var" empty: it takes a variable name, not the token.',
      "",
      "claude.ai and Claude Desktop: Settings → Connectors → Add custom connector,",
      `  URL ${publicUrl}/mcp. When it asks you to sign in, paste this token.`,
    ].join("\n"),
    "Your MCP token"
  );
};

const mcpClient = async (publicUrl: string, token: string) => {
  const client = new Client({ name: "sendoff-setup", version: "1.0.0" });

  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${publicUrl}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );

  return client;
};

/** How get_settings starts its answer when nothing is configured yet. */
const SETTINGS_NOT_SET_UP = "Sendoff isn't set up yet";

/** What the public pages say until there are settings. */
const LIST_NOT_SET_UP = "This list isn't set up yet.";

const currentSenderSchema = z.object({
  from: z.object({ email: z.string() }),
});

const toolText = (result: Awaited<ReturnType<Client["callTool"]>>): string =>
  (Array.isArray(result.content) ? result.content : [])
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");

const requestProductionAccess = async (
  aws: AwsSetup,
  newsletter: Newsletter
) => {
  const account = await aws.getAccount();

  if (account.productionAccessEnabled) {
    log.success("SES production access: approved.");

    return;
  }

  if (account.reviewStatus === "PENDING") {
    log.info("SES production access: AWS is still reviewing the request.");

    return;
  }

  const useCase = [
    `${newsletter.name} is an opt-in email list run by ${newsletter.fromName}: a newsletter and occasional announcements, sent a few times a year.`,
    "People subscribe through a double opt-in form, or were imported from a previous provider with unsubscribes preserved.",
    "Every email has a one-click unsubscribe (List-Unsubscribe and List-Unsubscribe-Post headers) and a visible unsubscribe link, honored immediately.",
    "Bounces and complaints are received through SES event publishing to SNS and suppressed automatically, and the account-level suppression list is enabled.",
    `People sign up at ${newsletter.website}.`,
  ].join(" ");

  note(useCase, "Request SES production access with this description");

  const go = answer(
    await confirm({
      message:
        "Submit it to AWS? Approval usually takes a day or so, and AWS may ask follow-up questions by email.",
    })
  );

  if (go) {
    await aws.requestProductionAccess({
      contactEmail: newsletter.replyTo ?? newsletter.fromEmail,
      useCase,
      websiteUrl: newsletter.website,
    });
    log.success("Requested SES production access.");
  }
};

/**
 * After deploy: wire up SES events, save settings, request production access,
 * run doctor. Returns whether it got to check the settings: without an MCP
 * token it can't, so setup doesn't call Sendoff live. If it couldn't read or
 * save them, it stops there instead, since the public pages need them.
 */
const finishSetup = async ({
  aws,
  domain,
  newsletter,
  publicUrl,
  token,
  topicArn,
}: {
  aws: AwsSetup;
  domain: string;
  newsletter: Newsletter;
  publicUrl: string;
  token: string | undefined;
  topicArn: string;
}): Promise<boolean> => {
  const webhook = `${publicUrl}/webhooks/ses`;

  if ((await aws.subscriptionState(topicArn, webhook)) !== "confirmed") {
    await waitUntilReachable(publicUrl);
    await subscribeWebhook(aws, topicArn, webhook);
  }

  await waitFor(
    "Confirming the SNS subscription",
    async () => (await aws.subscriptionState(topicArn, webhook)) === "confirmed"
  );

  await waitFor("Waiting for SES to verify your domain", async () => {
    const identity = await aws.ensureDomainIdentity(domain);

    return identity.verified;
  });

  await requestProductionAccess(aws, newsletter);

  if (!token) {
    log.warn(
      `Skipped saving your settings and the preflight checks (no MCP token). If Sendoff has no settings yet, its signup and unsubscribe pages say "${LIST_NOT_SET_UP}" until your agent saves them with update_settings.`
    );

    return false;
  }

  const client = await mcpClient(publicUrl, token);

  const settings: JsonObject = {
    from: { email: newsletter.fromEmail, name: newsletter.fromName },
    links: [{ label: "Website", url: newsletter.website }],
    name: newsletter.name,
  };

  if (newsletter.address) {
    settings.address = newsletter.address;
  }

  if (newsletter.replyTo) {
    settings.replyTo = newsletter.replyTo;
  }

  const currentResult = await client.callTool({
    arguments: {},
    name: "get_settings",
  });

  const current = toolText(currentResult);
  let problem: string | undefined;

  // Setup fills in the first settings only. After that they're the agent's
  // to change, and saving these answers again would undo its edits, such as
  // footer links (update_settings replaces the whole list).
  if (currentResult.isError) {
    // The MCP server makes any error in get_settings a tool error, a passing
    // D1 failure included, so this doesn't say whether settings exist.
    problem = `Sendoff is deployed to ${publicUrl}, but setup couldn't read its settings, so it didn't save yours:\n${current}\nIf Sendoff has none yet, its signup and unsubscribe pages say "${LIST_NOT_SET_UP}" until they're saved. Run \`bun run setup\` again to retry, or ask your agent to check them with get_settings.`;
  } else if (current.startsWith(SETTINGS_NOT_SET_UP)) {
    const saved = await client.callTool({
      arguments: settings,
      name: "update_settings",
    });

    if (saved.isError) {
      problem = `Sendoff is deployed to ${publicUrl}, but it isn't live yet: setup couldn't save your settings:\n${toolText(saved)}\nUntil they're saved, its signup and unsubscribe pages say "${LIST_NOT_SET_UP}" Run \`bun run setup\` again, or ask your agent to save them with update_settings.`;
    } else {
      log.success("Saved your settings.");
    }
  } else {
    const sender = parseJsonWith(
      currentSenderSchema,
      current.slice(Math.max(0, current.indexOf("{")))
    );

    log.info(
      sender.success && sender.data.from.email !== newsletter.fromEmail
        ? `Kept your current settings, which send from ${sender.data.from.email}. To send from ${newsletter.fromEmail} instead, ask your agent to change the sender.`
        : "Kept your current settings. Ask your agent to change them."
    );
  }

  const doctor = async () =>
    toolText(await client.callTool({ arguments: {}, name: "doctor" }));

  // Deployed, but its public pages may not work without settings: don't call
  // it live. Still show what else doctor finds, without letting a failure
  // there hide why.
  if (problem) {
    const checks = await doctor().catch(() => null);

    if (checks !== null) {
      note(checks, "Preflight checks");
    }

    return fail(problem);
  }

  note(await doctor(), "Preflight checks");
  await client.close();

  return true;
};

/**
 * Where Sendoff lives, and whether a Pages project has to front it. Once a
 * hostname is behind Pages it stays there: if its DNS moves to Cloudflare
 * later, the CNAME comes along, and a Custom Domain can't share it. Then
 * `hostnameZone` is undefined: this run didn't look the hostname up.
 */
const chooseHostname = async ({
  accountId,
  api,
  domain,
  draft,
}: {
  accountId: string;
  api: CloudflareApi | null;
  domain: string;
  draft: InstanceDraft;
}): Promise<{
  hostname: string;
  hostnameZone: ZoneLookup | undefined;
  usePages: boolean;
}> => {
  const hostnameAnswer = await ask(
    "Where should Sendoff live? (A subdomain of your domain, used for signup and unsubscribe links)",
    {
      initial: draft.hostname ?? `news.${domain}`,
      validate: (value) =>
        HOSTNAME.test(value.trim().toLowerCase())
          ? undefined
          : "Enter a hostname like news.example.com.",
    }
  );

  const hostname = hostnameAnswer.toLowerCase();

  if (draft.pagesProject !== undefined && draft.hostname === hostname) {
    return { hostname, hostnameZone: undefined, usePages: true };
  }

  const { active, zone } = await hostnameOnCloudflare(api, accountId, hostname);

  return { hostname, hostnameZone: zone, usePages: !active };
};

/**
 * What the DNS step has left: SES's records (`sesDone` once SES has verified
 * them and the domain has DMARC) and, behind Pages (`pagesDev`), the
 * hostname's CNAME.
 */
const dnsProgress = async ({
  domain,
  hostname,
  pagesDev,
  ses,
}: {
  domain: string;
  hostname: string;
  pagesDev: string | undefined;
  ses: Awaited<ReturnType<typeof configureSes>>;
}) => {
  const dmarc = await hasDmarc(domain).catch(() => false);

  const cnameDone =
    pagesDev === undefined ||
    (await hasCname(hostname, pagesDev).catch(() => false));

  return {
    cnameDone,
    dmarc,
    sesDone:
      ses.identity.verified &&
      ses.identity.mailFromStatus === "SUCCESS" &&
      dmarc,
  };
};

/**
 * SES's records, plus the hostname's CNAME when it's behind Pages (`pagesDev`).
 * `senderDnsZone` is the sender's domain's zone when the API token can add
 * SES's records to it, and null when they're done or must be added by hand.
 */
const configureAllDns = async ({
  accountId,
  cloudflareApi,
  domain,
  hostname,
  pagesDev,
  progress: { cnameDone, dmarc, sesDone },
  region,
  senderDnsZone,
  ses,
}: {
  accountId: string;
  cloudflareApi: () => Promise<CloudflareApi | null>;
  domain: string;
  hostname: string;
  pagesDev: string | undefined;
  progress: Awaited<ReturnType<typeof dnsProgress>>;
  region: string;
  senderDnsZone: () => Promise<string | null>;
  ses: Awaited<ReturnType<typeof configureSes>>;
}): Promise<void> => {
  if (sesDone) {
    log.success(`DNS: SES has verified ${domain}, and it has DMARC.`);
  }

  if (pagesDev && cnameDone) {
    log.success(`DNS: ${hostname} points to ${pagesDev}.`);
  }

  if (sesDone && cnameDone) {
    return;
  }

  // SES's records go in the sender's domain's zone, which can be on
  // Cloudflare even when the hostname's DNS (behind Pages) isn't.
  const zone = await senderDnsZone();

  await configureDns({
    accountId,
    byHand:
      pagesDev && !cnameDone ? [pagesCnameRecord(hostname, pagesDev)] : [],
    cloudflare: zone ? await cloudflareApi() : null,
    domain,
    records: sesDone
      ? []
      : sesDnsRecords({
          dkimTokens: ses.identity.dkimTokens,
          dmarc: !dmarc,
          domain,
          mailFromDomain: ses.mailFromDomain,
          region,
        }),
    senderZoneName: zone ?? domain,
  });
};

/**
 * The sender's domain's zone, when the API token should add SES's records to
 * it, and the token itself, each worked out at most once and only when a step
 * needs them. With SES's records in place (`sesRecords` false), it doesn't
 * look at the sender's domain, so the token is asked for only if Turnstile
 * needs it, and for Turnstile alone; a finished instance is asked neither.
 */
const lazyCloudflare = ({
  sesRecords,
  ...sender
}: Omit<Parameters<typeof senderZone>[0], "confirm"> & {
  sesRecords: boolean;
}) => {
  let zone: Promise<string | null> | undefined;
  let cloudflare: Promise<CloudflareApi | null> | undefined;

  const senderDnsZone = async (): Promise<string | null> => {
    zone ??= sesRecords
      ? senderZone({ ...sender, confirm: askYesNo })
      : Promise.resolve(null);

    return await zone;
  };

  const askForToken = async (): Promise<CloudflareApi | null> =>
    await cloudflareToken(await senderDnsZone(), sender.domain);

  const cloudflareApi = async (): Promise<CloudflareApi | null> => {
    cloudflare ??= askForToken();

    return await cloudflare;
  };

  return { cloudflareApi, senderDnsZone };
};

/** Setup's last line: Sendoff is only live once setup has checked its settings. */
const finished = (publicUrl: string, checked: boolean): string =>
  checked
    ? `Sendoff is live at ${publicUrl}. Ask your agent to draft your first issue.`
    : `Sendoff is deployed to ${publicUrl}. Ask your agent to run doctor, which checks its settings, then draft your first issue.`;

// --- Main ---------------------------------------------------------------------------

const main = async () => {
  const draft = readInstanceDraft();

  const save = (changes: InstanceDraft) => {
    Object.assign(draft, changes);
    writeInstanceDraft(draft);
  };

  intro("Sendoff setup");

  const accountId = await cloudflareAccount(draft);
  save({ accountId });

  // Every Wrangler command from here on uses the chosen account. With its
  // output piped, Wrangler can't ask, so with several accounts it would
  // refuse, or use the one it last cached.
  process.env.CLOUDFLARE_ACCOUNT_ID = accountId;

  const newsletter = await newsletterDetails(draft.newsletter);

  save({ newsletter });
  const domain = newsletter.fromEmail.split("@")[1] ?? "";

  const cloudflareLogin = wranglerApi();

  const { hostname, hostnameZone, usePages } = await chooseHostname({
    accountId,
    api: cloudflareLogin,
    domain,
    draft,
  });

  const publicUrl = `https://${hostname}`;
  save({
    hostname,
    pagesProject: usePages ? PAGES_PROJECT : undefined,
    publicUrl,
    workerName: WORKER_NAME,
  });

  const region = answer(
    await select({
      initialValue: draft.sesRegion ?? "us-east-1",
      message: "AWS region for SES",
      options: REGIONS.map((value) => ({ label: value, value })),
    })
  );

  const existingSecrets = workerSecretNames();
  const access = await awsAccess(region, draft, existingSecrets);

  // A new key isn't recorded as the Worker's until a deploy has given it the
  // secret. Recorded now, a run that stopped before deploying would leave the
  // next one to find the Worker's old AWS secrets, take them for this key's,
  // and never upload it.
  const newRuntimeKeyId = createdKeyId(access);

  save({ pendingAwsAccessKeyId: newRuntimeKeyId });

  const aws = createAwsSetup(access.provisioning);
  const progress = progressSpinner();

  progress.start("Checking AWS access");
  await aws
    .getAccount()
    .catch((error: Error) => fail(`AWS access didn't work: ${error.message}`));
  progress.stop("AWS access works");

  const resources = usePages
    ? "database, KV namespace, queue and Pages project"
    : "database, KV namespace and queue";

  progress.start(`Creating the ${resources}`);
  const databaseId = ensureDatabase();
  const kvNamespaceId = ensureKvNamespace();
  ensureQueue();

  // The hostname's CNAME target, e.g. sendoff-abc.pages.dev.
  const pagesDev = usePages ? ensurePagesProject(accountId) : undefined;
  save({
    databaseId,
    databaseName: DATABASE_NAME,
    kvNamespaceId,
    queueName: QUEUE_NAME,
  });
  progress.stop(`The ${resources} are ready`);

  // Before Turnstile, so the token prompt knows whether SES's records need it.
  progress.start("Setting up SES and SNS");
  const ses = await configureSes(aws, domain, region);
  save({
    sesConfigurationSet: CONFIGURATION_SET,
    sesEventsTopicArn: ses.topicArn,
    sesRegion: region,
  });
  progress.stop("SES identity, configuration set and event topic ready");

  const dns = await dnsProgress({ domain, hostname, pagesDev, ses });

  // Only check the sender's domain, or ask for a Cloudflare API token, if a
  // step below needs it.
  const { cloudflareApi, senderDnsZone } = lazyCloudflare({
    accountId,
    api: cloudflareLogin,
    domain,
    hostname,
    hostnameZone,
    sesRecords: !dns.sesDone,
  });

  const secrets: Secrets = {};

  if (draft.turnstileSiteKey && existingSecrets.has("TURNSTILE_SECRET_KEY")) {
    log.success("Turnstile widget: already set up.");
  } else {
    const turnstile = await turnstileKeys(
      await cloudflareApi(),
      accountId,
      hostname,
      draft.turnstileSiteKey
    );

    save({ turnstileSiteKey: turnstile.sitekey });
    secrets.TURNSTILE_SECRET_KEY = turnstile.secret;
  }

  await configureAllDns({
    accountId,
    cloudflareApi,
    domain,
    hostname,
    pagesDev,
    progress: dns,
    region,
    senderDnsZone,
    ses,
  });

  if (access.runtime) {
    secrets.AWS_ACCESS_KEY_ID = access.runtime.accessKeyId;
    secrets.AWS_SECRET_ACCESS_KEY = access.runtime.secretAccessKey;
  }

  // Never rotate: it signs the unsubscribe links in every email already sent.
  if (!existingSecrets.has("TOKEN_SECRET")) {
    secrets.TOKEN_SECRET = randomSecret();
  }

  const mcp = await chooseMcpToken(existingSecrets);

  if (mcp.created && mcp.token) {
    secrets.MCP_TOKEN = mcp.token;
  }

  progress.start(`Deploying to ${publicUrl}`);

  try {
    deploy(secrets);
  } catch (error) {
    progress.stop("Deploy failed");
    fail(error instanceof Error ? error.message : String(error));
  }

  progress.stop(`Deployed to ${publicUrl}`);

  save({
    awsAccessKeyId: newRuntimeKeyId ?? draft.awsAccessKeyId,
    pendingAwsAccessKeyId: undefined,
  });

  warnAboutOldKeys(access);

  // Show a new token straight away, so nothing after this can lose it.
  if (mcp.created && mcp.token) {
    showMcpToken(publicUrl, mcp.token);
  }

  if (usePages) {
    await attachPagesDomain(cloudflareLogin, accountId, hostname);
  }

  let checked = false;

  try {
    checked = await finishSetup({
      aws,
      domain,
      newsletter,
      publicUrl,
      token: mcp.token,
      topicArn: ses.topicArn,
    });
  } catch (error) {
    fail(
      `${error instanceof Error ? error.message : String(error)}\n\nEverything before this step is done. Run \`bun run setup\` again to finish; it skips what's already set up.`
    );
  }

  outro(finished(publicUrl, checked));
};

await main();
