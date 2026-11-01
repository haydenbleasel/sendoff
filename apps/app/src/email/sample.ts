import type { Settings } from "../settings";
import type { IssueContent } from "./render";

// Example content for the template preview. It uses every supported block
// so design changes can be checked in one place.

export const sampleSettings: Settings = {
  accent: "#2563eb",
  address: "123 Example Street, Sydney NSW 2000, Australia",
  from: { email: "hello@example.com", name: "Sendoff" },
  links: [
    { label: "Website", url: "https://example.com" },
    { label: "X", url: "https://x.com/example" },
    { label: "GitHub", url: "https://github.com/example" },
  ],
  name: "The Sendoff Quarterly",
  tracking: { clicks: true, opens: false },
};

export const sampleIssue: IssueContent = {
  body: `# What I shipped this quarter

Three months goes quickly. Here's what happened, what I learned, and a few things I'm excited about for the rest of the year. As always, you can [reply to this email](mailto:hello@example.com) and it comes straight to me.

![A desk with a laptop and a cup of coffee](https://images.unsplash.com/photo-1498050108023-c5249f4df085?w=1120&q=80)

## Sendoff is live

I replaced a paid newsletter tool with a tiny Worker that sends through Amazon SES. It costs about **$2.40 a year** to send this email to everyone on the list, and I write it by talking to an agent.

::button[Read the announcement]{href="https://example.com/sendoff"}

A few things that made it work:

- One fixed template, so every issue looks considered without any design work
- Markdown for content, with \`::button\` and \`:::callout\` for the rest
- A send flow that refuses to go out until you've seen a test

:::callout[Why not just use a hosted tool?]
For a list this size, sending four times a year, the hosted options cost hundreds of dollars for what is mostly an unsubscribe link and a bounce handler.
:::

## Things worth reading

> The best way to have a good idea is to have a lot of ideas, and throw away the bad ones.

1. **Deliverability basics.** SPF, DKIM and DMARC, explained without the jargon.
2. **One-click unsubscribe.** Why Gmail started requiring it, and how it works.
3. **Plain text matters.** Every email still ships with a text version.

### A small code example

\`\`\`ts
await send({ issue: "q4-2026", audience: "everyone" });
\`\`\`

---

That's it for this quarter. Thanks for reading, and see you in the new year.

Hayden`,
  preheader: "A cheaper newsletter, a few good reads, and what's next.",
  subject: "What I shipped this quarter",
};
