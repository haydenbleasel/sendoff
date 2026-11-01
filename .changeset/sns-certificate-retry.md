---
"app": patch
---

Bounce and complaint reports from SES are no longer lost when Amazon SNS's signing certificate can't be fetched for a moment: Sendoff asks SNS to send them again instead of rejecting them. It also only trusts certificates from the SNS endpoint in your topic's region.
