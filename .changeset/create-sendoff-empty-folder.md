---
"create-sendoff": patch
---

An empty folder name, like an unset `"$DIR"` in a script, means the default `./sendoff` again. It resolved to the folder you were standing in, so Sendoff was cloned straight into it when it was empty.
