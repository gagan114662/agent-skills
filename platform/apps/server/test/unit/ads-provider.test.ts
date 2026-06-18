import { describe, it, expect } from "vitest";
import {
  DryRunAdsProvider,
  MockAdsProvider,
  sanitizeAccountSnapshot,
  type AdsAccountSnapshot,
} from "../../src/ads/provider.js";

/**
 * #272 — the AdsProvider read-back seam. Campaign + spend state is READ BACK from the ad API, never assumed
 * (#200 §3). An unwired deployment degrades honestly to "not connected" (null), never a fabricated snapshot.
 * The provider response is untrusted (#200 §6) so {@link sanitizeAccountSnapshot} neutralizes free text and
 * derives the spend total from the line items rather than trusting the provider's claimed total.
 */
const snapshot: AdsAccountSnapshot = {
  accountRef: "acct-1",
  currency: "USD",
  totalSpentCents: 999_999, // a (wrong/hostile) claimed total — must be ignored in favor of the line items
  campaigns: [
    { campaignRef: "c1", name: "Brand", status: "active", spentCents: 1_500, dailyBudgetCents: 5_000, creatives: [] },
    { campaignRef: "c2", name: "Retarget", status: "paused", spentCents: 500, dailyBudgetCents: 2_000, creatives: [] },
  ],
};

describe("AdsProvider (#272)", () => {
  it("the dry-run provider is not live and reads back NOTHING (honest not-connected)", async () => {
    const p = new DryRunAdsProvider();
    expect(p.live).toBe(false);
    expect(await p.getAccountState({ workspaceId: "ws", accountRef: "acct-1" })).toBeNull();
  });

  it("the mock provider reads back the configured snapshot", async () => {
    const p = new MockAdsProvider(snapshot);
    expect(p.live).toBe(true);
    const state = await p.getAccountState({ workspaceId: "ws", accountRef: "acct-1" });
    expect(state?.campaigns).toHaveLength(2);
  });
});

describe("sanitizeAccountSnapshot (#272)", () => {
  it("quarantines the response with the STRUCTURAL provider id (never read from the body)", () => {
    const q = sanitizeAccountSnapshot("google_ads", snapshot);
    expect(q.quarantined).toBe(true);
    expect(q.provider).toBe("google_ads");
    expect(q.capabilityId).toBe("ads");
  });

  it("derives the spend total from the line items, ignoring the provider's claimed total (#200 §3)", () => {
    const q = sanitizeAccountSnapshot("google_ads", snapshot);
    expect(q.data.totalSpentCents).toBe(2_000); // 1500 + 500, not the claimed 999999
  });

  it("sanitizes hostile campaign names and clamps spend to a non-negative integer (#200 §6)", () => {
    const nl = String.fromCharCode(9);
    const hostile: AdsAccountSnapshot = {
      accountRef: "acct-1",
      currency: "USD",
      totalSpentCents: 0,
      campaigns: [
        { campaignRef: "c1", name: `evil${nl}${nl}name`, status: "active", spentCents: -100, dailyBudgetCents: 7.9, creatives: [] },
      ],
    };
    const q = sanitizeAccountSnapshot("google_ads", hostile);
    expect(q.data.campaigns[0]!.name).not.toContain(nl);
    expect(q.data.campaigns[0]!.spentCents).toBe(0);
    expect(q.data.campaigns[0]!.dailyBudgetCents).toBe(7);
  });
});
