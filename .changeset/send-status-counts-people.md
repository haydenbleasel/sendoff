---
"app": patch
---

`send_status` counts bounces, complaints and unsubscribes in people, as `issue_stats` does, so the two report the same numbers. Someone whose mailbox was full and then bounced for good counts once, and addresses on SES's suppression list, which SES never tried, aren't counted as bounces.
