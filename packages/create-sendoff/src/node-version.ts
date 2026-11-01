// The Node version check index.ts runs before loading the CLI. It imports
// nothing, so it loads on any Node.

/** The oldest Node the CLI runs on (@clack/prompts needs util.styleText). Keep in step with package.json's engines. */
export const MIN_NODE = "20.12.0";

const parts = (version: string): number[] =>
  version.split(".").map((part) => Math.trunc(Number(part)) || 0);

/** True when `version`, like process.versions.node, is MIN_NODE or newer. */
export const supportsNode = (version: string): boolean => {
  const [major = 0, minor = 0, patch = 0] = parts(version);
  const [minMajor = 0, minMinor = 0, minPatch = 0] = parts(MIN_NODE);

  if (major !== minMajor) {
    return major > minMajor;
  }

  return minor === minMinor ? patch >= minPatch : minor > minMinor;
};
