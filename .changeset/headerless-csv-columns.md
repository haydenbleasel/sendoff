---
"app": patch
---

A CSV with no header row but more than one column is refused, with a message asking for a header row. It used to be read as a plain list of addresses, ignoring the other columns, so a row like `jane@example.com,unsubscribed` was imported as an active subscriber. A plain list of addresses still imports without a header, as does a headerless file imported with a `status`.
