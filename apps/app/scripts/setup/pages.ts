import type { DnsRecord } from "./dns";
import type { BaseConfig, Instance } from "./instance";

// A Workers Custom Domain only works on a hostname whose DNS is on
// Cloudflare. When it's somewhere else, a Pages project fronts the Worker
// instead: a Pages custom domain works with one CNAME at any DNS provider,
// and its _worker.js hands every request to the Worker over a service
// binding, which adds no cost or latency.

/** Not "sendoff": sharing the Worker's name, its service binding resolves to itself in `wrangler pages dev`. */
export const PAGES_PROJECT = "sendoff-pages";
export const PAGES_BRANCH = "main";

/** The Pages project's whole job: pass each request, unchanged, to the Worker. */
export const PAGES_WORKER =
  "export default { fetch: (request, env) => env.SENDOFF.fetch(request) };\n";

/** The Wrangler config `wrangler pages deploy` reads, next to dist/_worker.js. */
export const pagesConfig = (
  base: BaseConfig,
  instance: Instance,
  project: string
): BaseConfig => ({
  compatibility_date: base.compatibility_date,
  name: project,
  pages_build_output_dir: "./dist",
  services: [{ binding: "SENDOFF", service: instance.workerName }],
});

/** A row of `wrangler pages project list --json`. */
export interface PagesProjectRow {
  "Project Domains": string;
  "Project Name": string;
}

/** The project's `*.pages.dev` hostname, which isn't always its name (they're global). */
export const pagesSubdomain = (
  rows: PagesProjectRow[],
  project: string
): string | undefined =>
  rows
    .find((row) => row["Project Name"] === project)
    ?.["Project Domains"].split(",")
    .map((domain) => domain.trim())
    .find((domain) => domain.endsWith(".pages.dev"));

export const pagesCnameRecord = (
  hostname: string,
  subdomain: string
): DnsRecord => ({
  content: subdomain,
  name: hostname,
  purpose: "Sends your Sendoff hostname to its Cloudflare Pages project",
  type: "CNAME",
});
