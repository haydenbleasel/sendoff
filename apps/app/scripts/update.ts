// `bun run update`: move this clone to the latest Worker release and deploy
// it. Pulling main instead runs code that may not be released yet, whose
// release notes (and any steps they ask for) don't exist yet.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
  outro,
} from "@clack/prompts";

import { APP_DIR } from "./setup/files";
import {
  compareVersions,
  formatVersion,
  latestRelease,
  parseVersion,
  releaseNotes,
} from "./setup/releases";
import type { Version } from "./setup/releases";

const REPO_DIR = path.resolve(APP_DIR, "../..");
const UNRELEASED: Version = [0, 0, 0];
const LOCKFILE = "bun.lock";

const git = (args: string[]) => {
  const result = spawnSync("git", args, { cwd: REPO_DIR, encoding: "utf-8" });

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    stdout: (result.stdout ?? "").trim(),
  };
};

/** Run a command in front of the person, for its progress and errors. */
const run = (command: string, args: string[], cwd: string): boolean =>
  spawnSync(command, args, { cwd, stdio: "inherit" }).status === 0;

const fail = (message: string): never => {
  log.error(message);
  process.exit(1);
};

const currentVersion = (): Version => {
  const { version }: { version?: string } = JSON.parse(
    readFileSync(path.join(APP_DIR, "package.json"), "utf-8")
  );

  return parseVersion(version ?? "") ?? UNRELEASED;
};

const main = async () => {
  intro("Sendoff update");

  // Tracked files changed since the last commit, staged or not.
  const changed = git(["diff", "--name-only", "HEAD"])
    .stdout.split("\n")
    .filter(Boolean);

  if (changed.some((file) => file !== LOCKFILE)) {
    fail(
      "This folder has uncommitted changes. Commit or stash them, then run `bun run update` again."
    );
  }

  // `bun install` rewrites the lockfile (with another Bun version, say), so
  // it isn't a change of the person's own. The install below remakes it.
  if (changed.includes(LOCKFILE)) {
    git(["checkout", "--", LOCKFILE]);
  }

  const fetched = git(["fetch", "--tags", "--quiet"]);

  if (!fetched.ok) {
    fail(`Couldn't fetch Sendoff's releases:\n${fetched.output}`);
  }

  const latest =
    latestRelease(git(["tag", "--list", "app@*"]).stdout.split("\n")) ??
    fail("There's no Worker release to update to yet.");

  const target = formatVersion(latest.version);
  const head = git(["rev-parse", "HEAD"]).stdout;
  const release = git(["rev-parse", `${latest.tag}^{commit}`]).stdout;

  if (head === release) {
    outro(`Already on the latest release, ${target}.`);

    return;
  }

  // Never move backwards: the database may have migrations the release doesn't know.
  if (git(["merge-base", "--is-ancestor", latest.tag, "HEAD"]).ok) {
    outro(
      `This folder is ahead of the latest release (${target}), with changes that aren't released yet. There's nothing to update to.`
    );

    return;
  }

  if (!git(["merge-base", "--is-ancestor", "HEAD", latest.tag]).ok) {
    fail(
      `This folder has commits of its own, so it can't move straight to ${target}. Merge the release yourself (\`git merge ${latest.tag}\`), then run \`bun install\` and \`bun run deploy\`.`
    );
  }

  const current = currentVersion();
  const changelog = git(["show", `${latest.tag}:apps/app/CHANGELOG.md`]);

  const notes = changelog.ok
    ? releaseNotes(changelog.stdout, current, latest.version)
    : "";

  if (notes) {
    note(
      notes,
      compareVersions(current, UNRELEASED) === 0
        ? "What's in this release"
        : `What's new since ${formatVersion(current)}`
    );
  }

  const go = await confirm({ message: `Update to ${target} and deploy it?` });

  if (isCancel(go) || !go) {
    cancel("Nothing changed.");

    return;
  }

  const merged = git(["merge", "--ff-only", "--quiet", latest.tag]);

  if (!merged.ok) {
    fail(`Moving to ${target} failed:\n${merged.output}`);
  }

  log.success(`Moved to ${target}.`);

  if (!run("bun", ["install"], REPO_DIR)) {
    fail(
      "Installing dependencies failed. Fix the problem above, then run `bun install` and `bun run deploy`."
    );
  }

  // A new process, so the deploy runs the release's code, not this script's.
  if (!run("bun", ["run", "deploy"], APP_DIR)) {
    fail(
      "Deploying failed. Your folder is on the new release; fix the problem above, then run `bun run deploy`."
    );
  }

  outro(
    notes
      ? `Sendoff is on ${target}. If the notes above ask for anything else, like running setup again, do that now.`
      : `Sendoff is on ${target}.`
  );
};

await main();
