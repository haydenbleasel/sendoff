---
"app": patch
---

A button or callout that's written slightly wrong is reported as a problem with its line number, instead of being sent as plain text. `::button[Go](https://example.com)`, a button with text after it, `:::callout Heads up` and a stray `:::` all used to pass, and readers got the literal `::button` or `:::` in their email.
