---
"create-sendoff": patch
---

Pressing Ctrl+C while `bun create sendoff` is checking the AWS CLI, cloning or installing exits with 130 and stops the command it was waiting on. It exited with 0, as if it had worked, and left the clone or install to finish on its own.
