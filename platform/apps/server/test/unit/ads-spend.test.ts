import { describe, it, expect } from "vitest";
import {
  ADS_SPEND_KINDS,
  decideAdsSpend,
  type AdsSpendRequest,
} from "../../src/ads/spend.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION, isMoneyAction } from "../../src/approvals/policy.js";

/**
 * #272 — money-gated ad spend. EVERY spend / budget-raise / campaign-launch is a #13 money-gated yes with
 * the exact amount shown; there is NO autonomous-spend path. A request over the configured hard per-action
 * cap is REFUSED outright (the system never crosses it). Uncertain / invalid costs never auto-spend (#200).
 */
const launch = (amountCents: number): AdsSpendRequest => ({
  kind: "campaign_launch",
  amountCents,
  campaignRef: "camp-1",
});

const inScope = { enabledForWorkspace: true, perActionCapCents: 50_000 };

describe("decideAdsSpend (#272)", () => {
  it("a valid spend within the cap needs OWNER approval with the exact amount + money action", () => {
    const d = decideAdsSpend(launch(5_000), inScope);
    expect(d.status).toBe("needs_approval");
    if (d.status !== "needs_approval") return;
    expect(d.actionType).toBe(PROVISIONING_CUSTOMER_SPEND_ACTION);
    expect(isMoneyAction(d.actionType)).toBe(true);
    expect(d.amountCents).toBe(5_000);
    expect(d.capCents).toBe(50_000);
    expect(d.summary).toContain("50.00"); // exact amount shown
    expect(d.campaignRef).toBe("camp-1");
  });

  it("the ONLY outcome for a positive spend is approval — never autonomous", () => {
    for (const kind of ADS_SPEND_KINDS) {
      const d = decideAdsSpend({ kind, amountCents: 1_000 }, inScope);
      expect(d.status, kind).toBe("needs_approval");
    }
  });

  it("blocks any spend when the path is OFF for the workspace", () => {
    const d = decideAdsSpend(launch(5_000), { enabledForWorkspace: false, perActionCapCents: 50_000 });
    expect(d.status).toBe("blocked");
  });

  it("refuses a spend OVER the hard per-action cap — the system never crosses it", () => {
    const d = decideAdsSpend(launch(50_001), inScope);
    expect(d.status).toBe("blocked");
    if (d.status !== "blocked") return;
    expect(d.reason).toMatch(/cap/i);
  });

  it("allows a spend exactly AT the cap", () => {
    expect(decideAdsSpend(launch(50_000), inScope).status).toBe("needs_approval");
  });

  it("blocks every spend when no cap is configured (cap 0 ⇒ fail-closed)", () => {
    const d = decideAdsSpend(launch(1), { enabledForWorkspace: true, perActionCapCents: 0 });
    expect(d.status).toBe("blocked");
  });

  it("a zero request is a no-op, never an approval", () => {
    expect(decideAdsSpend(launch(0), inScope).status).toBe("no_spend");
  });

  it("blocks an undetermined cost — never auto-spend on uncertainty (#200)", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decideAdsSpend(launch(bad), inScope).status, String(bad)).toBe("blocked");
    }
  });

  it("blocks a negative or non-integer amount", () => {
    expect(decideAdsSpend(launch(-100), inScope).status).toBe("blocked");
    expect(decideAdsSpend(launch(10.5), inScope).status).toBe("blocked");
  });
});
