import { parseArgs } from "node:util";

export const DEFAULT_REPO = "https://github.com/haydenbleasel/sendoff.git";
export const DEFAULT_FOLDER = "sendoff";

export const USAGE = `Usage: bun create sendoff [folder] [options]

Clones Sendoff into a folder (./${DEFAULT_FOLDER} by default), installs it and runs
setup, which deploys it into your Cloudflare and AWS accounts. Run it again
in the same place to pick up where setup stopped.

Options:
  --repo <url>  Clone from another repo, such as your fork
  -h, --help    Show this help

Docs: https://sendoff.dev/docs/quickstart
`;

export type Command =
  | { kind: "help" }
  | { folder: string; kind: "create"; repo: string };

/** Reads the arguments after `bun create sendoff`. Throws on anything unknown. */
export const parseCommand = (args: string[]): Command => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    args,
    options: {
      help: { short: "h", type: "boolean" },
      repo: { type: "string" },
    },
  });

  if (values.help) {
    return { kind: "help" };
  }

  if (positionals.length > 1) {
    throw new Error(`Expected one folder, got ${positionals.length}.`);
  }

  return {
    folder: positionals[0] ?? DEFAULT_FOLDER,
    kind: "create",
    repo: values.repo ?? DEFAULT_REPO,
  };
};
