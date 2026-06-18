import { describe, it, expect } from "vitest";
import { buildDefaultRegistry } from "../../src/approvals/runtime.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION, isMoneyAction, isIrreversibleAction } from "../../src/approvals/policy.js";

/**
 * #272 — the `provisioning.customer_spend` executor wiring. The customer's own ad budget release is a MONEY
 * action (#267/#243), gated for the owner with the exact amount shown, and IRREVERSIBLE. On approval it is
 * RECORDED-ONLY: no real money moves (a live ad-API spend behind the gate is a deliberate follow-up). This
 * makes a money-gated ad spend approval resolve CLEANLY (executed-recorded) instead of failing "no executor".
 */
describe("provisioning.customer_spend executor (#272)", () => {
  const exec = buildDefaultRegistry().get(PROVISIONING_CUSTOMER_SPEND_ACTION)!;
  const ctx = { workspaceId: "ws1", requesterMemberId: "m1" } as never;

  it("is registered in the default registry", () => {
    expect(exec).toBeDefined();
    expect(exec.actionType).toBe("provisioning.customer_spend");
  });

  it("is a MONEY action and IRREVERSIBLE (so it always gates for the owner)", () => {
    expect(isMoneyAction(PROVISIONING_CUSTOMER_SPEND_ACTION)).toBe(true);
    expect(isIrreversibleAction(PROVISIONING_CUSTOMER_SPEND_ACTION)).toBe(true);
  });

  it("requires a positive integer amountCents + a capability", () => {
    expect(exec.validate({ capabilityId: "ads_spend", amountCents: 5_000 })).toEqual({ ok: true });
    expect(exec.validate({ capabilityId: "ads_spend", amountCents: 0 }).ok).toBe(false);
    expect(exec.validate({ capabilityId: "ads_spend", amountCents: 5_000.5 }).ok).toBe(false);
    expect(exec.validate({ amountCents: 5_000 }).ok).toBe(false);
    expect(exec.validate({}).ok).toBe(false);
  });

  it("summarizes the spend with the exact amount for the review card", () => {
    const s = exec.summarize({ capabilityId: "ads_spend", amountCents: 5_000, summary: "Launch ad campaign" });
    expect(s).toContain("50.00");
  });

  it("is recorded-only on approval (executed:false, no money moves)", async () => {
    const result = await exec.execute({ capabilityId: "ads_spend", amountCents: 5_000 }, ctx);
    expect(result.recorded).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.amountCents).toBe(5_000);
    expect(result.capabilityId).toBe("ads_spend");
  });
});
