---
"app": patch
---

`cancel_send` stops the batch of up to 50 emails that's going out when you cancel, not just the batches after it. Recipients it hadn't reached are skipped, so `send_status` no longer shows them as still to go.
