# Sendoff spec

A self-hosted, newsletter-only email tool that you drive from an agent. You deploy it into your own Cloudflare and AWS accounts, connect its MCP server to Claude or Codex, and say "help me draft the next issue" and then "send it".

## Decisions

| Area | Decision |
| --- | --- |
| Hosting model | Self-hosted. Every user deploys into their own Cloudflare and AWS accounts, so each sender owns its reputation and AWS handles abuse. |
| Sending | Amazon SES. Cloudflare Email Sending is transactional-only, so it can't send newsletters. |
| Everything else | Cloudflare: Workers, D1, Queues, Turnstile, Email Routing, DNS. |
| Plan | Workers Paid ($5/mo) is required. Cold React Email renders take ~30 ms of CPU, about 3× the free plan's 10 ms limit. Total cost is about $62/yr (Workers $60 + SES $2.40 at 6K × 4 sends). |
| Email rendering | React Email, with one fixed, well-designed layout that looks good with no design work. Users fill in the middle. |
| Content | Markdown plus two directives (`::button`, `:::callout`). The agent never writes TSX. |
| Interface | A remote MCP server (Streamable HTTP) on the same Worker, plus a small REST API for servers (e.g. a website's signup form). There's no admin UI beyond preview and public pages. |
| Scope | One newsletter, one list. No transactional email, segments, automations, A/B tests, visual editor, teams or dedicated IPs. |

## Deployment and settings

Sendoff is one Worker app (`apps/app`). There's no published framework package and no generated project.

- **Deploying:** clone the repo and run `bun run setup` (see [Setup flow](#setup-flow)); later, `bun run deploy` ships updates. A Deploy to Cloudflare button comes later.
- **Customizing doesn't touch code.** Brand and sender settings live in D1 and are edited through MCP: "make the accent color #ff0066" or "add my GitHub link". A user's copy never drifts from upstream, so updating is just pulling and redeploying.
- **Where config lives:**
  - Secrets are Worker secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TOKEN_SECRET` (signs links), `TURNSTILE_SECRET_KEY`, and later the MCP token.
  - Vars and infrastructure IDs go in `wrangler.jsonc`, written by `setup`: `PUBLIC_URL`, `SES_REGION`, `SES_CONFIGURATION_SET`, `SES_EVENTS_TOPIC_ARN`, `TURNSTILE_SITE_KEY`, plus the D1 and queue bindings.
  - Locally, `.dev.vars` overrides them (`.dev.vars.example` uses Turnstile's always-pass test keys). `getConfig()` validates everything and names whatever is missing.

Settings (one row in D1):

```ts
{
  name: "Hayden's Newsletter",
  description: "A quarterly letter about…", // optional, shown on the subscribe page
  from: { name: "Hayden Bleasel", email: "hello@example.com" }, // must match a verified SES identity
  replyTo: "hello@example.com",
  address: "123 Example St, Sydney NSW 2000", // CAN-SPAM postal address
  accent: "#ff0066", // links, buttons, callout tint; contrast is adjusted automatically
  logo: { url: "https://example.com/logo.png", darkUrl: "https://…", width: 120, height: 32 }, // optional
  links: [{ label: "Website", url: "https://example.com" }, { label: "X", url: "https://x.com/example" }],
}
```

Without a logo, the masthead shows the newsletter name. Email clients need explicit image dimensions, so the logo carries its display size. `darkUrl` is used by Apple Mail in dark mode.

## Architecture

One Worker serves everything:

| Route / handler | Purpose |
| --- | --- |
| `GET /` | Subscribe page (Turnstile plus a honeypot field). |
| `POST /subscribe` | Creates a `pending` subscriber and sends a confirmation email (double opt-in), at most once per 10 minutes per address. Always redirects to `/check-inbox`, whatever the outcome, so the form can't reveal who's subscribed. |
| `GET /confirm/:token` | Marks a `pending` subscriber `active`. An old link can't undo an unsubscribe. |
| `GET /unsubscribe/:token` | Asks for confirmation only. Link scanners load URLs in emails, so a GET must never unsubscribe. |
| `POST /unsubscribe/:token` | Unsubscribes: the page's button, and RFC 8058 one-click POSTs from mail providers. `?issue=` attributes it to an issue. |
| `POST /resubscribe/:token` | Undoes an unsubscribe from the same link. |
| `POST /webhooks/ses` | SNS endpoint for SES events. Verifies the SNS signature and handles `SubscriptionConfirmation`. |
| `GET /preview/:token` | Live preview (`:token` is a signed issue id, so the URL is the only access check). Email/text, desktop/mobile and light/dark toggles; polls `/state` every 1.5 s and fetches `/render` when the draft or settings change. Shows Markdown problems, keeping the last good render dimmed. |
| `/mcp` | MCP server (official SDK v2, `createMcpHandler`, stateless, JSON responses), behind a bearer token. |
| `POST /api/v1/subscribers` | REST: subscribe an address (double opt-in). Needs an API key with `subscribers:write`. See [REST API](#rest-api). |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description of the REST API, generated from the handlers' zod schemas. Public. |
| `/issues/:slug` | Hosted "view in browser" page and archive (later milestone). |
| Queue consumer (`sendoff-send`) | One message = one chunk of up to 50 recipients. Batch size 1, concurrency 1. |
| Cron (`*/5 * * * *`) | Restarts sends with no worker activity for 5 minutes (a lost queue message), and finishes sends with nothing left to do. |
| Email Routing handler | Inbound replies and the `mailto:` unsubscribe address. Replies are forwarded to `replyTo`. |

Stack: Hono (routing), Drizzle + D1, `aws4fetch` (SigV4 for SES; no AWS SDK), Cloudflare Agents SDK MCP handler, `@cloudflare/workers-oauth-provider` (later), React Email.

### Platform limits

Workers Paid gives 30 s CPU per request (15 min per queue consumer run) and 10,000 subrequests per run. A newsletter this size stays well inside the included usage. The design still keeps work small:

- **Render once per issue.** Do string substitution per recipient. Measured with `bun run bench` on an M-series Mac: about 1 ms warm, about 28–32 ms cold. Don't use React Email's `<Tailwind>` component, which compiles CSS on every render; use inline styles.
- **Send in chunks.** Each queue message carries about 100 recipients, so a chunk finishes in seconds at the SES max send rate. Chunks are the unit of retry and of pacing.
- **Keep event volume low.** Subscribe SES events to bounce, complaint, reject and click only, not delivery or open. That keeps D1 writes and SNS requests roughly proportional to problems, not to list size.

## Data model (D1)

```
subscribers  id (UUIDv7) PK, email UNIQUE (lowercased), name, status, source,
             created_at, confirmed_at, confirmation_sent_at, unsubscribed_at,
             last_engaged_at, metadata JSON
             status: pending | active | unsubscribed | bounced | complained
             source: import | form | mcp

issues       id PK, slug UNIQUE, subject, preheader, body, version INT,
             status, content_hash, test_sent_hash, test_sent_at,
             rendered_html, rendered_text, sender JSON, recipient_count,
             send_started_at, send_heartbeat_at, send_error,
             created_at, updated_at, sent_at, cancelled_at
             status: draft | sending | sent | cancelled

sends        (issue_id, subscriber_id) PK, status, message_id, error, sent_at
             status: queued | sending | sent | failed | skipped
             index on message_id

events       id PK, message_id, issue_id, subscriber_id, type, detail JSON, at
             type: bounce | complaint | reject | click | unsubscribe

settings     id = 1 PK, data JSON (validated with a schema), updated_at

api_keys     id PK, name, prefix (first 14 chars, for display), hash UNIQUE (SHA-256),
             scopes JSON, created_at, last_used_at, revoked_at
```

Unsubscribe and confirm tokens are `subscriberId.base64url(HMAC-SHA256(TOKEN_SECRET, purpose:subscriberId))`, truncated to 128 bits and compared in constant time. They're stateless and never expire, because unsubscribe links must keep working for years. Rotating `TOKEN_SECRET` invalidates every link in past emails, so don't.

## Content and template

- Each issue's body is plain Markdown. `subject` and `preheader` are separate fields, so frontmatter in the body is rejected.
- Supported: `#`–`###` headings, paragraphs, emphasis, strong, inline code, code blocks, lists, links (`https`, `http`, `mailto`), images (`https` only, alt text required), blockquotes, `---`, and two directives:
  - `::button[Label]{href="https://…"}`
  - `:::callout[Optional title]` … `:::`
- Anything else is rejected with a line number and a suggested fix (`src/email/markdown.ts`), so the agent can correct the draft. Raw HTML, reference-style links, footnotes and `####` headings are all rejected. Accidental text directives like `note:here` stay as literal text.
- The layout (`apps/app/src/email`) has a header with logo, the body, and a footer with unsubscribe link, postal address, social links and "you're receiving this because…". Settings fill in the logo, accent, links and address; nothing else about the design is configurable in v1.
- Quality bar: test in Gmail (web and iOS), Apple Mail, Outlook (web and Windows) and dark mode. Use system font stacks, because most clients ignore web fonts. Every email gets a plain-text alternative, generated from the Markdown tree rather than scraped from the HTML. Dark mode uses `prefers-color-scheme` styles that clients like Apple Mail apply; other clients get the light inline styles.
- Images are URL-only in v1. R2 uploads come later.

## MCP tools

| Group | Tools | Notes |
| --- | --- | --- |
| Settings | `get_settings`, `update_settings` | `update_settings` merges a partial update (`null` clears optional fields). It warns, rather than blocks, when the sender's domain isn't verified in SES; sending is blocked until it is. |
| Setup | `doctor` | Fails (blocks sending): no settings, no active subscribers, SES unreachable, sandbox, sending disabled, account shut down, quota below the list size, sender domain not verified, no DMARC record (looked up over DNS-over-HTTPS, falling back to the parent domain), configuration set missing. Warns: probation, no custom MAIL FROM, bounce/complaint events not wired to Sendoff's SNS topic, account suppression list off. |
| Drafts | `create_draft`, `get_draft`, `edit_draft`, `set_draft_meta`, `list_issues`, `preview_draft`, `delete_draft` | `edit_draft` applies exact find/replace edits all-or-nothing (or replaces the body), takes an optional `expectedVersion`, and bumps `version`. Drafts are stored even with Markdown problems; results list them by line. `preview_draft` returns the URL plus the plain-text version so the agent can proofread. Issues are addressed by id or slug. |
| Sending | `send_test`, `prepare_send`, `confirm_send`, `send_status`, `cancel_send`, `resume_send` | See [Send pipeline](#send-pipeline). `confirm_send` and `cancel_send` are annotated `destructiveHint: true`, and the instructions tell the agent to confirm only after the person explicitly says to send. |
| Subscribers | `add_subscriber`, `import_subscribers`, `import_from_resend`, `search_subscribers`, `unsubscribe_subscriber` (`prune` in M6) | `add_subscriber` sends a confirmation email unless `skipConfirmation` (only when the person asked to be added). Imports support `dryRun`. | Imports can suppress an existing subscriber but never reactivate one. Resend's API exposes `unsubscribed` only, not bounces, so bounced addresses need a separate import (e.g. a dashboard export). |
| API keys | `create_api_key`, `list_api_keys`, `revoke_api_key` | Keys are shown once (to the agent, which hands them to the person) and stored hashed. Revoke by id or prefix. |
| Stats | `issue_stats`, `growth` | Clicks and unsubscribes are the trustworthy signals. Opens are unreliable because of Apple Mail Privacy Protection and aren't tracked by default. |

Auth:

- v1 uses a static bearer token, the `MCP_TOKEN` Worker secret (at least 32 characters). Claude Code (`--header`) and Codex (`bearer_token_env_var`) support this:
  ```sh
  claude mcp add --transport http sendoff https://<your-worker>/mcp --header "Authorization: Bearer $MCP_TOKEN"
  ```
- claude.ai and Claude Desktop connectors need OAuth. That comes in M5 via `workers-oauth-provider`, with login by a magic link emailed to the owner through SES.

## REST API

A small API under `/api/v1` for servers. MCP tools don't go through it: both are thin layers over the same functions (`subscribers.ts`, `issues.ts`, `sending.ts`), which keeps them in sync without an extra HTTP hop. More endpoints (issues, sending, settings) get added when something needs them, each with its own scope.

- **Auth:** `Authorization: Bearer sendoff_…`. Keys are random (32 bytes), stored as SHA-256 hashes, scoped, and revocable. There are no CORS headers, so browsers can't call the API: keys belong in server-side secrets.
- **`POST /api/v1/subscribers`** (`subscribers:write`) takes `{ "email": "…", "name"?: "…" }` and starts double opt-in. Responses:
  - `202 { "status": "accepted" }` for new, pending and existing subscribers alike, so it can't reveal who's on the list.
  - `400 invalid_request`, `401 invalid_api_key`, `403 insufficient_scope`, `503 not_configured`.
  - `502 confirmation_failed` if SES couldn't send the confirmation; safe to retry.
- **Errors** are always `{ "error": { "code", "message" } }`.
- **Signing up from a website's server**, e.g. a Next.js server action replacing a Resend contacts call:
  ```ts
  "use server";

  export const subscribe = async (email: string) => {
    const response = await fetch(
      "https://news.example.com/api/v1/subscribers",
      {
        body: JSON.stringify({ email }),
        headers: {
          Authorization: `Bearer ${process.env.SENDOFF_API_KEY}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      }
    );

    if (!response.ok) {
      throw new Error("Couldn't subscribe. Please try again.");
    }
  };
  ```
- **Not a fit for email-sdk.dev:** its adapter contract is `send(message)` for arbitrary emails, and Sendoff deliberately has no general-purpose send endpoint.

## Send pipeline

Implemented in `src/sending.ts`.

1. **Fingerprint.** `sha256(content_hash, settings)`: the issue's subject, preheader and body plus every setting that shapes the email. Changing either after a test means testing again.
2. **`send_test`** renders the current version and sends it, with `[Test]` in the subject, to the reply-to address (or the sender, or up to 5 given addresses). The unsubscribe link in a test is a placeholder. It records `test_sent_hash` (the fingerprint) and `test_sent_at`.
3. **`prepare_send`** checks, without sending anything:
   - the issue is a draft that renders
   - the last test matches the current fingerprint
   - `doctor` has no failures

   It returns a summary (recipients, sender, estimated time at the SES max send rate, warnings) and a confirmation token: `expiresAt.HMAC(TOKEN_SECRET, "send:" + issueId + fingerprint + expiresAt)`, valid for 15 minutes.

4. **`confirm_send(token)`** recomputes the fingerprint and verifies the token, so any change since preparing invalidates it. Then:
   - It renders once and stores `rendered_html`/`rendered_text` with an unsubscribe placeholder, and stores `sender` (from and reply-to) so settings changes mid-send don't apply.
   - In one D1 transaction, it moves the issue from `draft` to `sending` (guarded on status and version), snapshots active subscribers into `sends` with an `INSERT … SELECT`, and records `recipient_count`.
   - It queues the first chunk message `{ issueId, maxSendRate }`. If queueing fails, the cron picks it up.
5. **The queue consumer** (`processSendChunk`) handles each message:
   - Exits if the issue isn't `sending` (cancelled, finished, or stopped on an error).
   - Marks queued rows `skipped` for anyone no longer active, then claims up to 50 queued rows in one `UPDATE … RETURNING`. Rows already in `sending` are never reclaimed.
   - Sends in groups of up to 6 (the Workers connection limit), paced to SES's max send rate. Each email gets its own unsubscribe link (`/unsubscribe/<token>?issue=<id>`), the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, the configuration set, and an `issue` tag.
   - Outcomes:
     - Success: `sent` with the message ID.
     - Throttled (429): back to `queued`, with a pause.
     - Account-level error (paused, suspended, quota exhausted, bad credentials, missing configuration set): the rest of the chunk goes back to `queued`, the issue records `send_error`, and the chain stops until `resume_send`.
     - Any other SES error: `failed` with the reason.
     - Network error with an unknown outcome: `failed`, never retried.
   - Records each group before sending the next, updates `send_heartbeat_at`, and queues the next chunk while queued rows remain.
6. **Delivery is at-most-once per recipient.** When no queued rows remain, the issue becomes `sent`. Any rows still in `sending` were claimed by a crashed worker, so they're marked `failed` ("unknown outcome") rather than resent. A missed email is better than a duplicate to thousands of people.
7. **`send_status`** shows counts by state, bounces, complaints, unsubscribes and clicks for the issue, the first few failures, `send_error`, and whether the send has stalled. **`cancel_send`** marks the issue `cancelled` and skips everything still queued. **`resume_send`** reruns `doctor`, clears `send_error` and restarts the chain.

At 14 emails per second (a typical new SES limit), 6,000 recipients take about 7 minutes across 120 chunks.

Later optimization: SES `SendBulkEmail` (50 destinations per call) with per-destination replacement data. First verify that it supports per-recipient `List-Unsubscribe` headers.

## SES events

- A configuration set publishes bounce, complaint, reject and click events to an SNS topic, which is subscribed over HTTPS to `/webhooks/ses`.
- **Hard bounce:** set the subscriber to `bounced`.
- **Complaint:** set the subscriber to `complained`.
- **Soft bounce:** log only.
- **Click:** update `last_engaged_at`.
- The SES account-level suppression list is also enabled for bounces and complaints, as a second line of defense.

## Deliverability defaults (all on, not configurable away)

- DKIM (SES Easy DKIM), a custom MAIL FROM subdomain for SPF alignment, and DMARC (`p=none` with `rua` reporting to start).
- RFC 8058 one-click unsubscribe headers, plus a visible unsubscribe link and postal address in every email.
- Double opt-in for form signups, and Turnstile on the form.
- Honor unsubscribes immediately. The legal ceilings are 2 days (Gmail/Yahoo) and 10 business days (CAN-SPAM).
- Click tracking is off by default. If enabled, use a custom tracking domain rather than SES's default.
- Keep the same From domain as the previous provider so domain reputation carries over.
- Shared SES IPs only. A dedicated IP can't stay warm at quarterly volume.
- Watch the thresholds:
  - SES reviews at about 5% bounces or 0.1% complaints, and pauses at about 10% / 0.5%.
  - Gmail wants a spam rate under 0.3%.
  - `doctor` surfaces SES reputation metrics.

## Setup flow

`bun run setup` (in `scripts/setup.ts`) connects Sendoff to your accounts and deploys it. Every step checks what already exists, so it's safe to re-run; progress is kept in the gitignored `apps/app/.sendoff/instance.json`.

1. **Cloudflare account:** read from `wrangler whoami` (runs `wrangler login` if needed, asks which account if there are several). It confirms the account is on Workers Paid, which can't be checked through Wrangler.
2. **Newsletter details:** name, sender, reply-to, postal address. Then the hostname (default `news.<sender domain>`), which must be on a Cloudflare zone in the account. Links on your own domain also keep emails away from shared `workers.dev` URLs, which spam filters distrust. Then the SES region.
3. **AWS keys:** writes a least-privilege IAM policy to `.sendoff/iam-policy.json` (SES actions, plus SNS on `sendoff-*` topics only), asks for the access key, and checks it against SES.
4. **Optional Cloudflare API token** (Zone DNS Edit, Zone Read, Account Turnstile Edit). It's used during setup and not stored. With it, setup writes the DNS records and creates the Turnstile widget. Without it, setup prints the records and asks for Turnstile keys made in the dashboard.
5. **Resources:** the D1 database `sendoff` and the queue `sendoff-send` through Wrangler, and a Turnstile widget for the hostname.
6. **SES and SNS:**
   - the domain identity with Easy DKIM, and the custom MAIL FROM `bounce.<domain>`
   - the configuration set `sendoff`
   - the SNS topic `sendoff-events`, with a policy letting only SES (for this configuration set) publish
   - an event destination for bounces, complaints and rejects (no open or click tracking)
   - the account-level suppression list
7. **DNS:** three DKIM CNAMEs, an MX and SPF TXT for the MAIL FROM domain, and DMARC (`p=none`) only if the domain has none. Records that clash with existing ones are left alone and reported.
8. **Deploy:** generates `.sendoff/wrangler.jsonc` from the base config plus the instance ids, applies D1 migrations, and deploys to the custom domain, uploading secrets with the version. `TOKEN_SECRET` and `MCP_TOKEN` are only generated the first time: `TOKEN_SECRET` signs every unsubscribe link ever sent, so it must never rotate.
9. **Wire-up:** subscribes `https://<host>/webhooks/ses` to the topic and waits for the Worker to confirm it. Saves the newsletter settings through MCP, then waits for SES to verify the domain.
10. **SES production access:** shows a pre-filled use-case description and submits it (`PutAccountDetails`, `MailType=MARKETING`) only if you confirm. Approval usually takes about a day.
11. **Finish:** runs `doctor` and prints the MCP token once, with the `claude mcp add` command.

`bun run deploy` later redeploys code changes with the same instance config, applying any new migrations first.

## Repo layout

```
apps/web    Blume docs site (exists)
apps/app    the Worker: public pages, MCP, preview, send queue, SES client, email template, setup script
```

The app stays self-contained (no internal workspace packages) so a Deploy to Cloudflare button can deploy the `apps/app` directory on its own. Pull code out into `packages/` only once something else needs it.

## Milestones

|  | Milestone | Done when |
| --- | --- | --- |
| M0 | AWS groundwork (manual, start now) | SES identity verified for the real domain, production access requested, Resend export taken (including unsubscribed and bounced). |
| M1 | Foundation | Worker skeleton, D1 schema and migrations, SES client, email layout and renderer. Render CPU measured; Workers Paid chosen. ✅ |
| M2 | Subscribers | Subscribe/confirm/unsubscribe (including one-click), SNS webhook, Resend import (core; the MCP tool lands in M3). ✅ |
| M3 | Drafting | MCP draft, settings and subscriber tools, and the live preview, verified with the official MCP client over HTTP against `wrangler dev`. ✅ |
| M4 | Sending | Test send, prepare/confirm, queue fan-out, status/cancel/resume, `doctor`, stalled-send cron. Built and tested against a stubbed SES. ✅ **First real issue still to go out** (needs the SES account from M0). |
| M5a | Setup | `bun run setup` and `bun run deploy`, with your instance's ids kept out of the repo. Built; the pure parts are tested, the real run is yours. |
| M5b | OAuth | OAuth for claude.ai and Claude Desktop connectors. |
| M5c | Docs and deploy button | Docs site content, Deploy to Cloudflare button. |
| M6 | Extras | Stats, prune and re-engagement, web archive and RSS, R2 image uploads. |

## Open questions

- **Deploy button:** confirm the Deploy to Cloudflare button works from a monorepo subdirectory with Bun.
- **MCP Apps:** render the preview inline in clients that support it, in addition to the URL? Decide after M3.
