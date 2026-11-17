---
"app": patch
---

`doctor`, `prepare_send` and `update_settings` accept a sender on a subdomain of a domain verified in SES, like `news@mail.example.com` when `example.com` is verified. SES sends from a verified domain's subdomains, but Sendoff looked only for the exact domain, reported that it "isn't set up in SES" and blocked the send.
