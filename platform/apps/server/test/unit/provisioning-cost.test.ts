import { describe, it, expect } from "vitest";
import {
  isAutonomousProvision,
  customerSpendAction,
  evaluateCustomerSpend,
} from "../../src/provisioning/cost.js";
import { decideProvision } from "../../src/provisioning/decide.js";
import { resolveProvisioningCaps } from "../../src/provisioning/caps.js";
import { PROVISIONING_CUSTOMER_SPEND_ACTION } from "../../src/approvals/policy.js";

const OWNER = "ws-owner";
const enabled = resolveProvisioningCaps({ enabled: true, ownerWorkspaceId: OWNER });

describe("provisioning cost / money boundary (#243)", () => {
  it("a provisioned (platform_cost) decision is autonomous", () => {
    const d = decideProvision("keyword_data", enabled, OWNER);
    expect(isAutonomousProvision(d)).toBe(true);
    expect(customerSpendAction(d, 500)).toBeNull();
  });

  it("a customer-spend decision is never autonomous and yields a gated action carrying the amount", () => {
    const d = decideProvision("ads_spend", enabled, OWNER);
    expect(isAutonomousProvision(d)).toBe(false);
    const action = customerSpendAction(d, 5000);
    expect(action).toEqual({ actionType: PROVISIONING_CUSTOMER_SPEND_ACTION, amount: 5000 });
  });

  it("evaluateCustomerSpend gates the customer's ad budget with no workspace rule (money default)", () => {
    const d = decideProvision("ads_spend", enabled, OWNER);
    expect(evaluateCustomerSpend(d, 5000, []).requiresApproval).toBe(true);
  });

  it("evaluateCustomerSpend on a non-customer-spend decision is autonomous (total function)", () => {
    const d = decideProvision("keyword_data", enabled, OWNER);
    expect(evaluateCustomerSpend(d, 0, []).requiresApproval).toBe(false);
  });

  it("a workspace spend cap re-gates a customer ad budget over the threshold", () => {
    const d = decideProvision("ads_spend", enabled, OWNER);
    const rules = [
      { actionType: PROVISIONING_CUSTOMER_SPEND_ACTION, requiresApproval: false, maxAutoAmount: 1000 },
    ];
    expect(evaluateCustomerSpend(d, 500, rules).requiresApproval).toBe(false);
    expect(evaluateCustomerSpend(d, 5000, rules).requiresApproval).toBe(true);
  });
});
