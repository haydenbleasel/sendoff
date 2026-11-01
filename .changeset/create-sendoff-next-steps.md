---
"create-sendoff": patch
---

The commands `bun create sendoff` prints at the end work in any shell, Windows PowerShell and `cmd` included: they use `bun run --cwd <folder> …` instead of `cd … && …`. Shipping an update now points at `bun run update`, which moves your folder to the latest release, instead of `git pull`, which can be ahead of it.
