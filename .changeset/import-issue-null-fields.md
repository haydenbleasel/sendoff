---
"app": patch
---

Importing past issues accepts `null` for `text`, `preheader` and `slug`, and treats it as left out. A provider's API gives null for an issue with no preheader or plain text, so piping its response to `/api/v1/issues/import` was refused with a 400 for the whole batch.
