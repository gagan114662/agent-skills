import { describe, it, expect } from "vitest";
import {
  assertInboundOnly,
  isOutboundMoney,
  OutboundMoneyBlocked,
  OUTBOUND_MONEY_ACTIONS,
} from "../../src/billing/safety.js";
import { evaluatePolicy, DEFAULT_SENSITIVE_ACTIONS } from "../../src/approvals/policy.js";
import { defaultRegistry } from "../../src/approvals/runtime.js";

/**
 * The hard safety rail (#98): outbound money (refunds/payouts/transfers) is NEVER autonomous. It is
 * blocked structurally in the billing manager (`assertInboundOnly`), gated as a #13 sensitive action by
 * default, and — even after a human approval — recorded-only in v1 (no Stripe call).
 */
describe("billing safety rail (#98 — inbound only, outbound gated + recorded-only)", () => {
  it("classifies refunds/payouts/transfers as outbound money", () => {
    for (const a of OUTBOUND_MONEY_ACTIONS) expect(isOutboundMoney(a)).toBe(true);
    expect(isOutboundMoney("billing.create_payment_link")).toBe(false);
  });

  it("assertInboundOnly throws on any outbound-money action", () => {
    expect(() => assertInboundOnly("billing.refund")).toThrow(OutboundMoneyBlocked);
    expect(() => assertInboundOnly("billing.payout")).toThrow(OutboundMoneyBlocked);
    expect(() => assertInboundOnly("billing.transfer")).toThrow(OutboundMoneyBlocked);
  });

  it("assertInboundOnly permits the inbound capabilities", () => {
    expect(() => assertInboundOnly("billing.create_product_price")).not.toThrow();
    expect(() => assertInboundOnly("billing.create_payment_link")).not.toThrow();
  });

  it("outbound-money actions are sensitive by default in the #13 policy engine", () => {
    for (const a of OUTBOUND_MONEY_ACTIONS) {
      expect(DEFAULT_SENSITIVE_ACTIONS).toContain(a);
      // No workspace rule → the policy gates it for a human.
      expect(evaluatePolicy({ actionType: a }, []).requiresApproval).toBe(true);
    }
  });

  it("the wired billing.refund executor is recorded-only — no Stripe call", async () => {
    const executor = defaultRegistry.get("billing.refund");
    expect(executor).toBeDefined();
    const result = await executor!.execute(
      { paymentIntentId: "pi_123", amountCents: 500, reason: "duplicate" },
      { workspaceId: "ws_1", requesterMemberId: "m_1", log: console as never },
    );
    expect(result.recorded).toBe(true);
    expect(result.executed).toBe(false); // v1 never executes — payouts stay manual in Stripe
  });
});
