---
"app": patch
---

When setup gives the Worker a new AWS key, it lists any old keys left on the `sendoff` IAM user, with when each was last used, so you can delete the stale one. If both of the user's two allowed keys are taken, setup stops and says which they are, instead of failing at "create access key". It never deletes them itself, since another Sendoff instance in the same AWS account could be using one.
