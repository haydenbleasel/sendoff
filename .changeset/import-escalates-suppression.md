---
"app": patch
---

An import that lists an unsubscribed person as bounced or complained (or a bounced one as complained) now records the more serious status. It used to leave anyone already suppressed as they were, so importing a provider's complaints file after its main list left those people as plain unsubscribes, who can come back through a resubscribe link or the signup form. An import still never makes a suppression less serious or reactivates anyone.
