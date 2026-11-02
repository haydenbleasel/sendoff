---
"app": patch
---

If setup can't read or save the settings at the end, it runs the preflight checks and then stops with the reason, instead of saying Sendoff is live while its signup and unsubscribe pages don't work. Before, a read error was reported as keeping settings that may not exist.
