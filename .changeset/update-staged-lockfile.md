---
"app": patch
---

`bun run update` gets past a `bun.lock` change that's been staged (after `git add -A`, say). It only discarded an unstaged one, so the staged change stayed and the update stopped with "Moving to … failed" whenever the release changed the lockfile too.
