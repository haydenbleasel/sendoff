---
"app": patch
---

When Cloudflare turns down one of SES's DNS records, setup lists it to add by hand with Cloudflare's reason, and carries on with the rest. It used to crash with a stack trace, on every rerun too. That happens when the API token can read the zone but not edit its DNS, or when the name already has a record of another type, like a CNAME another email provider left at `bounce.<your domain>`.
