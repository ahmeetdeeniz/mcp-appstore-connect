import { describe, expect, it } from "vitest";

import { compareVersions } from "#/versions";

describe("compareVersions", () => {
  it("orders segments numerically, not lexically", () => {
    expect(["1.9.0", "1.10.0", "1.2"].toSorted(compareVersions)).toEqual([
      "1.2",
      "1.9.0",
      "1.10.0",
    ]);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("2", "1.99.99")).toBeGreaterThan(0);
  });
});
