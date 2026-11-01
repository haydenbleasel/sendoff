---
"app": patch
"web": patch
---

Setup works when your domain's DNS isn't on Cloudflare. It checks where the hostname's DNS is, and if it's elsewhere, it puts a small Cloudflare Pages project in front of the Worker and lists one more CNAME to add with the SES records. Domains on Cloudflare work as before. The docs explain the difference.
