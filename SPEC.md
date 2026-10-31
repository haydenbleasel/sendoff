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
| Interface | A remote MCP server (Streamable HTTP) on the same Worker. There's no admin UI beyond preview and public pages. |
| Scope | One newsletter, one list. No transactional email, segments, automations, A/B tests, visual editor, teams or dedicated IPs. |

## Deployment and settings

Sendoff is one Worker app (`apps/app`). There's no published framework package and no generated project.

- **Deploying:** clone the repo, or use a Deploy to Cloudflare button, then run `bun run setup` (see [Setup flow](#setup-flow)) and `bun run deploy`.
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
| `GET /preview/:issueId` | Live preview, with mobile/desktop and light/dark toggles. Polls a version endpoint and re-renders on change. |
| `/mcp` | MCP server. |
| `/issues/:slug` | Hosted "view in browser" page and archive (later milestone). |
| Queue consumer | Sends one chunk of recipients per message. |
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

issues       id PK, slug UNIQUE, subject, preheader, body_md, version INT,
             status, content_hash, test_sent_hash, rendered_html, rendered_text,
             created_at, updated_at, sent_at, cancelled_at
             status: draft | sending | sent | cancelled

sends        (issue_id, subscriber_id) PK, status, message_id, error, sent_at
             status: queued | sending | sent | failed | skipped
             index on message_id

events       id PK, message_id, issue_id, subscriber_id, type, detail JSON, at
             type: bounce | complaint | reject | click | unsubscribe

settings     id = 1 PK, data JSON (validated with a schema), updated_at
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
| Settings | `get_settings`, `update_settings` | `update_settings` rejects a `from` address whose domain isn't a verified SES identity. |
| Setup | `doctor` | Checks SES identity verified, DKIM `SUCCESS`, MAIL FROM status, DMARC record present, production access (not sandbox), sending enabled, quota versus active subscribers, SNS subscription confirmed, account suppression list on. |
| Drafts | `create_draft`, `get_draft`, `edit_draft`, `set_meta`, `list_issues`, `preview_draft` | `edit_draft` uses find/replace (old/new strings) and bumps `version`. `preview_draft` returns the preview URL. |
| Sending | `send_test`, `prepare_send`, `confirm_send`, `send_status`, `cancel_send` | See [Send pipeline](#send-pipeline). `confirm_send` is annotated `destructiveHint: true`. |
| Subscribers | `add_subscriber`, `import_subscribers`, `import_from_resend`, `search_subscribers`, `unsubscribe`, `prune` | Imports can suppress an existing subscriber but never reactivate one. Resend's API exposes `unsubscribed` only, not bounces, so bounced addresses need a separate import (e.g. a dashboard export). |
| Stats | `issue_stats`, `growth` | Clicks and unsubscribes are the trustworthy signals. Opens are unreliable because of Apple Mail Privacy Protection and aren't tracked by default. |

Auth:

- v1 uses a static bearer token (a Worker secret). Claude Code (`--header`) and Codex (`bearer_token_env_var`) support this.
- claude.ai and Claude Desktop connectors need OAuth. That comes in M5 via `workers-oauth-provider`, with login by a magic link emailed to the owner through SES.

## Send pipeline

1. **`send_test`** renders the current version and sends it to the owner, or to supplied addresses. It records `test_sent_hash = content_hash`.
2. **`prepare_send`** runs `doctor` and refuses unless all of these hold: it passes, `test_sent_hash == content_hash`, and status is `draft`. It returns a summary (subject, active recipient count, preflight results, estimated duration at the SES max send rate) plus a short-lived confirmation token bound to `content_hash`.
3. **`confirm_send(token)`** validates the token, renders once, and stores `rendered_html`/`rendered_text` with a `{{unsubscribe_url}}` placeholder. It snapshots recipients with `INSERT INTO sends … SELECT … FROM subscribers WHERE status = 'active'`, sets the issue to `sending`, and enqueues chunk messages.
4. **The queue consumer** handles each chunk:
   - Claims rows with `UPDATE sends SET status = 'sending' WHERE status = 'queued' … RETURNING`.
   - Rechecks each subscriber's status and skips anyone who unsubscribed mid-send.
   - Calls SES `SendEmail` with the configuration set, the `List-Unsubscribe` and `List-Unsubscribe-Post` headers, and an `X-Sendoff-Issue` tag. Calls are paced to the account's max send rate.
   - Writes `message_id` and `sent`.
   - Exits early if the issue was cancelled.
5. **Delivery semantics are at-most-once per recipient.** A row stuck in `sending` after a crash is reported, not retried automatically. A missed email is better than a duplicate to thousands of people.
6. **Completion:** when no `queued` or `sending` rows remain, the issue becomes `sent`.

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

`bun run setup` walks through these steps. Each one is idempotent, so the flow can be re-run.

1. Ask for the newsletter name, sender, reply-to and postal address. These become the initial settings row.
2. Cloudflare: `wrangler login`, check the account is on Workers Paid (stop with a clear message if not), then create the D1 database, the queue and Turnstile keys.
3. AWS:
   - Print a least-privilege IAM policy, then ask for keys and store them as Worker secrets.
   - Create the SES domain identity, the custom MAIL FROM domain, the configuration set and event destination, and the SNS topic and HTTPS subscription.
   - Enable the account suppression list.
4. DNS: if the zone is on Cloudflare, write the DKIM CNAMEs, MAIL FROM MX/TXT and DMARC TXT through the API. Otherwise, print the records and poll until they verify.
5. SES production access: submit through `PutAccountDetails` (`MailType=MARKETING`, use-case text pre-filled from the settings). Warn that approval can take days and may be rejected.
6. Deploy, confirm the SNS subscription, and run `doctor`.
7. Print the MCP install snippets for Claude Code, Codex and Claude Desktop.

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
| M3 | Drafting | MCP draft tools and live preview working from Claude Code. |
| M4 | Sending | Test send, prepare/confirm, queue fan-out, status/cancel, `doctor`. **First real issue goes out.** |
| M5 | Distribution | `bun run setup`, Deploy to Cloudflare button, OAuth for claude.ai and Desktop, docs. |
| M6 | Extras | Stats, prune and re-engagement, web archive and RSS, R2 image uploads. |

## Open questions

- **Deploy button:** confirm the Deploy to Cloudflare button works from a monorepo subdirectory with Bun.
- **MCP Apps:** render the preview inline in clients that support it, in addition to the URL? Decide after M3.
