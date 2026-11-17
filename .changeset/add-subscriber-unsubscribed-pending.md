---
"app": patch
---

`add_subscriber` with `skipConfirmation` no longer makes someone active if they unsubscribed and their address was then entered in the signup form. That left them pending, which the tool took for an ordinary unconfirmed signup, so it re-added a person who had unsubscribed without their say. They get a confirmation email instead, and are active once they confirm.
