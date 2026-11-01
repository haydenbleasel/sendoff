---
"app": patch
---

Updates Hono to 4.13.16, a security release. Only one of its fixes reached Sendoff: a request for a page that doesn't exist, with an encoded line break in its path, got its "404 Not Found" reply without the security headers and `no-store` caching that every other page gets. Sendoff doesn't use the features the other fixes cover.
