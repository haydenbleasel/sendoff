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
  cliCredentials,
  cliIdentity,
  createRuntimeKey,
  deleteRuntimeKey,
  ensureRuntimeUser,
  runtimeKeyIds,
} from "./setup/aws-cli";
import { createCloudflareApi } from "./setup/cloudflare";
import type { CloudflareApi } from "./setup/cloudflare";
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

const answer = <T>(value: T): Exclude<T, symbol> => {
  if (isCancel(value)) {
    cancel("Setup cancelled. Run it again any time; finished steps are kept.");
    process.exit(0);
  }

  // SAFETY: isCancel is true for the only symbol a clack prompt returns.
  return value as Exclude<T, symbol>;
};

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
        const keys = runtimeKeyIds();

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

const workerSecretNames = (): Set<string> =>
  new Set(
    (
      wranglerJson<{ name: string }[]>([
        "secret",
        "list",
        "--name",
        WORKER_NAME,
        "--format",
        "json",
      ]) ?? []
    ).map((secret) => secret.name)
  );

/** `dnsOnCloudflare` is false when the hostname's DNS is elsewhere, so the token is only for Turnstile. */
const cloudflareToken = async (
  dnsOnCloudflare: boolean
): Promise<CloudflareApi | null> => {
  note(
    (dnsOnCloudflare
      ? [
          "With an API token, setup adds your DNS records and creates the Turnstile widget for the signup page.",
          "Create one at https://dash.cloudflare.com/profile/api-tokens with:",
          "  Zone > DNS > Edit, Zone > Zone > Read (for your domain)",
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
 */
const hostnameOnCloudflare = async (
  api: CloudflareApi | null,
  accountId: string,
  hostname: string
): Promise<boolean> => {
  const zone = api
    ? await api.findZone(hostname, accountId).catch(() => "unknown" as const)
    : "unknown";

  const onCloudflare =
    zone === "unknown"
      ? answer(
          await confirm({
            message: `Is ${hostname}'s DNS on Cloudflare, in this account?`,
          })
        )
      : zone?.status === "active";

  if (onCloudflare) {
    return true;
  }

  const pending =
    zone !== "unknown" && zone && zone.status !== "active"
      ? ` (${zone.name} is on Cloudflare but isn't active yet)`
      : "";

  note(
    [
      `${hostname}'s DNS isn't on Cloudflare${pending}, so the Worker can't serve it directly.`,
      `Setup puts a small Cloudflare Pages project in front of it instead, and you'll add one CNAME record for ${hostname} with the others.`,
    ].join("\n"),
    "Hostname"
  );

  return false;
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
      listed.output.slice(Math.max(0, listed.output.indexOf("[")))
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

const hasDmarc = async (domain: string): Promise<boolean> => {
  const records = await lookup(`_dmarc.${domain}`, "TXT");

  return records.includes("v=dmarc1");
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
 * Add the SES records through the API token when the domain's zone is on
 * Cloudflare, or list them to add by hand. `byHand` records (the Pages CNAME,
 * on DNS that isn't Cloudflare's) are always listed.
 */
const configureDns = async ({
  byHand,
  cloudflare,
  domain,
  records,
}: {
  byHand: DnsRecord[];
  cloudflare: CloudflareApi | null;
  domain: string;
  records: DnsRecord[];
}) => {
  const zone =
    cloudflare && records.length > 0
      ? await cloudflare.findZone(domain).catch(() => null)
      : null;

  if (!(cloudflare && zone)) {
    await addRecordsByHand([...records, ...byHand]);

    return;
  }

  const outcomes = [];

  for (const record of records) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of records, in order
    const outcome = await cloudflare.ensureDnsRecord(zone.id, record);

    outcomes.push({ outcome, record });
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
  const progress = spinner();

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

/** After deploy: wire up SES events, save settings, request production access, run doctor. */
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
}): Promise<void> => {
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
      "Skipped saving your settings (no MCP token). Your agent can set them with update_settings."
    );

    return;
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

  await client.callTool({ arguments: settings, name: "update_settings" });
  log.success("Saved your settings.");
  note(
    toolText(await client.callTool({ arguments: {}, name: "doctor" })),
    "Preflight checks"
  );
  await client.close();
};

/**
 * Where Sendoff lives, and whether a Pages project has to front it. Once a
 * hostname is behind Pages it stays there: if its DNS moves to Cloudflare
 * later, the CNAME comes along, and a Custom Domain can't share it.
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
}): Promise<{ hostname: string; usePages: boolean }> => {
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
    return { hostname, usePages: true };
  }

  return {
    hostname,
    usePages: !(await hostnameOnCloudflare(api, accountId, hostname)),
  };
};

/** SES's records, plus the hostname's CNAME when it's behind Pages (`pagesDev`). */
const configureAllDns = async ({
  cloudflareApi,
  domain,
  hostname,
  pagesDev,
  region,
  ses,
}: {
  cloudflareApi: () => Promise<CloudflareApi | null>;
  domain: string;
  hostname: string;
  pagesDev: string | undefined;
  region: string;
  ses: Awaited<ReturnType<typeof configureSes>>;
}): Promise<void> => {
  const dmarc = await hasDmarc(domain).catch(() => false);

  const sesDone =
    ses.identity.verified && ses.identity.mailFromStatus === "SUCCESS" && dmarc;

  const cnameDone =
    pagesDev === undefined ||
    (await hasCname(hostname, pagesDev).catch(() => false));

  if (sesDone) {
    log.success(`DNS: SES has verified ${domain}, and it has DMARC.`);
  }

  if (pagesDev && cnameDone) {
    log.success(`DNS: ${hostname} points to ${pagesDev}.`);
  }

  if (sesDone && cnameDone) {
    return;
  }

  // Behind Pages, the hostname's DNS isn't on Cloudflare, so the token can't add records.
  const useToken = !(sesDone || pagesDev);

  await configureDns({
    byHand:
      pagesDev && !cnameDone ? [pagesCnameRecord(hostname, pagesDev)] : [],
    cloudflare: useToken ? await cloudflareApi() : null,
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
  });
};

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

  const newsletter = await newsletterDetails(draft.newsletter);

  save({ newsletter });
  const domain = newsletter.fromEmail.split("@")[1] ?? "";

  const cloudflareLogin = wranglerApi();

  const { hostname, usePages } = await chooseHostname({
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

  if (access.runtimeKeyId) {
    save({ awsAccessKeyId: access.runtimeKeyId });
  }

  const aws = createAwsSetup(access.provisioning);
  const progress = spinner();

  progress.start("Checking AWS access");
  await aws
    .getAccount()
    .catch((error: Error) => fail(`AWS access didn't work: ${error.message}`));
  progress.stop("AWS access works");

  // Only ask for a Cloudflare API token if a step below needs it.
  let cloudflare: Promise<CloudflareApi | null> | undefined;

  const cloudflareApi = async (): Promise<CloudflareApi | null> => {
    cloudflare ??= cloudflareToken(!usePages);

    return await cloudflare;
  };

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

  progress.start("Setting up SES and SNS");
  const ses = await configureSes(aws, domain, region);
  save({
    sesConfigurationSet: CONFIGURATION_SET,
    sesEventsTopicArn: ses.topicArn,
    sesRegion: region,
  });
  progress.stop("SES identity, configuration set and event topic ready");

  await configureAllDns({
    cloudflareApi,
    domain,
    hostname,
    pagesDev,
    region,
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

  // Show a new token straight away, so nothing after this can lose it.
  if (mcp.created && mcp.token) {
    showMcpToken(publicUrl, mcp.token);
  }

  if (usePages) {
    await attachPagesDomain(cloudflareLogin, accountId, hostname);
  }

  try {
    await finishSetup({
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

  outro(
    `Sendoff is live at ${publicUrl}. Ask your agent to draft your first issue.`
  );
};

await main();
