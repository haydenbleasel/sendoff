---
"app": patch
---

When Cloudflare won't let setup create the Turnstile widget, setup says why and asks for the widget's keys instead. It used to crash with a stack trace, on every rerun too, which happens with an API token that has the DNS permissions but not Turnstile's.
