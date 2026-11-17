---
"app": patch
---

Cancelling a send that had stopped on an error no longer tells the agent to "fix the cause, then call resume_send". A cancelled send can't be resumed, so `cancel_send` and `send_status` now just say what it had stopped on.
