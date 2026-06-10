import { describe, it, expect } from "vitest";
import { planRegion } from "../../src/scale/region.js";

describe("scale/region (#71 — least-loaded placement)", () => {
  it("returns undefined when no regions are allowed (unplaced — single-region #25 behavior)", () => {
    expect(planRegion([], {}, undefined)).toBeUndefined();
  });

  it("places in the only allowed region regardless of its load", () => {
    expect(planRegion(["iad1"], { iad1: 99 }, undefined)).toBe("iad1");
  });

  it("places in the least-loaded allowed region", () => {
    expect(planRegion(["iad1", "sfo1"], { iad1: 5, sfo1: 2 }, undefined)).toBe("sfo1");
    expect(planRegion(["iad1", "sfo1"], { iad1: 1, sfo1: 4 }, undefined)).toBe("iad1");
  });

  it("a region with no recorded load counts as zero", () => {
    expect(planRegion(["iad1", "sfo1"], { iad1: 3 }, undefined)).toBe("sfo1");
  });

  it("breaks a load tie by the preferred region", () => {
    expect(planRegion(["iad1", "sfo1"], { iad1: 2, sfo1: 2 }, "sfo1")).toBe("sfo1");
  });

  it("breaks a load tie by allowed order, then name, when no preference applies", () => {
    expect(planRegion(["iad1", "sfo1"], {}, undefined)).toBe("iad1"); // allowed-order first
    expect(planRegion(["sfo1", "iad1"], {}, undefined)).toBe("sfo1");
  });

  it("ignores load for non-allowed regions and a preferred region outside the allowed set", () => {
    // cdg1 is loaded but not allowed → irrelevant; preferred cdg1 is not allowed → ignored
    expect(planRegion(["iad1", "sfo1"], { cdg1: 0, iad1: 1, sfo1: 1 }, "cdg1")).toBe("iad1");
  });
});
