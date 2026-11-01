---
"app": patch
---

Running `bun run setup` again keeps the Worker's secrets. Before, setup never saw them, so every rerun made a new `TOKEN_SECRET`, which breaks the unsubscribe, confirmation and tracked links in every email already sent. It also made a new MCP token, disconnecting your agents, and replaced the Worker's AWS key. Setup now stops if it can't tell which secrets the Worker has, instead of assuming it has none.

If you've already run setup again on a live instance, the links in emails sent before that run stopped working: their unsubscribe links show "This link isn't valid". Emails sent since then are fine.
