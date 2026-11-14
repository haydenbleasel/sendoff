---
"create-sendoff": patch
---

Run without a terminal (in CI, or from an agent's shell) while the AWS CLI is missing or logged out, `bun create sendoff` says to log in and exits with 1. It used to ask whether to continue, get no answer, and die with Node's "unsettled top-level await" warning and exit code 13.
