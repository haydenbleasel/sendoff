---
"app": patch
---

A tracked link keeps its address when it has both a non-Latin character and a percent escape. A link like `https://example.com/日本?q=a%20b` was redirected to `…?q=a%2520b`, so the page got the wrong query. With click tracking off, the same link already worked.
