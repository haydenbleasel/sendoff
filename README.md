<img src="apps/web/public/logo.svg" alt="" width="56" height="56">

# Sendoff

**Say “send it.” Sendoff handles the rest.**

Sendoff emails your list, with no dashboard: newsletters, product launches, announcements. You deploy it into your own Cloudflare and AWS accounts, connect it to Claude or Codex, and run it by asking: "draft the next issue from these notes", "make the intro shorter", "send it".

[![Validate](https://github.com/haydenbleasel/sendoff/actions/workflows/validate.yml/badge.svg)](https://github.com/haydenbleasel/sendoff/actions/workflows/validate.yml) [![MIT license](https://img.shields.io/badge/license-MIT-171717)](license.md) ![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/haydenbleasel/sendoff?utm_source=oss&utm_medium=github&utm_campaign=haydenbleasel%2Fsendoff&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)

[Website](https://sendoff.dev) · [Docs](https://sendoff.dev/docs) · [Quickstart](https://sendoff.dev/docs/quickstart)

## Quick start

```sh
bun create sendoff
```

That clones Sendoff into `./sendoff`, installs it and runs setup. Setup creates the database, queue and SES identity, writes your DNS records, deploys the Worker and asks AWS for production access. It takes about ten minutes, most of it waiting for DNS. If anything fails, run it again: it skips what's done.

You need:

- A Cloudflare account on [Workers Paid](https://developers.cloudflare.com/workers/platform/pricing/), with your domain's DNS on Cloudflare
- An AWS account for SES
- [Bun](https://bun.sh), Git and, ideally, the [AWS CLI](https://aws.amazon.com/cli/), logged in

When setup finishes, it prints the URL and token to [connect your agent](https://sendoff.dev/docs/connect). Then ask it:

> Run Sendoff's doctor.

That shows anything still blocking a send, like SES production access (AWS usually approves it in about a day) or an empty list. The [quickstart](https://sendoff.dev/docs/quickstart) covers every step.

## How it works

- **Your agent writes the issues.** It drafts and edits them through Sendoff's MCP server. Issues are Markdown poured into one fixed, carefully designed email layout, so there's no template to build or maintain.
- **You watch a live preview.** The agent shares a link that updates as it edits, with toggles for desktop and mobile, light and dark mode, and the plain-text version.
- **Amazon SES sends the email** from your own domain.
- **Cloudflare runs everything else.** One Worker serves the signup page, unsubscribe links, the MCP server and a small REST API. D1 stores subscribers and issues, and Queues spread a send out over a few minutes.

Nothing reaches your list without you. Before a send, the agent has to email you a test of the exact version you're sending, show you a summary, and get your go-ahead in the conversation.

## Features

- **Works with your agent.** Claude Code and Codex connect with a token; claude.ai and Claude Desktop add it as a connector and sign in with OAuth.
- **Deliverability built in.** DKIM, a custom MAIL FROM domain and DMARC on your own domain, one-click unsubscribe headers, and double opt-in with Turnstile on the signup form. Bounces and complaints come off the list automatically.
- **Preflight before every send.** Sendoff checks your domain, your SES account and quota, and your latest test, and won't send until everything passes. Ask your agent to run `doctor` to see the checks any time.
- **Bring your list and your back catalog.** Import any provider's CSV export; imports never resubscribe anyone who unsubscribed, bounced or complained. Past issues come over exactly as they were sent, so nothing's lost.
- **Signups from your site.** A hosted signup page, plus a REST API with scoped keys and an OpenAPI description for your own forms.
- **Stats your agent can read.** Ask "how's my latest send doing?" for deliveries, clicks and unsubscribes in people, with security scanners filtered out, compared with your earlier issues. Clicks go through your own domain; opens are opt-in.
- **Sends you can stop and resume.** Sends go out in chunks through a queue. If SES pauses or a worker crashes, the send stops and picks up where it left off when you resume it, and nobody gets the issue twice.

## What it costs

| Service                 | Price                  |
| ----------------------- | ---------------------- |
| Cloudflare Workers Paid | $5 a month             |
| Amazon SES              | $0.10 per 1,000 emails |

Four issues a year to 6,000 subscribers is 24,000 emails, or $2.40 a year in SES. With Workers, that's about $62 a year in total, paid straight to Cloudflare and AWS.

## What it doesn't do

Sendoff sends to one list. It doesn't send transactional email, and there are no segments, automations, A/B tests, visual editor or team accounts.

## Repository

| Path | What |
| --- | --- |
| [`apps/app`](apps/app) | The Sendoff Worker: public pages, MCP server, REST API, live preview, send queue and email layout, plus the setup script |
| [`apps/web`](apps/web) | The website and docs at [sendoff.dev](https://sendoff.dev), built with [Blume](https://useblume.dev) |
| [`packages/create-sendoff`](packages/create-sendoff) | `bun create sendoff`, which clones the repo and runs setup |

[`SPEC.md`](SPEC.md) is the design: decisions, data model, MCP tools and the send pipeline.

## Development

```sh
bun install
bun run dev
```

To run the Worker on its own, with a local database and Turnstile's test keys:

```sh
cd apps/app
cp .dev.vars.example .dev.vars
bun run db:migrate
bun run dev
```

Open `http://localhost:8787/preview/sample` to see the email layout with sample content. From the root, `bun run check`, `bun run types` and `bun run test` lint, typecheck and test everything. See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the rest.

## Contributing

Bug reports, fixes and docs improvements are welcome. Read the [contributing guide](.github/CONTRIBUTING.md) first, and please report security issues [privately](.github/SECURITY.md).

## License

MIT © [Hayden Bleasel](https://github.com/haydenbleasel)
