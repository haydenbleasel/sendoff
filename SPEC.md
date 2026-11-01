# Sendoff spec

A self-hosted email tool for one list (newsletters, product launches, announcements: an alternative to Resend's Broadcasts) that you drive from an agent. You deploy it into your own Cloudflare and AWS accounts, connect its MCP server to Claude or Codex, and say "help me draft the next issue" and then "send it".

## Decisions

| Area | Decision |
| --- | --- |
| Hosting model | Self-hosted. Every user deploys into their own Cloudflare and AWS accounts, so each sender owns its reputation and AWS handles abuse. |
| Sending | Amazon SES. Cloudflare Email Sending is transactional-only, so it can't send newsletters or announcements. |
| Everything else | Cloudflare: Workers, D1, Queues, Turnstile, Email Routing, DNS. The domain's DNS doesn't have to be on Cloudflare: if it isn't, a Pages project fronts the Worker (see [Setup flow](#setup-flow)). |
| Plan | Workers Paid ($5/mo) is required. Cold React Email renders take ~30 ms of CPU, about 3× the free plan's 10 ms limit. Total cost is about $62/yr (Workers $60 + SES $2.40 at 6K × 4 sends). |
| Email rendering | React Email, with one fixed, well-designed layout that looks good with no design work. Users fill in the middle. |
| Content | Markdown plus two directives (`::button`, `:::callout`). The agent never writes TSX. |
| Interface | A remote MCP server (Streamable HTTP) on the same Worker, plus a small REST API for servers (e.g. a website's signup form). There's no admin UI beyond preview and public pages. |
| Scope | One list, for any kind of broadcast: newsletters, launches, announcements. No transactional email, segments, automations, A/B tests, visual editor, teams or dedicated IPs. |

## Deployment and settings

Sendoff is one Worker app (`apps/app`). There's no published framework package and no generated project: the only published package is `create-sendoff`, which clones the repo.

- **Deploying:** `bun create sendoff [folder]` clones the repo (a real clone, so `git pull` updates it), runs `bun install` and hands off to `bun run setup` (see [Setup flow](#setup-flow)); later, `bun run update` moves the clone to the newest Worker release (the latest stable `app@x.y.z` tag, fast-forward only, after showing the changelog since the current version and asking), then installs and runs `bun run deploy`, which ships the code as it is. It never moves backwards past unreleased commits, and stops on uncommitted changes or local commits. Before cloning it checks for Git and Bun and nudges people to log in to the AWS CLI. Run again on an existing clone, it skips the clone and resumes setup. A Deploy to Cloudflare button comes later.
- **Customizing doesn't touch code.** Brand and sender settings live in D1 and are edited through MCP: "make the accent color #ff0066" or "add my GitHub link". A user's copy never drifts from upstream, so updating is just moving to a newer release and redeploying.
- **Where config lives:**
  - Secrets are Worker secrets: `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `TOKEN_SECRET` (signs links), `TURNSTILE_SECRET_KEY` and `MCP_TOKEN`.
  - Vars and infrastructure IDs go in `wrangler.jsonc`, written by `setup`: `PUBLIC_URL`, `SES_REGION`, `SES_CONFIGURATION_SET`, `SES_EVENTS_TOPIC_ARN`, `TURNSTILE_SITE_KEY`, plus the D1 and queue bindings.
  - Locally, `.dev.vars` overrides them (`.dev.vars.example` uses Turnstile's always-pass test keys). `getConfig()` validates everything and names whatever is missing.

Settings (one row in D1):

```ts
{
  name: "Hayden's Newsletter",
  description: "A quarterly letter about…", // optional, shown on the subscribe page
  from: { name: "Hayden Bleasel", email: "hello@example.com" }, // must match a verified SES identity
  replyTo: "hello@example.com",
  address: "123 Example St, Sydney NSW 2000", // optional; needed for commercial email
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
| `GET /confirm/:token` | Asks the person to confirm, with a button. It doesn't confirm on its own: mail filters open links in emails as they arrive. |
| `POST /confirm/:token` | Marks a `pending` subscriber `active`. An old link can't undo an unsubscribe. |
| `GET /unsubscribe/:token` | Asks for confirmation only. Link scanners load URLs in emails, so a GET must never unsubscribe. |
| `POST /unsubscribe/:token` | Unsubscribes: the page's button, and RFC 8058 one-click POSTs from mail providers. `?issue=` attributes it to an issue. |
| `POST /resubscribe/:token` | Undoes an unsubscribe from the same link. |
| `POST /webhooks/ses` | SNS endpoint for SES events. Verifies the SNS signature and handles `SubscriptionConfirmation`. |
| `GET /click/:issueId/:token/:signature?url=` | Tracked link: records the click in the background (`waitUntil`) and redirects (302) to `url`. The signature is an HMAC of the issue id and `url`, so it never redirects anywhere the issue didn't link. A bad or test `:token` still redirects but isn't counted; HEAD requests aren't counted. Served before the page security headers. |
| `GET /open/:issueId/:token` | Open image (a 1×1 GIF, `no-store`), recorded in the background. Served before the page security headers, since `Cross-Origin-Resource-Policy` would block it in webmail. |
| `GET /preview/:token` | Live preview (`:token` is a signed issue id, so the URL is the only access check). Email/text, desktop/mobile and light/dark toggles; polls `/state` every 1.5 s and fetches `/render` when the draft or settings change. Shows Markdown problems, keeping the last good render dimmed. |
| `/mcp` | MCP server (official SDK v2, `createMcpHandler`, stateless, JSON responses). The OAuth provider wraps the Worker and protects it: OAuth access tokens (claude.ai, Claude Desktop) or the static `MCP_TOKEN` (Claude Code, Codex). |
| `GET/POST /authorize`, `POST /authorize/sign-in` | OAuth authorize step: the owner signs in with the admin token (a 15-minute signed `__Host-` session cookie), then sees a consent page (client name, verified domain for CIMD clients, redirect host, loopback warning) and allows or denies. |
| `/oauth/token`, `/oauth/register`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource/mcp` | Served by `@cloudflare/workers-oauth-provider`: token endpoint, dynamic registration, and discovery metadata. |
| `POST /api/v1/subscribers` | REST: subscribe an address (double opt-in). Needs an API key with `subscribers:write`. See [REST API](#rest-api). |
| `POST /api/v1/subscribers/import`, `POST /api/v1/issues/import` | REST imports: a CSV of subscribers (`subscribers:import`) and past issues (`issues:import`). See [Importing](#importing). |
| `GET /api/v1/openapi.json` | OpenAPI 3.1 description of the REST API, generated from the handlers' zod schemas. Public. |
| `/issues/:slug` | Hosted "view in browser" page and archive (later milestone). |
| Queue consumer (`sendoff-send`) | One message = one chunk of up to 50 recipients. Batch size 1, concurrency 1. |
| Cron (`*/5 * * * *`) | Restarts sends with no worker activity for 5 minutes (a lost queue message), and finishes sends with nothing left to do. |
| Cron (`0 3 * * *`) | Purges expired OAuth grants and tokens. |
| Email Routing handler (not built yet) | Inbound replies and the `mailto:` unsubscribe address. Replies are forwarded to `replyTo`. |

Stack: Hono (routing), Drizzle + D1, `aws4fetch` (SigV4 for SES; no AWS SDK), the MCP TypeScript SDK (`@modelcontextprotocol/server`), `@cloudflare/workers-oauth-provider` (OAuth for connectors), React Email.

### Platform limits

Workers Paid gives 30 s CPU per request (15 min per queue consumer run) and 10,000 subrequests per run. A newsletter this size stays well inside the included usage. The design still keeps work small:

- **Render once per issue.** Do string substitution per recipient. Measured with `bun run bench` on an M-series Mac: about 1 ms warm, about 28–32 ms cold. Don't use React Email's `<Tailwind>` component, which compiles CSS on every render; use inline styles.
- **Send in chunks.** Each queue message carries up to 50 recipients, so a chunk finishes in seconds at the SES max send rate. Chunks are the unit of retry and of pacing.
- **Keep event writes small.** SES reports bounces, complaints, rejects and deliveries. A delivery is one `UPDATE` of its send row (by message id), not an event row, so a send costs about one SNS request and one write per recipient (6,000 a quarter is well inside SNS's free tier). Clicks and opens are tracked by the Worker itself; opens keep at most one row per person per kind of agent.

## Data model (D1)

```
subscribers  id (UUIDv7) PK, email UNIQUE (lowercased), name, status, source,
             created_at, confirmed_at, confirmation_sent_at, unsubscribed_at,
             last_engaged_at, metadata JSON
             status: pending | active | unsubscribed | bounced | complained
             source: api | import | form | mcp

issues       id PK, slug UNIQUE, subject, preheader, body, version INT,
             status, content_hash, test_sent_hash, test_sent_at,
             rendered_html, rendered_text, sender JSON, tracking JSON,
             promotion_check JSON,
             recipient_count,
             send_started_at, send_heartbeat_at, send_error,
             created_at, updated_at, sent_at, cancelled_at, imported_at
             status: draft | sending | sent | cancelled
             imported_at: set for past issues from another provider (see
             Importing): status sent, rendered_html/text as they were sent,
             body empty, updated_at = sent_at, send_started_at null

sends        (issue_id, subscriber_id) PK, status, message_id, error, sent_at,
             delivered_at
             status: queued | sending | sent | failed | skipped
             index on message_id

events       id PK, message_id, issue_id, subscriber_id, type, detail JSON, at
             type: bounce | complaint | reject | click | open | unsubscribe
             click detail: { link, agent }; open detail: { agent }, id
             open:<issue>:<subscriber>:<agent> (first time only)

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
- The layout (`apps/app/src/email`) has a header with logo, the body, and a footer with unsubscribe link, postal address (if set), social links and "you're receiving this because…". Settings fill in the logo, accent, links and address; nothing else about the design is configurable in v1.
- Quality bar: test in Gmail (web and iOS), Apple Mail, Outlook (web and Windows) and dark mode. Use system font stacks, because most clients ignore web fonts. Every email gets a plain-text alternative, generated from the Markdown tree rather than scraped from the HTML. Dark mode uses `prefers-color-scheme` styles that clients like Apple Mail apply; other clients get the light inline styles.
- Images are URL-only in v1. R2 uploads come later.

## MCP tools

| Group | Tools | Notes |
| --- | --- | --- |
| Settings | `get_settings`, `update_settings` | `update_settings` merges a partial update (`null` clears optional fields), including `tracking: { clicks, opens }`. It warns, rather than blocks, when the sender's domain isn't verified in SES; sending is blocked until it is. |
| Setup | `doctor` | Fails (blocks sending): no settings, no active subscribers, SES unreachable, sandbox, sending disabled, account shut down, quota below the list size, sender domain not verified, no DMARC record (looked up over DNS-over-HTTPS, falling back to the parent domain), configuration set missing. Warns: probation, no postal address, no custom MAIL FROM, bounce/complaint events not wired to Sendoff's SNS topic, deliveries not reported, account suppression list off. |
| Drafts | `create_draft`, `get_draft`, `edit_draft`, `set_draft_meta`, `list_issues`, `preview_draft`, `delete_draft`, `import_issue` | `edit_draft` applies exact find/replace edits all-or-nothing (or replaces the body), takes an optional `expectedVersion`, and bumps `version`. Drafts are stored even with Markdown problems; results list them by line. `preview_draft` returns the URL plus the plain-text version so the agent can proofread. Issues are addressed by id or slug. `import_issue` keeps one past issue from another provider (see [Importing](#importing)); `delete_draft` also deletes imported issues. |
| Sending | `send_test`, `prepare_send`, `check_promotion`, `confirm_send`, `send_status`, `cancel_send`, `resume_send` | See [Send pipeline](#send-pipeline). `confirm_send` and `cancel_send` are annotated `destructiveHint: true`, and the instructions tell the agent to confirm only after the person explicitly says to send. |
| Subscribers | `add_subscriber`, `import_csv`, `import_subscribers`, `search_subscribers`, `unsubscribe_subscriber` (`prune` in M6) | `add_subscriber` sends a confirmation email unless `skipConfirmation` (only when the person asked to be added). Imports support `dryRun`, can suppress an existing subscriber but never reactivate one, and treat imported active subscribers as confirmed. `import_csv` reads any provider's CSV export (see [Importing](#importing)); `import_subscribers` takes a short list of addresses. |
| API keys | `create_api_key`, `list_api_keys`, `revoke_api_key` | Keys are shown once (to the agent, which hands them to the person) and stored hashed. Revoke by id or prefix. |
| Stats | `issue_stats` (`growth` later) | See [Tracking and stats](#tracking-and-stats). Clicks and unsubscribes are the trustworthy signals. Opens are unreliable because of Apple Mail Privacy Protection, so they're off by default. |

Auth (M5b, MCP authorization 2026-07-28 via `@cloudflare/workers-oauth-provider`):

- **claude.ai and Claude Desktop** add a custom connector with `https://<host>/mcp`. They discover the server through Protected Resource Metadata and authorization server metadata, register with a Client ID Metadata Document (or dynamic registration, deprecated but kept for older clients), and go through `/authorize` with PKCE (S256) and the `resource` parameter. Access tokens are bound to the `/mcp` resource, refresh tokens come with `offline_access`, and grants live hashed and encrypted in the `OAUTH_KV` namespace.
- **The owner signs in on `/authorize` with the admin token** (`MCP_TOKEN`). There's one owner and no account system. Consent is asked every time.
- **Claude Code and Codex** keep using `MCP_TOKEN` as a static bearer token through `resolveExternalToken`. It's this server's own credential rather than a passed-through upstream key, but strictly the MCP profile only expects tokens from the server's authorization server, so OAuth is the conformant path.
- **Scopes:** `newsletter` (everything) and `offline_access`. The tools don't distinguish narrower scopes yet.
- The provider needs the `global_fetch_strictly_public` compatibility flag, so fetching client metadata documents can't reach private hosts.

## Importing

Every provider exports contacts as CSV, so Sendoff reads CSV rather than talking to each provider's API. `src/importers/csv.ts` parses RFC 4180 (quoted fields, `""` escapes, newlines in quotes, any line ending, a byte order mark, and comma, semicolon or tab delimiters picked from the header) and finds columns by normalized header (lowercase letters and digits only):

- **Email:** `email`, `email_address`, `Email Address` and similar, else the first header containing "email" that isn't a flag. A file whose first row has an address is read as a headerless list.
- **Name:** `name`/`full_name`, or `first_name` plus `last_name`.
- **Status column** (`status`, `state`, `subscriber_type`…): values such as active/subscribed/confirmed, unsubscribed/cancelled/removed, bounced/cleaned/invalid, complained/spam. Pending, unconfirmed and inactive rows are skipped.
- **Flag columns:** `unsubscribed`, `bounced`, `complained`, `email_disabled`, `do_not_email`, and timestamps like Mailchimp's `UNSUB_TIME` and `CLEAN_TIME` mark a row when set to anything but false or empty; `subscribed`, `opted_in` and `accepts_marketing` mark it unsubscribed when false.

A row with several signals takes the most severe (complained, bounced, unsubscribed, active), and a `status` option marks a whole file of suppressions. Anything unclear is skipped and reported (unrecognized status values with counts, rows without an email) rather than imported as active, because emailing someone who unsubscribed is the mistake an import must not make. Small files go through `import_csv` directly; bigger ones go to the REST endpoint with `curl`, so the agent doesn't copy thousands of addresses into a tool call.

### Past issues

Issues sent with another provider are kept exactly as they went out (`src/importers/issues.ts`): `{ subject, html, text?, preheader?, sentAt, slug? }`, where `sentAt` is ISO 8601 or a close variant like Resend's `2025-03-01 09:00:00.123+00` (no zone means UTC) and must be in the past. Each becomes an issue with `imported_at` set, `status` sent, the HTML and text in `rendered_html`/`rendered_text` and an empty Markdown body, so it can never be sent, edited or counted. Missing plain text is made from the HTML (head, styles and scripts dropped; links as "label (url)"; entities decoded). Importing the same subject and `sent_at` again replaces it (and bumps `version`), so a corrected copy can be re-imported. The old provider's merge tags (`{{{…}}}`, `{{ name }}`, `*|TAG|*`) are kept as they are and reported, so the agent can replace them with what readers saw and import again; double braces in code samples are reported too, which is why nothing is rewritten automatically.

- **Viewing:** the preview link shows the stored HTML (status "imported"), in the preview's iframe, which is sandboxed without scripts. `get_draft` and `preview_draft` return the plain text. `issue_stats` and `send_status` say Sendoff has no data for it, and imported issues never count as the latest send or in comparisons (`send_started_at` is null).
- **Bulk:** `import_issue` takes one issue in the tool call. For more, the agent creates an `issues:import` key and pipes the issues straight from the old provider's API (Resend's Retrieve Broadcast returns `html`, `text`, `subject`, `preview_text`, `sent_at`) to `POST /api/v1/issues/import` with `curl`, so the HTML is never retyped through the model.

## REST API

A small API under `/api/v1` for servers. MCP tools don't go through it: both are thin layers over the same functions (`subscribers.ts`, `issues.ts`, `sending.ts`), which keeps them in sync without an extra HTTP hop. More endpoints (issues, sending, settings) get added when something needs them, each with its own scope.

- **Auth:** `Authorization: Bearer sendoff_…`. Keys are random (32 bytes), stored as SHA-256 hashes, scoped, and revocable. There are no CORS headers, so browsers can't call the API: keys belong in server-side secrets.
- **`POST /api/v1/subscribers`** (`subscribers:write`) takes `{ "email": "…", "name"?: "…" }` and starts double opt-in. Responses:
  - `202 { "status": "accepted" }` for new, pending and existing subscribers alike, so it can't reveal who's on the list.
  - `400 invalid_request`, `401 invalid_api_key`, `403 insufficient_scope`, `503 not_configured`.
  - `502 confirmation_failed` if SES couldn't send the confirmation; safe to retry.
- **Errors** are always `{ "error": { "code", "message" } }`.
- **`POST /api/v1/subscribers/import`** (`subscribers:import`) takes a CSV as the raw body (`curl --data-binary @export.csv -H "Content-Type: text/csv"`) or a multipart `file` field, up to 10 MB and 25,000 rows, with `?dryRun=true` and an optional `?status=unsubscribed|bounced|complained`. It returns the import report (columns used, counts by status, skipped rows, new/suppressed/unchanged), or `400 invalid_request` (no email column, too many rows) and `413 too_large`. Its own scope because it adds people without confirmation emails: agents create a key for one import and revoke it afterwards.
- **`POST /api/v1/issues/import`** (`issues:import`) takes `{ "issues": [...] }`, up to 50 issues and 10 MB, and imports them in order. It returns each issue's `outcome` (`created`, `updated` or `failed` with an `error`, such as a taken slug; a failure doesn't stop the rest) with its id, slug, send date and leftover `mergeTags`, or `400 invalid_request` and `413 too_large`.
- **Signing up from a website's server**, e.g. a Next.js server action replacing another provider's contacts call:
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
   - with no postal address, the issue doesn't read as commercial. `src/promotion.ts` asks `@cf/openai/gpt-oss-120b` on Workers AI (the `AI` binding) to apply the FTC's primary-purpose test (16 CFR 316.3: subject line; placement, proportion and emphasis of promotion) and CASL's broader one, returning `{ verdict: commercial | borderline | not_commercial, commercialMentions, reasons, fixes }` as JSON. "commercial" blocks with the reasons and fixes; "borderline", and "not_commercial" with commercial mentions (CASL), are warnings. The result is stored in `issues.promotion_check` with the content hash and model, and reused until the content changes, so it doesn't flip between runs. If the model can't be reached or answers badly, it's a warning, not a block. `check_promotion` runs the same check on demand. About 40 neurons a check, inside Workers AI's free daily allowance. Tests stub the classifier, and `remoteBindings: false` keeps Vitest off Cloudflare.

   It returns a summary (recipients, sender, estimated time at the SES max send rate, warnings) and a confirmation token: `expiresAt.HMAC(TOKEN_SECRET, "send:" + issueId + fingerprint + expiresAt)`, valid for 15 minutes.

4. **`confirm_send(token)`** recomputes the fingerprint and verifies the token, so any change since preparing invalidates it. Then:
   - It renders once and stores `rendered_html`/`rendered_text` with an unsubscribe placeholder, and stores `sender` (from and reply-to) and `tracking` so settings changes mid-send don't apply. With click tracking on, every web link in the HTML (except Sendoff's own pages) is rewritten to `/click/…` with a recipient-token placeholder; with open tracking on, the open image goes before `</body>`. Plain text is never tracked. Test sends are tracked the same way, with the token `test`.
   - In one D1 transaction, it moves the issue from `draft` to `sending` (guarded on status and version), snapshots active subscribers into `sends` with an `INSERT … SELECT`, and records `recipient_count`.
   - It queues the first chunk message `{ issueId, maxSendRate }`. If queueing fails, the cron picks it up.
5. **The queue consumer** (`processSendChunk`) handles each message:
   - Exits if the issue isn't `sending` (cancelled, finished, or stopped on an error).
   - Marks queued rows `skipped` for anyone no longer active, then claims up to 50 queued rows in one `UPDATE … RETURNING`. Rows already in `sending` are never reclaimed.
   - Sends in groups of up to 6 (the Workers connection limit), paced to SES's max send rate. Each email gets its own unsubscribe link (`/unsubscribe/<token>?issue=<id>`), its tracking token (`<subscriberId>.HMAC("track:" + subscriberId)`) in tracked links, the `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers, the configuration set, and an `issue` tag.
   - Outcomes:
     - Success: `sent` with the message ID.
     - Throttled (429): back to `queued`, with a pause.
     - Account-level error (paused, suspended, quota exhausted, bad credentials, missing configuration set): the rest of the chunk goes back to `queued`, the issue records `send_error`, and the chain stops until `resume_send`.
     - Any other SES error: `failed` with the reason.
     - Network error with an unknown outcome: `failed`, never retried.
   - Records each group before sending the next, updates `send_heartbeat_at`, and queues the next chunk while queued rows remain.
6. **Delivery is at-most-once per recipient.** When no queued rows remain, the issue becomes `sent`. Any rows still in `sending` were claimed by a crashed worker, so they're marked `failed` ("unknown outcome") rather than resent. A missed email is better than a duplicate to thousands of people.
7. **`send_status`** shows counts by state, deliveries, bounces, complaints and unsubscribes for the issue (engagement is `issue_stats`), the first few failures, `send_error`, and whether the send has stalled. **`cancel_send`** marks the issue `cancelled` and skips everything still queued. **`resume_send`** reruns `doctor`, clears `send_error` and restarts the chain.

At 14 emails per second (a typical new SES limit), 6,000 recipients take about 7 minutes across 120 chunks.

Later optimization: SES `SendBulkEmail` (50 destinations per call) with per-destination replacement data. First verify that it supports per-recipient `List-Unsubscribe` headers.

## SES events

- A configuration set publishes bounce, complaint, reject and delivery events to an SNS topic, which is subscribed over HTTPS to `/webhooks/ses`.
- **Hard bounce:** set the subscriber to `bounced`.
- **Complaint:** set the subscriber to `complained`.
- **Soft bounce:** log only.
- **Delivery:** set `sends.delivered_at` (from the event's timestamp), once.
- The SES account-level suppression list is also enabled for bounces and complaints, as a second line of defense.
- Instances set up before deliveries were added get a `doctor` warning ("Delivery reports") until setup is re-run.

## Tracking and stats

Settings `tracking: { clicks: true, opens: false }` by default, snapshotted onto each issue at confirm time (`issues.tracking`; null for issues sent before tracking existed).

- **Clicks** go through `/click` on Sendoff's own hostname, a subdomain of the sending domain, never a shared tracking domain. The destination stays visible and signed in the link. Every click is stored with `agent` (`browser`, `automated` or `apple`, from the user agent; no IPs or user agents are stored). `issue_stats` counts a click as automated, and leaves it out, if its agent isn't a browser, it came within 60 s of delivery (`delivered_at`, else `sent_at`), or the same person followed different links within 2 s. Those are security scanners, which follow every link as mail arrives.
- **Opens** (opt-in) come from the `/open` image. A bare `Mozilla/5.0` user agent is Apple Mail Privacy Protection's proxy, which loads every image on arrival; it's counted separately. "Opened" is people with a browser load or a counted click.
- **Engagement:** a counted click (browser, not within 60 s of delivery) or a browser open sets `subscribers.last_engaged_at`, for prune and re-engagement later.
- **`issue_stats`** (default: the latest issue with `send_started_at`) reports recipients, sent, delivered, bounces (hard/soft), suppressed, complaints, rejects, failed and skipped; clicks (people, total, automated, and every link by people, the top 10 in the summary); opens (people, Apple-only); unsubscribes; cumulative people who'd clicked and opened at 1 h, 6 h, 1 d, 3 d and 7 d; and the average rates of the last 3 `sent` issues (not cancelled) at the same age. Rates are of delivered (or sent, before deliveries are reported), except bounces, which are of sent less suppressed. Bounces with subtype `OnAccountSuppressionList` or `Suppressed` are SES's suppression lists, which SES never tries and leaves out of its own bounce rate, so they're counted as suppressed instead. It flags bounce rates at 5% and complaint rates at 0.1%, and notes when SES hasn't reported deliveries.

## Deliverability defaults (all on, not configurable away)

- DKIM (SES Easy DKIM), a custom MAIL FROM subdomain for SPF alignment, and DMARC (`p=none` to start). Setup adds one only when neither the sender's domain nor a parent domain has a DMARC record.
- RFC 8058 one-click unsubscribe headers and a visible unsubscribe link in every email.
- The postal address is optional, because US (CAN-SPAM) and Canadian (CASL) law require it only in commercial email. With one, it's in every footer. Without one, `doctor` warns and `prepare_send` runs the promotion check (see [Send pipeline](#send-pipeline)).
- Double opt-in for form signups, and Turnstile on the form.
- Honor unsubscribes immediately. The legal ceilings are 2 days (Gmail/Yahoo) and 10 business days (CAN-SPAM).
- Click tracking is on by default, through Sendoff's own hostname rather than SES's or anyone's shared tracking domain. Open tracking is off by default.
- Keep the same From domain as the previous provider so domain reputation carries over.
- Shared SES IPs only. A dedicated IP can't stay warm at quarterly volume.
- Watch the thresholds:
  - SES reviews at about 5% bounces or 0.1% complaints, and pauses at about 10% / 0.5%.
  - Gmail wants a spam rate under 0.3%.
  - `doctor` surfaces SES reputation metrics.

## Setup flow

`bun run setup` (in `scripts/setup.ts`) connects Sendoff to your accounts and deploys it. Every step checks what already exists, so it's safe to re-run; progress (including the newsletter answers, which pre-fill the prompts) is kept in the gitignored `apps/app/.sendoff/instance.json`. If a step after the deploy fails, setup says so and stops; running it again skips what's done.

1. **Cloudflare account:** read from `wrangler whoami` (runs `wrangler login` if needed, asks which account if there are several). It confirms the account is on Workers Paid, which can't be checked through Wrangler.
2. **Details:** name (a newsletter or brand name), sender, reply-to, an optional postal address. Then the hostname (default `news.<sender domain>`). Links on your own domain also keep emails away from shared `workers.dev` URLs, which spam filters distrust. Setup looks the hostname's zone up with Wrangler's own login (its OAuth scopes include `zone:read`), and asks if it can't. Then the SES region.
   - **On an active Cloudflare zone in the account,** the hostname is the Worker's Custom Domain.
   - **Anywhere else,** a Workers Custom Domain can't serve it (that needs the zone on Cloudflare, and Cloudflare's CNAME setup is Business-plan only), but a Pages custom domain can, through one CNAME at any DNS provider. So setup creates a Pages project, `sendoff-pages`, whose `_worker.js` passes every request unchanged to the Worker over a service binding (no extra cost or latency), and records it as `pagesProject` in `instance.json`. The Worker then has no public route of its own. Once a hostname is behind Pages it stays there on re-runs: if its DNS later moves to Cloudflare, the CNAME comes along, and a Custom Domain can't share a hostname with one.
3. **AWS access:** if the AWS CLI is logged in, setup offers to use that login (`aws configure export-credentials`, including short-lived SSO or `aws login` sessions) to provision SES and SNS. It then creates a dedicated `sendoff` IAM user with a send-only inline policy (`ses:SendEmail`, `GetAccount`, `GetEmailIdentity`, `GetConfigurationSetEventDestinations`) and an access key: the only AWS credential the Worker holds, so it can't create or change AWS resources. Re-runs reuse that key while the Worker has its secret, and only ever delete the one key setup recorded. Without the CLI, setup writes the full provisioning policy to `.sendoff/iam-policy.json` and asks for keys, which then serve both purposes.
4. **Optional Cloudflare API token** (Zone DNS Edit, Zone Read, Account Turnstile Edit; just Turnstile Edit when the hostname is behind Pages, since its DNS isn't on Cloudflare). It's used during setup and not stored, and only asked for if the Turnstile or DNS step still has work to do. With it, setup writes the DNS records and creates the Turnstile widget. Without it, setup prints the records and asks for Turnstile keys made in the dashboard.
5. **Resources:** the D1 database `sendoff`, the KV namespace `sendoff-oauth` and the queue `sendoff-send` through Wrangler, the Pages project if the hostname needs one (with its `*.pages.dev` hostname, the CNAME target), and a Turnstile widget for the hostname (skipped once the Worker has its secret).
6. **SES and SNS:**
   - the domain identity with Easy DKIM, and the custom MAIL FROM `bounce.<domain>`
   - the configuration set `sendoff`
   - the SNS topic `sendoff-events`, with a policy letting only SES (for this configuration set) publish
   - an event destination for bounces, complaints, rejects and deliveries (Sendoff tracks clicks and opens itself)
   - the account-level suppression list
7. **DNS:** three DKIM CNAMEs, an MX and SPF TXT for the MAIL FROM domain, and DMARC (`p=none`) only if the domain has none. Records that clash with existing ones are left alone and reported. Skipped once SES has verified DKIM and MAIL FROM and the domain has DMARC. Behind Pages, there's also a CNAME from the hostname to the project's `*.pages.dev` hostname (skipped once it resolves), and all the records are listed to add by hand.
8. **Deploy:** generates `.sendoff/wrangler.jsonc` from the base config plus the instance ids, applies D1 migrations, and deploys to the custom domain, uploading secrets with the version. Behind Pages, it then generates `.sendoff/pages/` (the `_worker.js` and a Wrangler config with the service binding) and runs `wrangler pages deploy`, and setup adds the hostname to the project as a custom domain with Wrangler's login (`pages:write`), or asks you to add it in the dashboard if that fails. Only new secrets are uploaded. `TOKEN_SECRET` is generated once and never rotated, because it signs every unsubscribe link ever sent. `MCP_TOKEN` can't be read back, so if the Worker already has one, setup asks whether to keep it (pasting it lets setup finish the MCP steps) or create a new one. A new token is printed as soon as the deploy succeeds, with the `claude mcp add --scope user` command (user scope, so Sendoff connects from any folder) and connector instructions, so a later failure can't lose it.
9. **Wire-up:** waits for `https://<host>/health` to answer (a new custom domain needs a few minutes for its certificate, and SNS rejects unreachable endpoints), subscribes `https://<host>/webhooks/ses` to the topic, retrying "Unreachable Endpoint", and waits for the Worker to confirm it. Then waits for SES to verify the domain.
10. **SES production access:** shows a pre-filled use-case description (naming your existing website, which AWS reviewers look at) and submits it (`PutAccountDetails`, `MailType=MARKETING`) only if you confirm. Approval usually takes about a day.
11. **Finish:** saves the newsletter settings and runs `doctor` through MCP (skipped if you kept an MCP token without pasting it).

`bun run deploy` later redeploys code changes with the same instance config, applying any new migrations first, and redeploys the Pages project too if there is one.

## Repo layout

```
apps/web                  Blume docs site (exists)
apps/app                  the Worker: public pages, MCP, preview, send queue, SES client, email template, setup script
packages/create-sendoff   `bun create sendoff`: clones the repo and hands off to setup (published to npm)
```

The app stays self-contained (no internal workspace packages) so a Deploy to Cloudflare button can deploy the `apps/app` directory on its own. Pull code out into `packages/` only once something else needs it. `create-sendoff` isn't shared code: nothing imports it, and it's bundled into one file with no runtime dependencies.

## Milestones

|  | Milestone | Done when |
| --- | --- | --- |
| M0 | AWS groundwork (manual, start now) | SES identity verified for the real domain, production access requested, contacts exported from the old provider (including unsubscribed and bounced). |
| M1 | Foundation | Worker skeleton, D1 schema and migrations, SES client, email layout and renderer. Render CPU measured; Workers Paid chosen. ✅ |
| M2 | Subscribers | Subscribe/confirm/unsubscribe (including one-click), SNS webhook, import core (the MCP tools land in M3). ✅ |
| M3 | Drafting | MCP draft, settings and subscriber tools, and the live preview, verified with the official MCP client over HTTP against `wrangler dev`. ✅ |
| M4 | Sending | Test send, prepare/confirm, queue fan-out, status/cancel/resume, `doctor`, stalled-send cron. Built and tested against a stubbed SES. ✅ **First real issue still to go out** (needs the SES account from M0). |
| M5a | Setup | `bun run setup` and `bun run deploy`, with your instance's ids kept out of the repo. Built; the pure parts are tested, the real run is yours. |
| M5b | OAuth | OAuth 2.1 for claude.ai and Claude Desktop connectors, with the static token kept for Claude Code and Codex. Full flow tested end to end. ✅ |
| M5c | Docs and deploy button | Docs site content, Deploy to Cloudflare button. |
| M6 | Extras | Stats (`issue_stats` ✅, `growth` to come), prune and re-engagement, web archive and RSS, R2 image uploads. |

## Open questions

- **Deploy button:** confirm the Deploy to Cloudflare button works from a monorepo subdirectory with Bun.
- **MCP Apps:** render the preview inline in clients that support it, in addition to the URL? Decide after M3.
