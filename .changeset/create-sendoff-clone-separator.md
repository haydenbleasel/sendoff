---
"create-sendoff": patch
---

`--repo` can't pass options to `git clone`: a value that starts with a dash is always read as the repository.
