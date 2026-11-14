# app

## 1.0.1

### Patch Changes

- 220aa64: Confirming a signup now takes a press of **Confirm subscription** on the page the email's link opens. Before, opening the link was enough, so a mail filter that opens every link in an email (like Microsoft Safe Links) could confirm a signup the address's owner never made.
- b1cbbc0: Updates Hono to 4.13.16, a security release. Only one of its fixes reached Sendoff: a request for a page that doesn't exist, with an encoded line break in its path, got its "404 Not Found" reply without the security headers and `no-store` caching that every other page gets. Sendoff doesn't use the features the other fixes cover.
- 8a1df5a: Emails keep their spacing in Outlook for Windows: the margin above the masthead, below the footer and either side of the text. Outlook only applies padding to table cells, and the layout had put it on a table, so Outlook dropped it.
- 777f0cf: Quotes and code blocks keep their spacing in Outlook for Windows: a quote's text no longer sits right against its bar, and code no longer touches the edges of its grey box.
- da31e47: `send_status` counts bounces, complaints and unsubscribes in people, as `issue_stats` does, so the two report the same numbers. Someone whose mailbox was full and then bounced for good counts once, and addresses on SES's suppression list, which SES never tried, aren't counted as bounces.
- ecafb7f: When setup gives the Worker a new AWS key, it lists any old keys left on the `sendoff` IAM user, with when each was last used, so you can delete the stale one. If both of the user's two allowed keys are taken, setup stops and says which they are, instead of failing at "create access key". It never deletes them itself, since another Sendoff instance in the same AWS account could be using one.

## 1.0.0

### Major Changes

- fcb1b6a: First release. The Sendoff Worker emails your list from your own Cloudflare and AWS accounts: newsletters, product launches and announcements, drafted and sent by your agent over MCP. It serves the signup page, unsubscribe links, the MCP server and a small REST API, sends through Amazon SES, and keeps subscribers and issues in D1. Deploy it with `bun create sendoff`, and update it with `git pull` and `bun run deploy`.

### Patch Changes

- 8350e95: `add_subscriber` no longer tells your agent that an address that bounced or complained can sign up again from the subscribe page. Only people who unsubscribed can.
- 6f0eacf: `POST /api/v1/subscribers` accepts an empty `name` and treats it as no name, so a signup form whose optional name field was left blank works instead of getting a 400.
- 22bda95: `cancel_send` stops the batch of up to 50 emails that's going out when you cancel, not just the batches after it. Recipients it hadn't reached are skipped, so `send_status` no longer shows them as still to go.
- c649c25: Someone who unsubscribed, then signed up again and confirmed, no longer shows an unsubscribe date in `search_subscribers`.
- 8995488: CSV imports read Ghost's `subscribed_to_emails` column, so members who turned off emails in Ghost import as unsubscribed instead of active.
- 9129ae0: CSV imports read a quoted cell that comes after a space, like `a@example.com, "Doe, Jane", false`. Before, the comma inside the quotes split the cell and shifted every column after it, so an opt-out flag could be misread and the person imported as active.
- f692b3a: Running Sendoff locally works as the docs describe: copying `.dev.vars.example` to `.dev.vars` gives the Worker the values it needs to start, so `/preview/sample` loads before you add any AWS keys.
- 3d974d1: Setup works when your domain's DNS isn't on Cloudflare. It checks where the hostname's DNS is, and if it's elsewhere, it puts a small Cloudflare Pages project in front of the Worker and lists one more CNAME to add with the SES records. Domains on Cloudflare work as before. See [Domains outside Cloudflare](https://sendoff.dev/docs/reference/setup#domains-outside-cloudflare).
- 4feda1a: `create_draft` refuses a subject that's only spaces, like `set_draft_meta` already does, instead of saving a draft with an empty subject.
- 776560d: An edit to a draft that lands just after `confirm_send` is refused instead of saved, so it can't change the subject of an issue that's already going out. Deleting a draft that started sending at the same moment says so instead of reporting it deleted.
- fe90d52: When an import lists the same address more than once, the most serious status wins: complained, then bounced, then unsubscribed. Before, a later "unsubscribed" row replaced a complaint, which a resubscribe link could then undo.
- e8e3d97: An image inside a line of text, like a small badge or icon, now shows at its own size within the text. Only an image on a line of its own spans the full width, as the writing guide says.
- 06b43b9: Connecting claude.ai or Claude Desktop with a request Sendoff can't accept now sends the error back to the app instead of showing "Internal Server Error". The sign-in and consent pages, and the redirects that carry an authorization code, are also never cached now.
- 54be9e7: Plain text made from an imported issue's HTML no longer keeps the contents of a script, style or comment that's nested or malformed, or an unclosed tag at the end.
- 83b7c61: The unsubscribe page only offers Resubscribe to people who unsubscribed. An address that bounced or complained isn't offered it any more, since it can't be undone, and if someone uses an old Resubscribe link anyway, the page says they can't be resubscribed instead of claiming they're back on the list.
- f04007d: `resume_send` checks SES's quota against the recipients the send still has to reach, so a send that stopped near the end can resume without room for the whole list. It also refuses a send that's still going, instead of starting a second queue chain alongside it.
- 8a034ba: A send now stops, ready for `resume_send`, when SES's daily quota runs out or its configuration set is missing. Before, a used-up quota kept retrying every recipient as throttled for up to a day, and a missing configuration set marked everyone left as failed. SES's `ThrottlingException` is also retried like any other rate limit, instead of failing the recipient.
- f2c168a: Clearing the postal address, description or reply-to from an agent that sends the text "null" instead of null now clears it, instead of printing "null" in every email's footer. A postal address of "null" also switched off the check for commercial email.
- 8d51b79: Pressing Ctrl+C stops setup while it's waiting, such as for DNS or SES to verify your domain, instead of only stopping the spinner. A cancelled setup also exits with an error code, so `bun create sendoff` shows how to pick up where it stopped instead of reporting setup finished.
- 97e2f3a: Setup and `bun run deploy` use the Cloudflare account you pick in setup. With a login that has several accounts, setup used to stop at "Creating the D1 database failed", or put the database, queue and Worker in whichever account Wrangler last used.
- 0ee8f18: When you send from a subdomain, like `hello@news.example.com`, setup counts the parent domain's DMARC record, as `doctor` does. It no longer adds a `p=none` record for the subdomain, which would have weakened a stricter policy on the parent.
- 33ad317: Running `bun run setup` again keeps the Worker's secrets. Before, setup never saw them, so every rerun made a new `TOKEN_SECRET`, which breaks the unsubscribe, confirmation and tracked links in every email already sent. It also made a new MCP token, disconnecting your agents, and replaced the Worker's AWS key. Setup now stops if it can't tell which secrets the Worker has, instead of assuming it has none.

  If you've already run setup again on a live instance, the links in emails sent before that run stopped working: their unsubscribe links show "This link isn't valid". Emails sent since then are fine.

- a386300: Running `bun run setup` again keeps your settings. Setup only fills them in the first time, so a rerun no longer replaces footer links your agent added, or puts back the name and sender from your first setup. If you give setup a different sender this time, it tells you to ask your agent to switch to it. Setup also says when saving the first settings fails, instead of reporting them saved.
- 0f0c27c: Bounce and complaint reports from SES are no longer lost when Amazon SNS's signing certificate can't be fetched for a moment: Sendoff asks SNS to send them again instead of rejecting them. It also only trusts certificates from the SNS endpoint in your topic's region.
- af62966: `issue_stats` warns about bounces using hard bounces only, as SES does when it reviews an account, so full mailboxes and out-of-office replies no longer trigger a warning that the list needs cleaning.
- b7f6496: `issue_stats` labels its numbers accurately. For a cancelled send, the skipped count no longer says everyone skipped left the list mid-send, and the click rate says it's "of sent", not "of delivered", until SES reports a delivery.
- 0bc0620: A bounce or complaint from a test email no longer counts against the issue, so a mistyped test address doesn't show up in `send_status` or raise the bounce rate in `issue_stats`.
- b012054: Tool descriptions and messages match what Sendoff does. `send_test` says it emails the reply-to address first. `confirm_send` says a send that hit an error starting is picked up within 10 minutes, not 5. `import_csv` and the REST API's import say a plain list of addresses works without a header row. And `doctor`'s message about a missing configuration set reads properly.
- 5223eaa: `bun run update` moves your Sendoff folder to the latest release and deploys it. It shows the release notes for every version since yours first, and stops without changing anything if the folder has uncommitted changes or commits of its own.
