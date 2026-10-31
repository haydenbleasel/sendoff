import { defineConfig } from "blume";

export default defineConfig({
  // The landing page owns `/` (pages/index.astro), so the docs mount under /docs.
  basePath: "/docs",
  // Workers exposes no site URL at build time, so canonicals and the sitemap need it here.
  deployment: { site: "https://sendoff.dev" },
  description: "Self-hosted newsletters you run from Claude or Codex.",
  logo: "/logo.svg",
  // No docs to search yet; turn this back on when the docs land.
  search: false,
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
