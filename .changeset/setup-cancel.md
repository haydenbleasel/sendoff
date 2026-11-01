---
"app": patch
---

Pressing Ctrl+C stops setup while it's waiting, such as for DNS or SES to verify your domain, instead of only stopping the spinner. A cancelled setup also exits with an error code, so `bun create sendoff` shows how to pick up where it stopped instead of reporting setup finished.
