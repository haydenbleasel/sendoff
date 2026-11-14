---
"app": patch
---

Pressing Ctrl+C while setup is working on a step (checking AWS, creating resources, deploying) exits with the cancelled code, 130, as it already did at a prompt. It exited with 0, so `bun create sendoff` reported a cancelled setup as finished.
