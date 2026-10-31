import { defineConfig } from "blume";

export default defineConfig({
  // The landing page owns `/` (pages/index.astro), so the docs mount under /docs.
  basePath: "/docs",
  description: "Self-hosted newsletters you run from Claude or Codex.",
  logo: "/logo.svg",
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
