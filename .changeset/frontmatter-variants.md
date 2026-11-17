---
"app": patch
---

Frontmatter is caught when it follows a blank line, has spaces after its `---` fences, or quotes its keys. Those slipped through and were sent as a divider and a heading reading `title: …`. A body that opens with a divider and a line with a colon in it is no longer mistaken for frontmatter because of a second divider further down.
