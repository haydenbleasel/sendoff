---
"app": patch
---

`resume_send` checks SES's quota against the recipients the send still has to reach, so a send that stopped near the end can resume without room for the whole list. It also refuses a send that's still going, instead of starting a second queue chain alongside it.
