---
"app": patch
---

A send now stops, ready for `resume_send`, when SES's daily quota runs out or its configuration set is missing. Before, a used-up quota kept retrying every recipient as throttled for up to a day, and a missing configuration set marked everyone left as failed. SES's `ThrottlingException` is also retried like any other rate limit, instead of failing the recipient.
