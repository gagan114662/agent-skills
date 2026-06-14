import { describe, it, expect } from "vitest";
import {
  computeCacCents,
  computeChannelCac,
  buildAcquisitionBriefView,
  type ChannelSpend,
  type ChannelConversions,
} from "../../src/acquisition/cac.js";

describe("computeCacCents", () => {
  it("divides spend by conversions", () => {
    expect(computeCacCents(10_000, 5)).toBe(2_000);
  });
  it("rounds to whole cents", () => {
    expect(computeCacCents(1_000, 3)).toBe(333);
  });
  it("is null with no conversions (no divide-by-zero, no fake CAC)", () => {
    expect(computeCacCents(10_000, 0)).toBeNull();
  });
});

describe("computeChannelCac", () => {
  const spend: ChannelSpend[] = [
    { channel: "ads", spentCents: 10_000 },
    { channel: "email", spentCents: 0 },
  ];
  const conversions: ChannelConversions[] = [
    { channel: "ads", conversions: 5, verified: true },
    { channel: "email", conversions: 2, verified: false },
  ];

  it("computes per-channel CAC and carries the verified flag", () => {
    const rows = computeChannelCac(spend, conversions);
    const ads = rows.find((r) => r.channel === "ads")!;
    expect(ads.cacCents).toBe(2_000);
    expect(ads.verified).toBe(true);
    const email = rows.find((r) => r.channel === "email")!;
    expect(email.cacCents).toBe(0); // 0 spend / 2 conversions → CAC 0
    expect(email.verified).toBe(false); // unverified conversions never count as ground truth
  });

  it("spend with no conversions yields a null CAC", () => {
    const rows = computeChannelCac([{ channel: "social", spentCents: 5_000 }], []);
    expect(rows[0]!.cacCents).toBeNull();
    expect(rows[0]!.verified).toBe(false);
  });

  it("is sorted by channel for a deterministic brief", () => {
    const rows = computeChannelCac(spend, conversions);
    expect(rows.map((r) => r.channel)).toEqual([...rows.map((r) => r.channel)].sort());
  });
});

describe("buildAcquisitionBriefView (AC5: external-grounded, premortem #200 §2)", () => {
  it("blends CAC over verified conversions only", () => {
    const view = buildAcquisitionBriefView(
      [
        { channel: "ads", spentCents: 10_000 },
        { channel: "social", spentCents: 2_000 },
      ],
      [
        { channel: "ads", conversions: 4, verified: true },
        { channel: "social", conversions: 1, verified: true },
      ],
    );
    expect(view.totalSpentCents).toBe(12_000);
    expect(view.totalConversions).toBe(5);
    expect(view.blendedCacCents).toBe(2_400);
    expect(view.verified).toBe(true);
  });

  it("marks the blend UNVERIFIED when any counted conversion is self-reported", () => {
    const view = buildAcquisitionBriefView(
      [{ channel: "ads", spentCents: 10_000 }],
      [{ channel: "ads", conversions: 5, verified: false }],
    );
    // The unverified channel's conversions are excluded from the verified blend, so blended CAC is null.
    expect(view.blendedCacCents).toBeNull();
    expect(view.verified).toBe(false);
  });

  it("carries failing channels through for the brief (AC3)", () => {
    const view = buildAcquisitionBriefView([], [], ["social"]);
    expect(view.failingChannels).toEqual(["social"]);
  });
});
