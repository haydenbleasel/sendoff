// Worker releases are the git tags Changesets makes, like app@1.2.3, and
// their notes are the matching sections of apps/app/CHANGELOG.md.

export type Version = readonly [number, number, number];

const VERSION = /^(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)$/u;
const RELEASE_TAG_PREFIX = "app@";
const VERSION_HEADING = /^## (?<version>\S+)\s*$/u;

/** A stable x.y.z version; prereleases like 1.2.0-next.0 don't count. */
export const parseVersion = (value: string): Version | null => {
  const groups = VERSION.exec(value.trim())?.groups;

  return groups
    ? [Number(groups.major), Number(groups.minor), Number(groups.patch)]
    : null;
};

export const compareVersions = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

export const formatVersion = (version: Version): string => version.join(".");

/** The newest stable Worker release among `git tag` output. */
export const latestRelease = (
  tags: string[]
): { tag: string; version: Version } | null => {
  let latest: { tag: string; version: Version } | null = null;

  for (const line of tags) {
    const tag = line.trim();

    const version = tag.startsWith(RELEASE_TAG_PREFIX)
      ? parseVersion(tag.slice(RELEASE_TAG_PREFIX.length))
      : null;

    if (version && (!latest || compareVersions(version, latest.version) > 0)) {
      latest = { tag, version };
    }
  }

  return latest;
};

/** The changelog's sections for the versions after `from`, up to and including `to`. */
export const releaseNotes = (
  changelog: string,
  from: Version,
  to: Version
): string => {
  const sections: string[][] = [];
  let current: string[] | null = null;

  for (const line of changelog.split("\n")) {
    const heading = VERSION_HEADING.exec(line)?.groups?.version;

    if (heading === undefined) {
      current?.push(line);
    } else {
      const version = parseVersion(heading);

      const wanted =
        version !== null &&
        compareVersions(version, from) > 0 &&
        compareVersions(version, to) <= 0;

      current = wanted ? [line] : null;

      if (current) {
        sections.push(current);
      }
    }
  }

  return sections.map((section) => section.join("\n").trim()).join("\n\n");
};
