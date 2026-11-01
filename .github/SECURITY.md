# Security policy

## Supported versions

Sendoff is self-hosted, so fixes land on `main` and in the latest `create-sendoff`. Only those are supported. To update your instance, run this from your Sendoff folder:

```sh
git pull && bun install && bun run deploy
```

## Reporting a vulnerability

Please don't open a public issue for security vulnerabilities.

Report them privately through GitHub's [Report a vulnerability](https://github.com/haydenbleasel/sendoff/security/advisories/new) form. Include what's affected, how to reproduce it, and what an attacker could do with it. You'll get a response as soon as possible, and the report stays in a private advisory until a fix is released.

In scope: the Worker (public pages, the MCP server and its OAuth flow, the REST API, the SES webhook and the live preview), the setup and deploy scripts, and `create-sendoff`. Issues in Cloudflare or AWS themselves should go to [Cloudflare](https://hackerone.com/cloudflare) or [AWS](https://aws.amazon.com/security/vulnerability-reporting/).

## If your instance's credentials leak

- **MCP token:** run `bun run setup` again and choose to create a new one. The old token stops working as soon as the new one is deployed. See [Connect your agent](https://sendoff.dev/docs/connect).
- **REST API key:** ask your agent to revoke it with `revoke_api_key`, then create a new one.
- **The Worker's AWS key:** delete it in IAM, then run `bun run setup` again to create a new one.
