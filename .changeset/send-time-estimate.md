---
"app": patch
---

`prepare_send` rounds its time estimate to the nearest minute instead of rounding up twice, so 6,000 subscribers at 14 emails a second is "about 7 minutes" (it takes just over 7), not 8. A send of about a minute says "about 1 minute", not "about 1 minutes".
