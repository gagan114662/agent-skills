import { describe, it, expect } from "vitest";
import {
  MARKETING_SEND_KINDS,
  isMarketingSendKind,
  buildMarketingSend,
} from "../../../src/marketing/external-send.js";
import { evaluatePolicy } from "../../../src/approvals/policy.js";

/**
 * #123 external sends — a social post, an email, or ad spend is an `external.send` action. Under #243
 * (money-only approval) a NON-PAID send (a social post, an email) ships AUTONOMOUSLY; only a send that
 * commits real money — ad spend, carried as the action `amount` — pauses for the owner. This module only
 * *builds the descriptor*; the policy engine decides the gate from the money predicate. (The injection-
 * quarantine + suppression/CAN-SPAM still run automatically on every send, with no owner prompt.)
 */
describe("#123 marketing external sends — only real spend is gated (#243)", () => {
  it("knows the three outbound send kinds", () => {
    expect([...MARKETING_SEND_KINDS].sort()).toEqual(["ad.spend", "email.send", "social.post"]);
    expect(isMarketingSendKind("social.post")).toBe(true);
    expect(isMarketingSendKind("delete.everything")).toBe(false);
  });

  it("builds an external.send descriptor for a non-paid send that ships autonomously (#243)", () => {
    const send = buildMarketingSend({ kind: "social.post", summary: "Launch day thread", target: "x" });
    expect(send.actionType).toBe("external.send");
    expect(send.payload).toMatchObject({ kind: "social.post", summary: "Launch day thread", target: "x" });
    expect(send.amount).toBeNull();
    // No money, no spend → no owner prompt.
    expect(evaluatePolicy({ actionType: send.actionType, amount: send.amount }, []).requiresApproval).toBe(false);
  });

  it("threads ad spend as the amount so real spend is gated as money — even with no workspace rule (#243)", () => {
    const spend = buildMarketingSend({ kind: "ad.spend", summary: "Google Ads starter", amountCents: 5000 });
    expect(spend.amount).toBe(5000);
    // Real spend is money: gated by default with no rule at all (the "any real spend" prong of #243).
    expect(evaluatePolicy({ actionType: spend.actionType, amount: spend.amount }, []).requiresApproval).toBe(true);
    // The workspace spend cap still re-gates spend over a permissive auto rule's threshold.
    const decision = evaluatePolicy(
      { actionType: "external.send", amount: 5000 },
      [{ actionType: "external.send", requiresApproval: false, maxAutoAmount: 1000 }],
    );
    expect(decision.requiresApproval).toBe(true);
  });

  it("rejects an unknown send kind", () => {
    expect(() => buildMarketingSend({ kind: "wire.transfer" as never, summary: "nope" })).toThrow();
  });
});
