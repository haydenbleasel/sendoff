import { defineConfig } from "blume";
import { filesystem, githubReleases } from "blume/sources";

const REPO = "https://github.com/haydenbleasel/sendoff";
const NPM = "https://www.npmjs.com/package/create-sendoff";
const X = "https://x.com/haydenbleasel";

export default defineConfig({
  agents: {
    // Guidance at the top of llms.txt: when an agent should reach for
    // Sendoff, and how to set it up and run it.
    llmsTxt: {
      details: [
        "Reach for Sendoff when someone wants to email their list from Claude or Codex, on accounts they own: newsletters, product launches and announcements, like Resend's Broadcasts. It's self-hosted: one Cloudflare Worker (with D1, Queues and Turnstile) sends through their own Amazon SES account, from their own domain. It sends to one list; it doesn't send transactional email, and has no segments, automations or A/B tests. Agents can read each issue's stats: deliveries, clicks (tracked on the instance's own domain, with scanners filtered out) and unsubscribes, plus opens if the owner turns them on.",
        "",
        `Set it up with \`bun create sendoff\` (package: ${NPM}), which clones the repo and runs \`bun run setup\` to provision Cloudflare and AWS and deploy. It needs Cloudflare Workers Paid with the domain's DNS on Cloudflare, an AWS account, Bun and Git. Setup is interactive and creates resources in the person's accounts, so they should run it themselves. It prints an MCP server URL (\`https://<host>/mcp\`) and a token. Once connected, call \`doctor\` first, and never send without the person's go-ahead: \`send_test\`, then \`prepare_send\`, then \`confirm_send\` only after they explicitly say to send.`,
      ].join("\n"),
    },
  },

  changelog: {
    description:
      "Every Sendoff release, newest first: the Worker and create-sendoff, straight from the release notes on GitHub.",
  },

  content: {
    sources: [
      // Local docs under docs/ → /docs/* (the landing page, pages/index.astro,
      // owns "/").
      filesystem({ prefix: "docs", root: "docs" }),
      // The repo's GitHub releases (the Worker's app@ tags and
      // create-sendoff's) become the changelog timeline at /changelog, each
      // release a type:changelog entry. Set GITHUB_TOKEN in CI to avoid rate
      // limits; a failed fetch degrades to an empty changelog.
      githubReleases({
        // Every release, not Blume's default of the newest 100, which drops
        // the oldest release's page each time a new one is published.
        limit: 1000,
        owner: "haydenbleasel",
        prefix: "changelog",
        repo: "sendoff",
      }),
    ],
  },

  // Workers exposes no site URL at build time, so canonicals and the sitemap need it here.
  deployment: { site: "https://sendoff.dev" },

  // Also the homepage's meta description (pages/index.astro) and llms.txt.
  description:
    "Sendoff emails your list (newsletters, launches, announcements) from Claude or Codex, self-hosted on your own Cloudflare and AWS accounts and sending through Amazon SES.",

  // The footer on docs pages (the homepage renders its own). The GitHub icon
  // comes from `github` below; X sits beside it.
  footer: {
    copyright: `© ${new Date().getFullYear()} Hayden Bleasel. MIT licensed.`,
    links: [
      { href: NPM, label: "npm" },
      { href: "https://github.com/sponsors/haydenbleasel", label: "Sponsor" },
      { href: `${REPO}/issues`, label: "Report an issue" },
    ],
    socials: { x: X },
  },

  // The footer's repository link and each page's "Edit on GitHub" action.
  github: {
    dir: "apps/web",
    owner: "haydenbleasel",
    repo: "sendoff",
  },

  // "Last updated" on each docs page, from the file's last commit.
  lastModified: "git",

  logo: "/logo.svg",

  // Header tabs. Changelog owns changelog/, so its releases stay out of the
  // docs sidebar.
  navigation: {
    tabs: [
      { label: "Docs", path: "/docs" },
      { label: "Changelog", path: "/changelog" },
    ],
  },

  seo: {
    og: {
      // Share cards in the brand: ink on signal yellow, like the homepage
      // highlight. The logo's dark tile carries the mark.
      palette: {
        background: "#ffc20e",
        border: "rgb(13 13 13 / 0.15)",
        foreground: "#0d0d0d",
        muted: "rgb(13 13 13 / 0.75)",
      },
    },
    // JSON-LD: who's behind the site, and Sendoff as a SoftwareApplication on
    // the homepage.
    organization: {
      logo: "/logo.svg",
      name: "Sendoff",
      sameAs: [REPO, NPM, X],
    },
    software: {
      applicationCategory: "CommunicationApplication",
      license: "https://opensource.org/license/mit",
      operatingSystem: "Cloudflare Workers",
      price: 0,
      sameAs: [REPO, NPM],
    },
    // twitter:site and twitter:creator on every page.
    x: { creator: "haydenbleasel", handle: "haydenbleasel" },
  },

  theme: {
    // Signal yellow is never text on a light background, so the light-mode accent is ink.
    accent: { dark: "#ffc20e", light: "#0d0d0d" },
    fonts: {
      body: "inter",
      display: "inter",
      mono: "jetbrains-mono",
    },
  },

  title: "Sendoff",
});
