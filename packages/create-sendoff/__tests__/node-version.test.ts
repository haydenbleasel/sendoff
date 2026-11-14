import { describe, expect, it } from "bun:test";

import { MIN_NODE, supportsNode } from "../src/node-version";

describe("supportsNode", () => {
  it("accepts the oldest supported Node and anything newer", () => {
    expect(supportsNode(MIN_NODE)).toBe(true);
    expect(supportsNode("22.0.1")).toBe(true);
    expect(supportsNode("22.12.0")).toBe(true);
    expect(supportsNode("24.0.0")).toBe(true);
  });

  it("rejects Node lines past end of life", () => {
    expect(supportsNode("21.7.3")).toBe(false);
    expect(supportsNode("20.19.5")).toBe(false);
    expect(supportsNode("18.20.4")).toBe(false);
    expect(supportsNode("garbage")).toBe(false);
  });

  it("matches the engines field in package.json", async () => {
    const { engines } = await Bun.file(
      new URL("../package.json", import.meta.url)
    ).json();

    expect(engines.node).toBe(`>=${MIN_NODE.replace(/(?:\.0)+$/u, "")}`);
  });
});
