---
"app": patch
---

CSV imports read a quoted cell that comes after a space, like `a@example.com, "Doe, Jane", false`. Before, the comma inside the quotes split the cell and shifted every column after it, so an opt-out flag could be misread and the person imported as active.
