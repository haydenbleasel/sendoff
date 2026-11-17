---
"app": patch
---

`issue_stats` and `send_status` no longer count a complaint that SES reports from its suppression list. SES sends one when an address is on your account's suppression list for an earlier complaint: it accepted the email but never tried to deliver it, and nobody complained about this issue. Those people are counted as suppressed, as suppression-list bounces already are, so a newly imported list doesn't set off the complaint-rate warning.
