# Contributing to Sendoff

Thanks for helping out. Bug reports, fixes and docs improvements are all welcome. For anything bigger, like a new MCP tool or a change to how sending works, please [open an issue](https://github.com/haydenbleasel/sendoff/issues/new/choose) first so we can agree on the approach before you write the code.

## Scope

Sendoff does one thing on purpose: it runs one newsletter with one list, from an agent. These are out of scope, so pull requests that add them won't be merged:

- Transactional email
- Segments, automations and A/B tests
- Open tracking
- A visual editor, custom email templates or an admin dashboard. There's one fixed layout, and brand settings (like the accent color) live in the database, edited through MCP.
- Team accounts, multiple newsletters or multiple lists
- Dedicated IPs

## The codebase

Sendoff is a Bun and Turborepo monorepo:

- `apps/app` is the Sendoff Worker, which runs on Cloudflare Workers with D1, Queues and KV and sends through Amazon SES.
  - `src/db/schema.ts` is the Drizzle schema, with migrations in `migrations/`.
  - `src/email/` turns Markdown into the fixed React Email layout.
  - `scripts/setup.ts` is `bun run setup`, which provisions and deploys an instance.
- `apps/web` is the website and docs at [sendoff.dev](https://sendoff.dev), built with [Blume](https://useblume.dev). Docs pages are MDX in `apps/web/docs/`; each folder's `meta.ts` sets the sidebar order.
- `packages/create-sendoff` is the npm package behind `bun create sendoff`.

Two files are worth reading before you start:

- [`SPEC.md`](../SPEC.md) is the design: decisions, data model, MCP tools, send pipeline and setup flow. If you change how something behaves, update the spec in the same pull request.
- [`AGENTS.md`](../AGENTS.md) is a map of the repo and its conventions. It's written for coding agents, but it's just as useful for people.

## Getting started

1. Fork the repo and clone your fork.
2. Install dependencies with `bun install`. The Bun version is pinned in `package.json`'s `packageManager` field.
3. Run the Worker locally:

   ```sh
   cd apps/app
   cp .dev.vars.example .dev.vars
   bun run db:migrate
   bun run dev
   ```

   That serves it at `http://localhost:8787` with a local database and Turnstile's test keys. Open `/preview/sample` to see the email layout. To send real test emails, put AWS keys for an SES account in `.dev.vars`.

4. Run the docs site with `bun run dev --filter web`. It serves at `http://localhost:4321`.

## Checks

From the repo root:

| Command | What it does |
| --- | --- |
| `bun run fix` | Formats and fixes lint issues with Ultracite |
| `bun run check` | Lints and checks formatting |
| `bun run types` | Typechecks with tsgo |
| `bun run test` | Runs the tests (the Worker's run inside workerd, the Workers runtime) |
| `bun run build` | Builds the docs site and `create-sendoff` |

The pre-commit hook runs `bun run fix` on staged files, and CI runs `check`, `types`, `test` and `build` on every pull request.

## Making changes

- **Database:** after changing `src/db/schema.ts`, run `bun run db:generate` in `apps/app` and commit the new migration. Apply it locally with `bun run db:migrate`.
- **Worker config:** after changing `apps/app/wrangler.jsonc`, run `bun run typegen` in `apps/app`. `bun run types` fails if `worker-configuration.d.ts` is stale.
- **Email layout:** check the change at `/preview/sample` in light and dark mode, and run `bun run bench` in `apps/app` to make sure rendering stays inside the Workers CPU limit.
- **MCP tools and the REST API:** update the reference pages in `apps/web/docs/reference/` along with the code.
- **Setup:** never run `bun run setup` against someone else's Cloudflare or AWS accounts. Test the pure parts, and run the real thing against accounts of your own.
- **`create-sendoff`:** test it end to end with `--repo <path>` pointing at a local repo whose `setup` script is harmless, like `echo`, so it never touches real accounts.
- **Docs:** keep the writing short and plain, like the pages around it.

## Pull requests

- Keep each pull request focused on one change.
- Explain what changed and why, and link the issue it closes.
- Add or update tests for behavior changes.
- Update the docs and `SPEC.md` when behavior changes.
- Add screenshots when the email layout or a page changes.

## Reporting bugs

Use the [issue forms](https://github.com/haydenbleasel/sendoff/issues/new/choose), and check for an existing issue first. Please don't paste your MCP token, API keys, AWS keys or subscribers' email addresses.

Report security vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## Code of conduct

This project follows a [code of conduct](CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.
