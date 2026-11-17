---
"app": patch
---

`set_draft_meta` on an imported issue with nothing to change returns the issue as it is. It used to fail with a database error ("No values to set").
