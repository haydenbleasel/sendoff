---
"app": patch
---

`create_draft` refuses a subject that's only spaces, like `set_draft_meta` already does, instead of saving a draft with an empty subject.
