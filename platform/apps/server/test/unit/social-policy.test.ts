import { describe, it, expect } from "vitest";
import {
  SOCIAL_PUBLISH_POST_ACTION,
  isMoneyAction,
  isIrreversibleAction,
  requiresHumanApproval,
} from "../../src/approvals/policy.js";

/**
 * #269 — the social publish action is a STRUCTURAL always-gate (parked by the service), not a money action.
 * It mirrors `hosted.publish`: not in MONEY_ACTIONS, not in IRREVERSIBLE_ACTIONS (that list is the money-
 * exposure metric source). The irreversibility of a post is enforced by the service's always-gate, never by
 * the money predicate. The action-route money predicate therefore does NOT gate it (the service does).
 */
describe("social.publish_post policy (#269)", () => {
  it("is NOT a money action", () => {
    expect(isMoneyAction(SOCIAL_PUBLISH_POST_ACTION)).toBe(false);
  });

  it("is NOT in the money-exposure IRREVERSIBLE_ACTIONS list", () => {
    expect(isIrreversibleAction(SOCIAL_PUBLISH_POST_ACTION)).toBe(false);
  });

  it("the money-only #13 predicate does not gate it (the service's always-gate does)", () => {
    expect(requiresHumanApproval({ actionType: SOCIAL_PUBLISH_POST_ACTION })).toBe(false);
  });
});
