# Sendoff

A newsletter tool you deploy to your own Cloudflare and AWS accounts and run from Claude or Codex.

## Get started

```sh
bun create sendoff
```

That clones Sendoff, installs it and runs setup. See the [quickstart](https://sendoff.dev/docs/quickstart) for what you need first.

## Development

```sh
bun install
bun run dev
```

| Path | What |
| --- | --- |
| `apps/app` | The Sendoff Worker |
| `apps/web` | Docs site, built with [Blume](https://useblume.dev) |
| `packages/create-sendoff` | `bun create sendoff`, which clones the repo and runs setup |
