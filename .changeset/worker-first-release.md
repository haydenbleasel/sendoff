---
"app": major
---

First release. The Sendoff Worker emails your list from your own Cloudflare and AWS accounts: newsletters, product launches and announcements, drafted and sent by your agent over MCP. It serves the signup page, unsubscribe links, the MCP server and a small REST API, sends through Amazon SES, and keeps subscribers and issues in D1. Deploy it with `bun create sendoff`, and update it with `git pull` and `bun run deploy`.
