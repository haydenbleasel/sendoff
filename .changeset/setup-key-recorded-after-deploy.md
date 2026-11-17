---
"app": patch
---

Setup records a new AWS key as the Worker's only once a deploy has given the Worker its secret. It used to record it straight away, so if setup stopped before deploying (a Ctrl+C at a later prompt, or a failed deploy), the next run found the key in IAM and AWS secrets on the Worker, took them to be the same key, and never uploaded the new one. A Worker whose old key had been deleted then kept failing to send on every rerun. A key from a run that stopped early is now deleted and replaced on the next one.
