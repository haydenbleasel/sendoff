---
"app": patch
---

`POST /api/v1/subscribers` accepts an empty `name` and treats it as no name, so a signup form whose optional name field was left blank works instead of getting a 400.
