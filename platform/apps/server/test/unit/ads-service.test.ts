import { describe, it, expect } from "vitest";
import { AdsService, type AdsServiceDeps } from "../../src/ads/service.js";
import { ADS_DEFAULTS } from "../../src/ads/caps.js";
import type { AdsAccountSnapshot } from "../../src/ads/provider.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION } from "../../src/approvals/policy.js";

/**
 * #272 — the AdsService orchestrator. status() reports HONEST connected/account/review state (read back, never
 * assumed); requestSpend() routes every spend through the money gate, parking a #13 owner approval with the
 * exact amount, and never crossing the hard per-action cap.
 */
const OWNER = "ws-owner";
const identity = { workspaceId: OWNER, memberId: "m1", kind: "human" as const, displayName: "Owner" };

const account: AdsAccountSnapshot = {
  accountRef: "acct-1",
  currency: "USD",
  totalSpentCents: 0,
  campaigns: [
    {
      campaignRef: "c1",
      name: "Brand",
      status: "active",
      spentCents: 1_200,
      dailyBudgetCents: 5_000,
      creatives: [
        { creativeRef: "cr1", reviewState: "approved" },
        { creativeRef: "cr2", reviewState: "rejected", reason: "Policy: trademark" },
      ],
    },
  ],
};

function makeService(over: Partial<AdsServiceDeps> = {}): { svc: AdsService; parked: unknown[] } {
  const parked: unknown[] = [];
  const deps: AdsServiceDeps = {
    caps: () => ({ ...ADS_DEFAULTS, enabled: true, ownerWorkspaceId: OWNER, perActionCapCents: 50_000 }),
    connectedConnectionIds: async () => new Set<string>(["google_ads"]),
    readAccount: async () => account,
    park: async (input) => {
      parked.push(input);
      return { id: "req-1" };
    },
    ...over,
  };
  return { svc: new AdsService(deps), parked };
}

describe("AdsService.status (#272)", () => {
  it("reports connected + enabled + cap and reads back the (sanitized) account state", async () => {
    const { svc } = makeService();
    const s = await svc.status(OWNER);
    expect(s.connected).toBe(true);
    expect(s.enabled).toBe(true);
    expect(s.perActionCapCents).toBe(50_000);
    expect(s.account?.totalSpentCents).toBe(1_200);
    expect(s.creativeReviews).toHaveLength(2);
    expect(s.reviewSummary.rejected).toBe(1);
    expect(s.reviewSummary.allClear).toBe(false);
  });

  it("is honestly NOT connected (and reads back nothing) when the ad account isn't connected", async () => {
    const { svc } = makeService({ connectedConnectionIds: async () => new Set<string>() });
    const s = await svc.status(OWNER);
    expect(s.connected).toBe(false);
    expect(s.account).toBeNull();
    expect(s.creativeReviews).toHaveLength(0);
  });

  it("connected but no live data reads back null (never fabricates a snapshot)", async () => {
    const { svc } = makeService({ readAccount: async () => null });
    const s = await svc.status(OWNER);
    expect(s.connected).toBe(true);
    expect(s.account).toBeNull();
  });
});

describe("AdsService.requestSpend (#272)", () => {
  it("parks a money-gated owner approval with the exact amount + money action", async () => {
    const { svc, parked } = makeService();
    const r = await svc.requestSpend(identity, { kind: "campaign_launch", amountCents: 5_000, campaignRef: "c1" });
    expect(r.status).toBe("pending_approval");
    if (r.status !== "pending_approval") return;
    expect(r.requestId).toBe("req-1");
    expect(r.amountCents).toBe(5_000);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({
      workspaceId: OWNER,
      actionType: PROVISIONING_CUSTOMER_SPEND_ACTION,
      amountCents: 5_000,
    });
  });

  it("refuses a spend over the hard cap and parks NOTHING", async () => {
    const { svc, parked } = makeService();
    const r = await svc.requestSpend(identity, { kind: "budget_raise", amountCents: 99_999 });
    expect(r.status).toBe("blocked");
    expect(parked).toHaveLength(0);
  });

  it("refuses to spend before an ad account is connected", async () => {
    const { svc, parked } = makeService({ connectedConnectionIds: async () => new Set<string>() });
    const r = await svc.requestSpend(identity, { kind: "campaign_launch", amountCents: 5_000 });
    expect(r.status).toBe("blocked");
    expect(parked).toHaveLength(0);
  });

  it("refuses a spend when the path is off for the workspace", async () => {
    const { svc, parked } = makeService({
      caps: () => ({ ...ADS_DEFAULTS, enabled: false, perActionCapCents: 50_000 }),
    });
    const r = await svc.requestSpend(identity, { kind: "campaign_launch", amountCents: 5_000 });
    expect(r.status).toBe("blocked");
    expect(parked).toHaveLength(0);
  });
});
