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
/** #195 a venture prod cutover / failed-release escalation — gated for the owner, recorded-only. */
export const VENTURE_DEPLOY_ACTION = "venture.deploy" as const;

/**
 * #231 the real-world `publish` tool — publishing a page to a live, reachable PUBLIC URL is an outward
 * brand surface, so it is gated for the owner by default (like `venture.deploy`). Never submitted
 * through the #13 action route; the real-world actuator service evaluates it against the same workspace
 * `approval_policies` and parks a PENDING request the blocked publish ages in. Reversible (a page can be
 * redeployed / taken down) so it is NOT in `IRREVERSIBLE_ACTIONS`.
 */
export const REALWORLD_PUBLISH_ACTION = "realworld.publish" as const;

/**
 * #225 the outreach engine SEND — composing a message is free, but pushing it to a real prospect on a
 * real channel (email/LinkedIn/X) is an outward, IRREVERSIBLE brand surface (premortem #200: a sent
 * message cannot be unsent; deliverability + brand are at stake). It is sensitive by default AND
 * irreversible, so it ALWAYS pauses for the owner with the exact recipient + content shown, and is never
 * agent-initiated. Like `realworld.publish` it is never submitted through the #13 action route; the
 * outreach service evaluates it against the same workspace `approval_policies` and parks a PENDING request
 * the message ages in. The executor is recorded-only (it records the owner's approved send) — a real ESP/
 * social adapter behind this gate is a deliberate future ADR, never an autonomous call.
 */
export const OUTREACH_SEND_ACTION = "outreach.send" as const;

/**
 * #280 Reach buys prospect DATA credits. Sending a Reach message is autonomous (not money) — but spending
 * real money on a paid data provider (Clay/Lusha/Vibe) to FIND prospects is a money action: it commits
 * real spend, irreversibly (the credits are consumed on the API call). So Reach money-gates the paid
 * search BEFORE the call, with the exact estimated amount shown; the free `mock` source carries no cost
 * and runs autonomously. Never submitted through the #13 action route — the Reach service parks a PENDING
 * request against the same workspace `approval_policies`. The executor is recorded-only (a real paid fetch
 * behind the gate is a deliberate follow-up, never an autonomous spend).
 */
export const REACH_DATA_CREDIT_ACTION = "reach.data_credit_spend" as const;

/**
 * #283 SkillOpt-Sleep adopts a bounded edit to a department agent's skill doc. Adopting an edit CHANGES how
 * that agent behaves in the workspace — a behavior-altering, owner-only decision (premortem #200 §4: never
 * post-hoc, always a human's call) — so the self-improvement loop ALWAYS parks a PENDING request; there is
 * no autonomous-adopt path. Like `outreach.send` it is NOT a money action and is never submitted through
 * the #13 action route — the SkillOpt service parks it directly against the same workspace
 * `approval_policies`. The executor is recorded-only (approving records the owner's go; applying the edit
 * to the versioned skill doc is a deliberate follow-up). It is reversible (a doc append can be reverted),
 * so it is NOT in `IRREVERSIBLE_ACTIONS`.
 */
export const SKILLOPT_ADOPT_EDIT_ACTION = "skillopt.adopt_skill_edit" as const;

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
 * The MONEY actions — the **only** class that requires owner approval (#243, owner decision 2026-06-14).
 * This SUPERSEDES the prior "sensitive-by-default / nothing leaves the building without your yes" policy:
 * a money action is any movement or commitment of REAL money — charging a customer, refunds, payouts/
 * withdrawals, transfers, plan/billing changes, connecting or using LIVE payment credentials, and any
 * real spend (ad budgets, paid tools/APIs). A money action ALWAYS pauses for the owner with the exact
 * amount shown (and the workspace spend cap / `maxAutoAmount` still re-gates over its threshold).
 *
 * Everything else the fleet ships AUTONOMOUSLY — outbound non-paid sends, social posts, content
 * publishing, venture/prod deploys, a venture bootstrap, autonomous completion, a destructive DR restore,
 * a portfolio sunset, an agent-browser action. None of those is in this set, so {@link evaluatePolicy}
 * lets them run with no owner prompt (a workspace rule can still opt one back into a gate).
 *
 * The non-approval safeguards are KEPT and run automatically (they are security/compliance, NOT gates):
 * the #223 injection-quarantine (poisoned web content can never trigger an autonomous send/action), email
 * opt-out / suppression / do-not-contact honoring (CAN-SPAM/GDPR), and per-domain send rate caps. A
 * side-effectful agent-browser step also still gates via the #174 runtime structural gate
 * (`decideBrowserStep` → `needs_approval`), independent of this money set.
 *
 * `setup.external_account` is money ONLY for the `payment` service kind (connecting LIVE payment
 * credentials); the onboarding service decides money-ness by kind (`isMoneyServiceKind`), so a hosting/
 * ESP/analytics connect is autonomous. It is listed here so that, when the gate IS consulted (payment
 * kind), it gates by default.
 */
export const MONEY_ACTIONS: readonly string[] = [
  // #98 outbound money is NEVER autonomous: refunds/payouts/transfers gate for a human and are
  // recorded-only in v1 (payouts stay manual in the Stripe dashboard). ADR-0043.
  "billing.refund",
  "billing.payout",
  "billing.transfer",
  // #194 a finance disbursement (a budget-envelope release / outbound spend) — money out the door,
  // human-gated and recorded-only. ADR-0194.
  FINANCE_DISBURSEMENT_ACTION,
  // #187 the venture MONEY boundary — registering a domain, paid acquisition spend, attaching a LIVE
  // payment method: real spend, irreversible (premortem FM#4), always the owner's call. ADR-0187.
  VENTURE_DOMAIN_PURCHASE_ACTION,
  VENTURE_AD_SPEND_ACTION,
  VENTURE_PAYMENT_METHOD_ACTION,
  // #188 charging customers (activating/re-pricing) and re-routing payouts — money decisions, exact
  // amount shown, recorded-only. ADR-0188.
  MONETIZATION_ACTIVATE_PRICE_ACTION,
  MONETIZATION_PAYOUT_SETTINGS_ACTION,
  // #192 connecting/using LIVE payment credentials — gated ONLY for the `payment` service kind (the
  // onboarding service decides by kind; every other external-account connect is autonomous). ADR-0192.
  SETUP_EXTERNAL_ACCOUNT_ACTION,
  // #280 buying paid prospect-data credits (Clay/Lusha/Vibe) — real spend, exact amount shown. The
  // marketing SEND it enables stays autonomous; only the data purchase is money. ADR-0280.
  REACH_DATA_CREDIT_ACTION,
];

/** True iff `actionType` moves or commits real money — the single predicate that drives approval (#243). */
export function isMoneyAction(actionType: string): boolean {
  return MONEY_ACTIONS.includes(actionType);
}

/**
 * The set of actions {@link evaluatePolicy} gates when no workspace rule matches. Under #243 this IS the
 * money set — there is exactly one source ({@link MONEY_ACTIONS}). The name is retained because the #119
 * Evidence-Priced Autonomy invariants derive from it (a money action can never auto-relax) and a few
 * consumers import it; it no longer carries the broad "sensitive" list.
 */
export const DEFAULT_SENSITIVE_ACTIONS: readonly string[] = MONEY_ACTIONS;

/**
 * The IRREVERSIBLE money actions (premortem #200 FM#4): money whose blast radius cannot be cheaply
 * reversed — out the door, charged, or committed as real spend. The read side: the founder report counts
 * how many irreversible actions a window carried so the owner sees the company's money exposure. Under
 * #243 the irreversible class is money-only (a sent email, a deploy, a sunset are no longer gated and are
 * not counted here). Every entry is also in {@link MONEY_ACTIONS}, so it is human-gated, never post-hoc.
 */
export const IRREVERSIBLE_ACTIONS: readonly string[] = [
  "billing.refund",
  "billing.payout",
  "billing.transfer",
  FINANCE_DISBURSEMENT_ACTION, // money out the door (#194)
  VENTURE_DOMAIN_PURCHASE_ACTION, // a registered domain (money + brand) (#187)
  VENTURE_AD_SPEND_ACTION, // paid acquisition spend (#187)
  VENTURE_PAYMENT_METHOD_ACTION, // attaching a real payment method (#187)
  REACH_DATA_CREDIT_ACTION, // paid prospect-data credits, consumed on the API call (#280)
];

/** True iff `actionType` is in the irreversible money class (premortem #200 FM#4). Pure + total. */
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
 *   - else a matching rule whose `maxAutoAmount` is exceeded by `amount` → gated (the spend cap);
 *   - else a matching rule → auto-approved;
 *   - else, no rule → gated iff the action moves money ({@link isMoneyAction}).
 * Under #243 (owner decision 2026-06-14) approval is driven by a single MONEY predicate: only money
 * actions pause for the owner; everything else the fleet ships autonomously. Total and pure — the single
 * source of truth for gating (ADR-0013 §1, ADR-0243).
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
  // No workspace rule → gate iff money. The MONEY predicate is two-pronged (#243): a money action TYPE,
  // OR any real spend — a positive `amount` committed through a generic action type (e.g. a marketing
  // `ad.spend` that rides `external.send` and carries the budget as `amount`). "Any real spend (ad
  // budgets, paid tools/APIs)" is money even when it isn't a dedicated money action type. A workspace
  // rule's `maxAutoAmount` is the spend cap that auto-approves small spends under its ceiling.
  if (isMoneyAction(action.actionType)) {
    return { requiresApproval: true, reason: `${action.actionType} moves money — owner approval required` };
  }
  if (action.amount !== null && action.amount !== undefined && action.amount > 0) {
    return {
      requiresApproval: true,
      reason: `commits real spend (${action.amount}) — owner approval required`,
    };
  }
  return { requiresApproval: false, reason: "autonomous: only money needs approval (#243)" };
}

/** A request is expired once its TTL deadline has passed. Pure so expiry is deterministically tested. */
export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}
