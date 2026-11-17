---
"app": patch
---

`set_draft_meta` clears the preheader when a client sends the string `"null"`, as `update_settings` already does for its optional text. Some clients can't send a real null, so the issue went out with "null" as its preview text.
