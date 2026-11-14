---
"app": patch
---

If setup can't read or save the settings at the end, it runs the preflight checks and then stops with the reason, instead of saying Sendoff is live while its signup and unsubscribe pages may not work. Before, a read error was reported as keeping settings that may not exist. If you keep your MCP token without pasting it, setup can't check the settings, so it says Sendoff is deployed rather than live and points you to `doctor`.
