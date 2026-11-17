---
"app": patch
---

The plain text made for an imported issue keeps a link's address when its `href` is in single quotes. Only double-quoted links were read, so `<a href='https://example.com'>Read it</a>` became "Read it" with nowhere to go.
