/**
 * The approval policy engine (issue #13). Pure and dependency-free so it runs in the no-DB/no-Redis
 * unit job and is the single source of truth for "does this action pause for a human?". Persistence,
 * execution, and notification live elsewhere; this only classifies (the same split as #8's
 * `shouldNotify`). ADR-0013 §1.
 */

/** Action types the executor registry can run (#13). Submitting any other type is a 400. */
export const ACTION_TYPES = ["chat.post_message", "external.send", "billing.refund", "browser.action"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export function isActionType(value: unknown): value is ActionType {
  return typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * The action kind a workflow's autonomous completion is gated under (#84 follow-up, ADR-0042). It is
 * never submitted through the #13 action route (it is not an {@link ActionType}); the engine evaluates
 * it against the same workspace `approval_policies` so a trusted workflow can opt out of the human gate
 * with one rule, while everything else keeps the gate.
 */
export const AUTONOMY_COMPLETE_ACTION = "autonomy.complete" as const;

/**
 * The action kind a destructive disaster-recovery restore is gated under (#99, ADR-0099). Like
 * `autonomy.complete` it is never submitted through the #13 action route; the DISASTER runbook path
 * evaluates it against the same gate so a destructive restore ALWAYS needs an explicit human approval
 * (an agent can never approve its own gate — ADR-0013) and is never agent-initiated. VALIDATION mode
 * is non-destructive and needs no gate.
 */
export const DR_RESTORE_ACTION = "dr.restore" as const;

/**
 * The action kind a portfolio SUNSET (kill of a launched venture) is gated under (#107, ADR-0107).
 * Like `autonomy.complete` and `dr.restore` it is never submitted through the #13 action route; the
 * portfolio loop evaluates it against the same workspace `approval_policies` so a sunset ALWAYS needs an
 * explicit human approval by default (an agent can never approve its own kill — ADR-0013). A SUNSET is
 * irreversible (it flips the venture `killed` + writes the post-mortem), so it stays gated unless a
 * workspace explicitly opts out with one rule.
 */
export const PORTFOLIO_SUNSET_ACTION = "portfolio.sunset" as const;

/**
 * The action kind a blocked-on-setup external account is gated under (#192, ADR-0192). Like
 * `autonomy.complete` it is never submitted through the #13 action route; the onboarding service evaluates
 * it against the same workspace `approval_policies` and creates a PENDING request so the work parks
 * visibly in the decision queue (and ages there) instead of failing silently — and because creating an
 * external account / pasting keys is ALWAYS a human action (the #192 directive), it ships sensitive by
 * default. A workspace can still tune the policy, but the human step is intrinsic to the action.
 */
export const SETUP_EXTERNAL_ACCOUNT_ACTION = "setup.external_account" as const;

/**
 * The action kind a finance disbursement (a budget envelope release / outbound spend the Finance
 * Ledger surfaces) is gated under (#194, ADR-0194). Like `billing.refund` it is **sensitive by
 * default** so it ALWAYS pauses for a human, and the executor is **recorded-only** (no money moves) —
 * money is irreversible, so a disbursement is human-gated + pre-committed, never agent-initiated or
 * post-hoc. It is not submitted through the #13 action route; the money queue evaluates it against the
 * same workspace `approval_policies`.
 */
export const FINANCE_DISBURSEMENT_ACTION = "finance.disbursement" as const;

/**
 * The Venture Factory MONEY/launch boundary action kinds (#187, ADR-0187). Like `autonomy.complete` they
 * are never submitted through the #13 action route; the factory evaluates them against the same workspace
 * `approval_policies`. `venture.bootstrap` is the single owner go/no-go that spins up a whole venture
 * (AC3). The other three are the MONEY boundary (AC4): registering a domain, starting paid acquisition,
 * and attaching a payment method are irreversible (premortem FM#4) and ALWAYS queue for the owner — they
 * are never agent-initiated. Everything else in the bootstrap (reversible) proceeds without a human.
 */
export const VENTURE_BOOTSTRAP_ACTION = "venture.bootstrap" as const;
export const VENTURE_DOMAIN_PURCHASE_ACTION = "venture.domain_purchase" as const;
export const VENTURE_AD_SPEND_ACTION = "venture.ad_spend" as const;
export const VENTURE_PAYMENT_METHOD_ACTION = "venture.payment_method" as const;

/**
 * The venture monetization MONEY-boundary action kinds (#188, ADR-0188). Like `venture.bootstrap` they are
 * never submitted through the #13 action route; the monetization service evaluates them against the same
 * workspace `approval_policies`. Activating a pricing draft (or re-pricing it) lets a venture's customers
 * be charged, and changing payout settings re-routes money — both are irreversible money decisions
 * (premortem FM#4), so they ship sensitive by default and ALWAYS queue for the owner with the exact amount
 * shown. The executors are recorded-only (like `billing.refund`/`finance.disbursement`): approving records
 * the owner's go, and a live payment link is minted (inbound-only collection) only after that go.
 */
export const MONETIZATION_ACTIVATE_PRICE_ACTION = "monetization.activate_price" as const;
export const MONETIZATION_PAYOUT_SETTINGS_ACTION = "monetization.payout_settings" as const;

/**
 * Action types that require approval when **no** workspace rule matches. `external.send` ships
 * gated ("external sends require approval", ADR-0013 §1); `autonomy.complete` ships gated so the
 * autonomous-completion human gate (#13/#20) holds unless a workspace explicitly opts out (ADR-0042);
 * `dr.restore` ships gated so a destructive restore always needs a human (#99, ADR-0099). A workspace
 * rule can override either way (but a destructive restore should stay gated).
 */
export const DEFAULT_SENSITIVE_ACTIONS: readonly string[] = [
  "external.send",
  AUTONOMY_COMPLETE_ACTION,
  // #99 a destructive disaster-recovery restore always needs a human (never agent-initiated). ADR-0099.
  DR_RESTORE_ACTION,
  // #107 a portfolio SUNSET (kill of a launched venture) is irreversible — always a human gate. ADR-0107.
  PORTFOLIO_SUNSET_ACTION,
  // #192 external account setup ALWAYS needs the owner (create account, accept ToS, paste keys). ADR-0192.
  SETUP_EXTERNAL_ACCOUNT_ACTION,
  // #194 a finance disbursement (outbound spend) is irreversible — always a human gate, recorded-only. ADR-0194.
  FINANCE_DISBURSEMENT_ACTION,
  // #187 starting a whole venture is an owner go/no-go; domain/ad-spend/payment-method are the MONEY
  // boundary (irreversible — premortem FM#4), always human, never agent-initiated. ADR-0187.
  VENTURE_BOOTSTRAP_ACTION,
  VENTURE_DOMAIN_PURCHASE_ACTION,
  VENTURE_AD_SPEND_ACTION,
  VENTURE_PAYMENT_METHOD_ACTION,
  // #188 activating a venture's pricing (so customers can be charged) and changing payout settings are
  // irreversible money decisions — always human, never agent-initiated, recorded-only. ADR-0188.
  MONETIZATION_ACTIVATE_PRICE_ACTION,
  MONETIZATION_PAYOUT_SETTINGS_ACTION,
  // #98 outbound money is NEVER autonomous: refunds/payouts/transfers are sensitive by default, gated
  // for a human, and recorded-only in v1 (payouts stay manual in the Stripe dashboard). ADR-0043.
  "billing.refund",
  "billing.payout",
  "billing.transfer",
  // #174 a side-effectful agent-browser action (a click that submits/posts/purchases, typing into a
  // form) is sensitive by default — read-only browsing is free, but mutating remote state always
  // pauses for a human. ADR-0174.
  "browser.action",
];

/**
 * The IRREVERSIBLE action types (premortem #200 FM#4): an action whose blast radius cannot be cheaply
 * reversed — money out the door, a domain registered, an email sent (deliverability/brand), a venture
 * killed, a destructive restore. The premortem mandates these be **pre-committed or human-gated, never
 * post-hoc review**, which they already are (every one is in {@link DEFAULT_SENSITIVE_ACTIONS}); this set
 * is the read side — the founder report counts how many irreversible actions a window carried so the
 * owner sees the company's exposure to the one class of mistake that is not cheaply undoable.
 *
 * Pure data, colocated with the action constants so the taxonomy has one home. Deliberately EXCLUDES
 * `venture.bootstrap` (a launch is reversible — a venture can be archived/sunset) and `browser.action`
 * (read-or-write ambiguous), to avoid over-counting; both still gate for a human via the sensitive list.
 */
export const IRREVERSIBLE_ACTIONS: readonly string[] = [
  "external.send", // deliverability/brand — a sent message cannot be unsent
  "billing.refund",
  "billing.payout",
  "billing.transfer",
  FINANCE_DISBURSEMENT_ACTION, // money out the door (#194)
  VENTURE_DOMAIN_PURCHASE_ACTION, // a registered domain (money + brand) (#187)
  VENTURE_AD_SPEND_ACTION, // paid acquisition spend (#187)
  VENTURE_PAYMENT_METHOD_ACTION, // attaching a real payment method (#187)
  PORTFOLIO_SUNSET_ACTION, // killing a launched venture cannot be undone (#107)
  DR_RESTORE_ACTION, // a destructive restore (#99)
];

/** True iff `actionType` is in the irreversible class (premortem #200 FM#4). Pure + total. */
export function isIrreversibleAction(actionType: string): boolean {
  return IRREVERSIBLE_ACTIONS.includes(actionType);
}

/** Lifecycle of an approval request. `approved` is the transient state between the decision and the
 * executor finishing; the rest are terminal. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "executed",
  "failed",
  "rejected",
  "expired",
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** Terminal states: a request here never changes again (no re-decide, no re-execute). */
export const TERMINAL_STATUSES: readonly ApprovalStatus[] = [
  "executed",
  "failed",
  "rejected",
  "expired",
];

export function isApprovalStatus(value: unknown): value is ApprovalStatus {
  return typeof value === "string" && (APPROVAL_STATUSES as readonly string[]).includes(value);
}

/**
 * A workspace policy rule. A matching rule with `requiresApproval` gates the type outright;
 * otherwise `maxAutoAmount` (when set) re-gates a spend over the threshold. ADR-0013 §1.
 */
export interface PolicyRule {
  actionType: string;
  requiresApproval: boolean;
  maxAutoAmount: number | null;
}

/** The action being evaluated. `amount` is the optional spend the threshold gate compares. */
export interface ActionDescriptor {
  actionType: string;
  amount?: number | null;
}

export interface PolicyDecision {
  requiresApproval: boolean;
  reason: string;
}

/**
 * Decide whether `action` must pause for a human, given the workspace's `rules`:
 *   - a matching rule with `requiresApproval` → gated;
 *   - else a matching rule whose `maxAutoAmount` is exceeded by `amount` → gated (the spend gate);
 *   - else a matching rule → auto-approved;
 *   - else, no rule → gated iff the type is sensitive by default (`external.send`).
 * Total and pure — the single source of truth for gating (ADR-0013 §1).
 */
export function evaluatePolicy(action: ActionDescriptor, rules: PolicyRule[]): PolicyDecision {
  const rule = rules.find((r) => r.actionType === action.actionType);
  if (rule) {
    if (rule.requiresApproval) {
      return { requiresApproval: true, reason: `policy: ${action.actionType} requires approval` };
    }
    if (
      rule.maxAutoAmount !== null &&
      action.amount !== null &&
      action.amount !== undefined &&
      action.amount > rule.maxAutoAmount
    ) {
      return {
        requiresApproval: true,
        reason: `amount ${action.amount} exceeds auto-approve limit ${rule.maxAutoAmount}`,
      };
    }
    return { requiresApproval: false, reason: "auto-approved by policy" };
  }
  if (DEFAULT_SENSITIVE_ACTIONS.includes(action.actionType)) {
    return { requiresApproval: true, reason: `${action.actionType} is sensitive by default` };
  }
  return { requiresApproval: false, reason: "no policy requires approval" };
}

/** A request is expired once its TTL deadline has passed. Pure so expiry is deterministically tested. */
export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}
