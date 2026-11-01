import { describe, expect, it } from "bun:test";

import { MIN_NODE, supportsNode } from "../src/node-version";

describe("supportsNode", () => {
  it("accepts the oldest supported Node and anything newer", () => {
    expect(supportsNode(MIN_NODE)).toBe(true);
    expect(supportsNode("20.12.1")).toBe(true);
    expect(supportsNode("20.13.0")).toBe(true);
    expect(supportsNode("22.0.0")).toBe(true);
  });

  it("rejects older Node, which can't load the CLI's dependencies", () => {
    expect(supportsNode("20.11.1")).toBe(false);
    expect(supportsNode("18.20.4")).toBe(false);
    expect(supportsNode("garbage")).toBe(false);
  });

  it("matches the engines field in package.json", async () => {
    const { engines } = await Bun.file(
      new URL("../package.json", import.meta.url)
    ).json();

    expect(engines.node).toBe(`>=${MIN_NODE.replace(/\.0$/u, "")}`);
  });
});
