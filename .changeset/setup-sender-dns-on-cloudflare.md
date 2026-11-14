---
"app": patch
---

Setup adds SES's DNS records with the API token whenever the sender's domain is on Cloudflare, even if Sendoff's hostname is behind a Pages project, instead of listing them to add by hand. It works out the sender's domain from the hostname's zone lookup when that covers it, and looks it up otherwise, so a hostname on Cloudflare with the sender's domain elsewhere isn't asked for DNS permissions it can't use. The token prompt names the zone its DNS permissions are for (`example.com` for a sender on `mail.example.com`). Setup only adds records to an active zone in this account, and says why when it lists them by hand instead. It only checks the sender's domain while SES's records still need adding, so a finished instance isn't asked about it, and the token prompt for a new Turnstile widget asks for Turnstile alone.
