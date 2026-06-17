/**
 * The money boundary for central provisioning (issue #267, ADR-0267 / #243). Bridges a structural
 * {@link ProvisionDecision} to the #13 approval engine: a `customer_spend` capability ALWAYS produces an
 * action that {@link evaluatePolicy} gates (the customer's own money); a `platform_cost` capability runs
 * AUTONOMOUSLY (ipop's cost of goods, billed into the plan). Pure + dependency-free.
 */

import {
  evaluatePolicy,
  type ActionDescriptor,
  type PolicyDecision,
  type PolicyRule,
} from "../approvals/policy.js";
import type { ProvisionDecision } from "./decide.js";

/** True iff the decision lets the fleet act WITHOUT an owner prompt (ipop pays + bills into the plan). */
export function isAutonomousProvision(decision: ProvisionDecision): boolean {
  return decision.status === "provisioned";
}

/**
 * The #13 action descriptor for a `customer_spend` decision, carrying the real amount the gate shows the
 * owner. Returns `null` for any non-customer-spend decision (nothing to gate — those run autonomously or
 * fail closed). `amountCents` is the customer's spend (ad budget / email tier); a positive amount also
 * trips the spend-cap path in {@link evaluatePolicy} even under a permissive rule.
 */
export function customerSpendAction(
  decision: ProvisionDecision,
  amountCents: number,
): ActionDescriptor | null {
  if (decision.status !== "customer_spend") return null;
  return { actionType: decision.actionType, amount: amountCents };
}

/**
 * Evaluate whether a `customer_spend` request pauses for the owner, given the workspace rules. A
 * non-customer-spend decision is never evaluated here (caller uses {@link isAutonomousProvision}); passing
 * one returns an autonomous decision so the function is total.
 */
export function evaluateCustomerSpend(
  decision: ProvisionDecision,
  amountCents: number,
  rules: PolicyRule[],
): PolicyDecision {
  const action = customerSpendAction(decision, amountCents);
  if (!action) {
    return { requiresApproval: false, reason: "not a customer-spend capability — autonomous" };
  }
  return evaluatePolicy(action, rules);
}
