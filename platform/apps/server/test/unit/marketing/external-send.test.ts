import { describe, it, expect } from "vitest";
import {
  MARKETING_SEND_KINDS,
  isMarketingSendKind,
  buildMarketingSend,
} from "../../../src/marketing/external-send.js";
import { evaluatePolicy } from "../../../src/approvals/policy.js";

/**
 * #123 external sends — anything that leaves the building (a social post, an email, ad spend) is an
 * `external.send` action: sensitive-by-default (#13), drafted in-channel, recorded-only after a human
 * approves. This module only *builds the descriptor*; it changes neither the policy engine nor the
 * executor — so the gate (and every existing approval test) is untouched.
 */
describe("#123 marketing external sends are #13-gated by default", () => {
  it("knows the three outbound send kinds", () => {
    expect([...MARKETING_SEND_KINDS].sort()).toEqual(["ad.spend", "email.send", "social.post"]);
    expect(isMarketingSendKind("social.post")).toBe(true);
    expect(isMarketingSendKind("delete.everything")).toBe(false);
  });

  it("builds an external.send descriptor a human must approve before it goes out", () => {
    const send = buildMarketingSend({ kind: "social.post", summary: "Launch day thread", target: "x" });
    expect(send.actionType).toBe("external.send");
    expect(send.payload).toMatchObject({ kind: "social.post", summary: "Launch day thread", target: "x" });
    // No workspace rule → sensitive by default → gated.
    expect(evaluatePolicy({ actionType: send.actionType, amount: send.amount }, []).requiresApproval).toBe(true);
  });

  it("threads ad spend as the amount so the #13 spend-threshold gate can re-gate it", () => {
    const spend = buildMarketingSend({ kind: "ad.spend", summary: "Google Ads starter", amountCents: 5000 });
    expect(spend.amount).toBe(5000);
    // Even with a permissive auto rule, spend over the threshold re-gates.
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
