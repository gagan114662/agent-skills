/**
 * The hard outbound-money safety rail (issue #98, ADR-0043). Pure and dependency-free so it runs in the
 * unit job and is the single source of truth for "is this action moving money OUT?". Outbound money
 * (refunds/payouts/transfers) is NEVER autonomous: it is structurally absent from the {@link
 * import("./provider.js").BillingProvider} seam (no method exists), gated as a #13 sensitive action by
 * default (see `approvals/policy.ts` {@link import("../approvals/policy.js").DEFAULT_SENSITIVE_ACTIONS}),
 * and — even after a human approval — recorded-only in v1 (payouts stay manual in the Stripe dashboard).
 */

/** Action kinds that move money OUT of the owner's account. NEVER executed autonomously in v1. */
export const OUTBOUND_MONEY_ACTIONS = [
  "billing.refund",
  "billing.payout",
  "billing.transfer",
] as const;
export type OutboundMoneyAction = (typeof OUTBOUND_MONEY_ACTIONS)[number];

/** The inbound (collect-only) capabilities the billing manager may perform. */
export const INBOUND_CAPABILITIES = [
  "billing.create_product_price",
  "billing.create_payment_link",
] as const;

/** Thrown when something tries to move money out through a path that must only ever collect. */
export class OutboundMoneyBlocked extends Error {
  constructor(action: string) {
    super(`outbound money action ${JSON.stringify(action)} is not permitted (inbound only)`);
    this.name = "OutboundMoneyBlocked";
  }
}

/** True iff `action` moves money out (refund/payout/transfer). */
export function isOutboundMoney(action: string): boolean {
  return (OUTBOUND_MONEY_ACTIONS as readonly string[]).includes(action);
}

/**
 * Fail closed if `action` would move money out. The billing manager calls this so that no code path —
 * present or future — can disburse funds through it; outbound money must go through the #13 approval
 * gate (recorded-only in v1), never the manager.
 */
export function assertInboundOnly(action: string): void {
  if (isOutboundMoney(action)) throw new OutboundMoneyBlocked(action);
}
