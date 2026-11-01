---
"app": patch
---

When you send from a subdomain, like `hello@news.example.com`, setup counts the parent domain's DMARC record, as `doctor` does. It no longer adds a `p=none` record for the subdomain, which would have weakened a stricter policy on the parent.
