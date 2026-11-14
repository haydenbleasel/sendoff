import { describe, expect, it } from "vitest";

import { duration } from "../src/mcp/send-tools";

describe("duration", () => {
  it("rounds to the nearest minute, as the docs' example does", () => {
    expect(duration(6000, 14)).toBe("about 7 minutes");
    expect(duration(50_000, 14)).toBe("about 60 minutes");
  });

  it("says one minute in the singular, and under a minute below that", () => {
    expect(duration(70, 1)).toBe("about 1 minute");
    expect(duration(500, 14)).toBe("under a minute");
    expect(duration(10, 0.5)).toBe("under a minute");
  });
});
