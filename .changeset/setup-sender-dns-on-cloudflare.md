---
"app": patch
---

When Sendoff's hostname is behind a Pages project but the sender's domain is on Cloudflare, setup adds SES's DNS records with the API token instead of listing them to add by hand. The token prompt names the domain its DNS permissions are for, and if the token can't see that domain's zone, setup says so before listing the records. Setup only checks the sender's domain when the token prompt or the DNS step needs it, so a finished instance isn't asked about it on every run.
