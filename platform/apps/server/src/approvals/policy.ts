/**
 * The approval policy engine (issue #13). Pure and dependency-free so it runs in the no-DB/no-Redis
 * unit job and is the single source of truth for "does this action pause for a human?". Persistence,
 * execution, and notification live elsewhere; this only classifies (the same split as #8's
 * `shouldNotify`). ADR-0013 §1.
 *
 * #727 — autonomy by default: the no-rule branch of {@link evaluatePolicy} now delegates to the merged
 * autonomy-defaults policy ({@link decideAutonomy}), so the single source of truth for "does this action
 * pause for a human?" is the productized money-only gate plus the per-capability / per-channel opt-out.
 * The wiring is ADDITIVE — it can only ever ADD gating (a money action via the richer #727 classifier, or
 * a capability/channel the workspace dialed off), never relax an existing money gate — so every decision
 * that was autonomous before stays autonomous, and money stays the one hard, non-toggleable gate.
 */

import { resolveAutonomyCaps } from "../autonomy-defaults/caps.js";
import type { AutonomyCaps, Capability, Channel } from "../autonomy-defaults/defaults.js";
import { decideAutonomy } from "../autonomy-defaults/policy.js";

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
 * #266 ipop hosted publishing — taking a customer's blog article / landing page LIVE on their own domain.
 * Unlike most #243 money-free actions, this ALWAYS pauses for an explicit owner approval (the issue's hard
 * constraint: nothing is published live without owner approval). It is never submitted through the #13
 * action route; the hosted service parks a PENDING request against the same workspace `approval_policies`,
 * and the page only reaches `published` through the post-approval executor. Reversible (a page can be
 * unpublished) so it is NOT in `IRREVERSIBLE_ACTIONS`; the always-gate is enforced structurally by the
 * service (it has no autonomous publish path), not by the money predicate.
 */
export const HOSTED_PUBLISH_ACTION = "hosted.publish" as const;

/**
 * #269 Echo social posting via the connect-once aggregator bridge — fanning a post OUT to the customer's
 * connected networks (X, LinkedIn, Instagram, TikTok, Facebook) through one connection. Publishing a post
 * is IRREVERSIBLE (a sent post cannot be un-sent — premortem #200 §4), so it ALWAYS pauses for an explicit
 * owner approval before the fan-out runs: the required pre-commitment for an irreversible action, exactly
 * like `hosted.publish`. It is NOT money (no spend — connecting/using the aggregator is a CONSENT, the
 * customer's own ad budget stays the separate `provisioning.customer_spend` money gate), so it is NOT in
 * {@link MONEY_ACTIONS}. It is never submitted through the #13 action route; the social service parks a
 * PENDING request against the same workspace `approval_policies`, and a post only fans out through the
 * post-approval executor (the service has no autonomous publish path). It is NOT in
 * {@link IRREVERSIBLE_ACTIONS} — that list is the MONEY-exposure metric source (money out the door); the
 * irreversibility of a post is enforced by the structural always-gate here, not the money predicate. ADR-0269.
 */
export const SOCIAL_PUBLISH_POST_ACTION = "social.publish_post" as const;

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
/** #900 informational call-prep handoff after a booked meeting; no executor, just founder-visible context. */
export const OUTREACH_CALL_PREP_ACTION = "outreach.call_prep" as const;

/**
 * #268 a real Postmark email send. Composing an email is free, but pushing it to a real inbox is the most
 * IRREVERSIBLE acquisition surface (premortem #200 §4: a sent email is in a stranger's inbox forever and burns
 * sender reputation). So — exactly like `outreach.send` — a live send is sensitive AND irreversible: it ALWAYS
 * pauses for the owner with the exact recipients + content shown, and is never agent-initiated. It is NOT a
 * money action; the always-gate is enforced STRUCTURALLY by the email deliverability service (it has no
 * autonomous send path — `decidePostmarkLiveSend` never returns `proceed:true` without an owner approval id),
 * not by the money predicate, so it is not in {@link MONEY_ACTIONS}. Like `outreach.send` it is never submitted
 * through the #13 action route; the email service parks a PENDING request against the same workspace
 * `approval_policies`. The whole feature is also flag-gated OFF + owner-workspace-first, and the default sender
 * is dry-run — so a real send requires the flag, a connected Postmark token, AND the owner's per-send yes.
 */
export const EMAIL_LIVE_SEND_ACTION = "email.live_send" as const;

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
export const SKILLOPT_REVERT_EDIT_ACTION = "skillopt.revert_skill_edit" as const;

/**
 * #356 the Oz-loops (triage/spec/review/pr-comment) produce ADVISORY proposals only. Acting on one — posting
 * a comment, applying labels, closing an issue, opening a spec issue, or merging a PR — is an OUTWARD action
 * directed at a real repo, so the loop ALWAYS parks a PENDING request; there is no autonomous post/close/
 * merge path (premortem #200: untrusted issue/PR/comment content can never trigger an action). Like
 * `outreach.send`/`skillopt.adopt_skill_edit` it is NOT a money action (it spends nothing — ADR-0243) and is
 * never submitted through the #13 action route; the Oz-loops service parks it directly against the same
 * workspace `approval_policies`. The executor is recorded-only: approving records the owner's go; the actual
 * GitHub post requires the `gh`/GitHub-App surface and stays an owner-gated follow-up (ADR-0356). It is not
 * a committed money exposure, so it is NOT in `IRREVERSIBLE_ACTIONS`.
 */
export const OZ_LOOPS_PUBLISH_PROPOSAL_ACTION = "oz_loops.publish_proposal" as const;

/**
 * #258 Stage 2 the connect-once LIVE connect — granting the fleet access to an outside account (Google
 * Search Console for Scout, an ESP for Postmark, a social account for Echo, an ad account for Bid). Per
 * ADR-0258 connecting is a one-time CONSENT, not money — so it is NOT in {@link MONEY_ACTIONS}. But the live
 * connect touches a real external surface and binds a credential to the workspace (premortem #200 §4: an
 * external grant is not cheaply reversible post-hoc), so the connect-once seam ALWAYS pauses for an explicit
 * owner approval before any credential is minted/sealed — a structural always-gate enforced by the service
 * (it has no autonomous-connect path), exactly like `hosted.publish`/`skillopt.adopt_skill_edit`. Like those
 * it is never submitted through the #13 action route; the connect service parks a PENDING request against
 * the same workspace `approval_policies`. The executor is recorded-only (approving records the owner's go;
 * the live redirect + token exchange + vault seal behind the gate is the per-department follow-up —
 * #265/#268/#269/#272 — never an autonomous mint in this slice). Reversible (disconnect clears the vault),
 * so it is NOT in {@link IRREVERSIBLE_ACTIONS}.
 */
export const CONNECTION_CONNECT_ACCOUNT_ACTION = "connection.connect_account" as const;

/**
 * #336 the connect-once CAPABILITY-TOKEN mint — issuing a scoped, short-lived, delegated token off an
 * existing connection grant so an agent can perform ONE action through an outside account without holding a
 * standing secret (the Vercel "Connect" credential model on top of the #258 seam). Minting a token is a
 * recorded-only CONSENT-class trace, NOT money (ADR-0243) — so it is NOT in {@link MONEY_ACTIONS} and never
 * counted in {@link IRREVERSIBLE_ACTIONS}. It is never submitted through the #13 action route; the
 * capability-token service writes it directly into the same workspace `approval_requests` audit trail as a
 * terminal `executed` row capturing the user→agent→service delegation chain (the token is already signed —
 * this row is the trace, not a gate). The irreversibility of a `write` (send/post/spend) is enforced upstream:
 * the mint refuses a write token unless a prior owner #13 approval id is supplied (premortem #200 §4), so the
 * mint is never the gate for an outward mutation. The whole capability is flag-gated OFF + owner-workspace
 * -first, and the verify provider is dry-run by default. ADR-0336.
 */
export const CAPABILITY_MINT_ACTION = "capability.mint" as const;

/**
 * #265 Scout submits the sitemap + requests indexing to Google Search Console. The submit is an outward
 * LIVE action against Google's production crawl surface (premortem #200 §4: an external submit / indexing
 * request is not cheaply reversible post-hoc, and indexing requests are quota-limited), so it ALWAYS pauses
 * for an explicit owner approval before anything is submitted — a structural always-gate enforced by the
 * service (`SearchConsoleService.submitSitemap` has NO autonomous submit path; it can only park a PENDING
 * request), exactly like `connection.connect_account` / `hosted.publish`. Per ADR-0243 it is NOT money, so
 * it is NOT in {@link MONEY_ACTIONS}; it is reversible (a sitemap can be resubmitted / removed), so it is NOT
 * in {@link IRREVERSIBLE_ACTIONS}. Like those it is never submitted through the #13 action route; the
 * Search Console service parks it directly against the same workspace `approval_policies`. The executor is
 * recorded-only by default (the live submit only runs through the post-approval executor with a real
 * provider wired behind the #192 vault — a deliberate follow-up; this change submits nothing live). ADR-0265.
 */
export const SEARCH_CONSOLE_SUBMIT_ACTION = "searchconsole.submit" as const;

/**
 * #284 the Agent Garden ENABLE of an `external_send` (irreversible-action) department agent — turning on
 * Echo/Postmark/Bid/Comet, whose whole purpose is work that, once approved, leaves the building (premortem
 * #200 FM#4: deliverability, brand, money are irreversible). Per ADR-0284 enabling an agent moves no money
 * (it is NOT in {@link MONEY_ACTIONS}), so it is a CONSENT/behavior decision — but switching such an agent ON
 * is exactly the "never post-hoc, always the human's call" decision the premortem reserves for the owner, so
 * the Garden ALWAYS pauses for an explicit owner approval before an `external_send` agent is enabled — a
 * structural always-gate enforced by the service (it has no autonomous-enable path for that tier), exactly
 * like `connection.connect_account`/`hosted.publish`/`skillopt.adopt_skill_edit`. Read-only / internal-draft
 * agents carry no irreversible blast radius and enable directly (gating them would be approval theater,
 * #200 FM#5). Like its siblings it is never submitted through the #13 action route; the Garden service parks
 * a PENDING request against the same workspace `approval_policies`. The executor is recorded-only (approving
 * records the owner's go; flipping the persisted enable state is the post-approval follow-up — ADR-0284
 * slice 2). Reversible (disable clears it), so it is NOT in {@link IRREVERSIBLE_ACTIONS}.
 */
export const GARDEN_ENABLE_AGENT_ACTION = "garden.enable_agent" as const;

/**
 * #267 the customer's OWN spend through a centrally-provisioned API. ipop holds the paid data/posting/ads
 * API keys CENTRALLY and bills the cost of goods into the plan, so using those APIs is autonomous (a
 * `platform_cost` capability — never gated). But the customer's own money — releasing real AD BUDGET or
 * upgrading their EMAIL-SENDING tier (a `customer_spend` capability) — is real spend, irreversible
 * (premortem #200 §4), so it ALWAYS pauses for the owner with the exact amount shown. Like
 * `venture.ad_spend` it is never submitted through the #13 action route; the provisioning service parks a
 * PENDING request against the same workspace `approval_policies`. The executor is recorded-only (a live
 * budget release behind the gate is the per-department PR's job, never an autonomous spend). ADR-0267.
 */
export const PROVISIONING_CUSTOMER_SPEND_ACTION = "provisioning.customer_spend" as const;

/**
 * #340 the enterprise budget-cap BREACH — a request to spend OVER a pre-committed per-agent / per-customer
 * budget cap. The enterprise metering+caps layer (ADR-0340) enforces a HARD never-exceed cap the system never
 * crosses on its own: a spend that fits proceeds autonomously, but a spend that would exceed the cap is
 * BLOCKED and parked here for the owner — raising/over-spending a money budget is itself a money decision
 * (premortem #200 §4: irreversible spend is never post-hoc), so it ALWAYS pauses with the exact amount + the
 * breaching scope shown. This is the gate that BACKS bid's hard ad-spend caps. Like `venture.ad_spend` it is
 * a MONEY action (in {@link MONEY_ACTIONS} + {@link IRREVERSIBLE_ACTIONS}) and is never submitted through the
 * #13 action route; the enterprise service parks a PENDING request against the same workspace
 * `approval_policies`. The executor is recorded-only (approving records the owner's go to raise/allow the
 * spend; the actual spend behind the gate is the calling department's job, never an autonomous over-spend).
 */
export const ENTERPRISE_BUDGET_BREACH_ACTION = "enterprise.budget_breach" as const;

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
 * Every action type that can appear in the approval/audit system and therefore must either execute
 * through the default registry or be intentionally written as a terminal audit row by its owning service.
 * The unit invariant keeps new policy constants from creating approval cards that later fail with
 * "no executor for <actionType>".
 */
export const APPROVAL_EXECUTOR_ACTION_TYPES: readonly string[] = [
  ...ACTION_TYPES,
  "agent.deliverable",
  AUTONOMY_COMPLETE_ACTION,
  DR_RESTORE_ACTION,
  PORTFOLIO_SUNSET_ACTION,
  SETUP_EXTERNAL_ACCOUNT_ACTION,
  FINANCE_DISBURSEMENT_ACTION,
  VENTURE_BOOTSTRAP_ACTION,
  VENTURE_DOMAIN_PURCHASE_ACTION,
  VENTURE_AD_SPEND_ACTION,
  VENTURE_PAYMENT_METHOD_ACTION,
  VENTURE_DEPLOY_ACTION,
  REALWORLD_PUBLISH_ACTION,
  HOSTED_PUBLISH_ACTION,
  SOCIAL_PUBLISH_POST_ACTION,
  OUTREACH_SEND_ACTION,
  EMAIL_LIVE_SEND_ACTION,
  REACH_DATA_CREDIT_ACTION,
  SKILLOPT_ADOPT_EDIT_ACTION,
  SKILLOPT_REVERT_EDIT_ACTION,
  OZ_LOOPS_PUBLISH_PROPOSAL_ACTION,
  CONNECTION_CONNECT_ACCOUNT_ACTION,
  CAPABILITY_MINT_ACTION,
  SEARCH_CONSOLE_SUBMIT_ACTION,
  GARDEN_ENABLE_AGENT_ACTION,
  PROVISIONING_CUSTOMER_SPEND_ACTION,
  ENTERPRISE_BUDGET_BREACH_ACTION,
  MONETIZATION_ACTIVATE_PRICE_ACTION,
  MONETIZATION_PAYOUT_SETTINGS_ACTION,
  "billing.payout",
  "billing.transfer",
];

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
  // #267 the customer's own spend through a centrally-provisioned API (ad budget release, email-sending
  // tier). ipop's billed-in API cost (`platform_cost`) is autonomous; only the customer's money gates. ADR-0267.
  PROVISIONING_CUSTOMER_SPEND_ACTION,
  // #340 spending OVER a pre-committed enterprise budget cap — a money decision (raise/allow the over-spend),
  // exact amount + breaching scope shown. The cap itself is never crossed autonomously. ADR-0340.
  ENTERPRISE_BUDGET_BREACH_ACTION,
];

/** True iff `actionType` moves or commits real money — the single predicate that drives approval (#243). */
export function isMoneyAction(actionType: string): boolean {
  return MONEY_ACTIONS.includes(actionType);
}

/**
 * Whether an action debits the owner — a three-state verdict because the money gate is CONSERVATIVE:
 *   - `"yes"`     — it moves money: a {@link isMoneyAction} type, OR a positive `amount` (real spend
 *                   committed through any action type — the marketing `ad.spend` rides `external.send`
 *                   with the budget in `amount`);
 *   - `"no"`      — no debit: no `amount` attached (the vast majority of fleet work — drafts, posts,
 *                   publishes, non-paid sends), or a determinate `amount` of zero / no positive cost;
 *   - `"unknown"` — a cost arrived we cannot interpret (a non-finite `amount`: NaN / ±Infinity). The
 *                   system cannot determine whether it spends money, so it must NOT auto-spend.
 *
 * This is the single source of truth {@link requiresHumanApproval} reads. Total and pure.
 */
export type MoneyVerdict = "yes" | "no" | "unknown";

export function spendsMoney(action: ActionDescriptor): MoneyVerdict {
  if (isMoneyAction(action.actionType)) return "yes";
  const { amount } = action;
  // No cost attached → no debit. This keeps every non-money fleet action (drafts, posts, publishes,
  // sends, deploys, sunsets, internal escalations) autonomous, exactly as today.
  if (amount === null || amount === undefined) return "no";
  // A determinate cost: a positive number is real spend; anything ≤ 0 carries no debit to the owner.
  if (Number.isFinite(amount)) return amount > 0 ? "yes" : "no";
  // A cost field arrived that we cannot interpret (NaN / ±Infinity). Never auto-spend on uncertainty.
  return "unknown";
}

/**
 * The single source of truth for the #13 gate: an action pauses for a human IFF it spends money — i.e.
 * iff {@link spendsMoney} is not `"no"`. A `"yes"` (real money) and an `"unknown"` (indeterminate cost)
 * both gate; only a determinate non-spend runs autonomously. `requiresHumanApproval(action) ===
 * spendsMoney(action) !== "no"` (#243, owner decision — only money needs the owner's yes). This is the
 * type-level predicate; {@link evaluatePolicy} layers workspace rules on top.
 */
export function requiresHumanApproval(action: ActionDescriptor): boolean {
  return spendsMoney(action) !== "no";
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
  PROVISIONING_CUSTOMER_SPEND_ACTION, // the customer's own ad budget / email tier — real spend (#267)
  ENTERPRISE_BUDGET_BREACH_ACTION, // spending over a pre-committed per-agent/per-customer budget cap (#340)
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
  /**
   * #727 opt-out hints. The autonomy policy normally INFERS the capability from the action verb (e.g.
   * `outreach.send` → `outreach`), but a caller that knows its capability/channel can pass them so a
   * workspace that dialed that capability/channel OFF re-gates precisely. Omit to let the verb decide;
   * the channel is only meaningful for a channel-scoped send (the actuator that has it passes it).
   */
  capability?: Capability;
  channel?: Channel;
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
 *   - else, no rule → the #727 autonomy-by-default policy ({@link decideAutonomy}) layered with the
 *     amount-aware spend gate — gated iff the action moves money (the one hard gate), or the workspace
 *     dialed its capability/channel OFF, or its cost cannot be determined (never auto-spend on uncertainty).
 *
 * Under #243 (owner decision 2026-06-14) approval was driven by a single MONEY predicate; #727 productizes
 * that as `decideAutonomy` and adds the per-capability / per-channel opt-out. The wiring here is the
 * consumption seam: the whole run/actuator path that funnels through `evaluatePolicy` now defaults ALL
 * capabilities ON (autonomous) and pauses only for money (or a deliberately dialed-off capability/channel).
 * `caps` is resolved from the environment by default (the self-contained #727 opt-out toggles); pass an
 * explicit {@link AutonomyCaps} for a deterministic decision (the no-DB unit job / tests). The three
 * always-on guards (kill-switch #592, suppression/DNC #594, anti-injection #674) are orthogonal — they run
 * independently of this decision and are never weakened by it. Pure given `caps` (ADR-0013 §1, ADR-0243).
 */
export function evaluatePolicy(
  action: ActionDescriptor,
  rules: PolicyRule[],
  caps: AutonomyCaps = resolveAutonomyCaps(),
): PolicyDecision {
  if (action.amount !== null && action.amount !== undefined) {
    if (!Number.isFinite(action.amount)) {
      return {
        requiresApproval: true,
        reason: action.actionType + " has an undetermined cost — owner approval required (never auto-spend on uncertainty)",
      };
    }
    if (action.amount < 0) {
      return {
        requiresApproval: true,
        reason: action.actionType + " has an invalid negative amount — owner approval required",
      };
    }
  }
  const rule = rules.find((r) => r.actionType === action.actionType);
  if (rule) {
    if (rule.requiresApproval) {
      return { requiresApproval: true, reason: `policy: ${action.actionType} requires approval` };
    }
    // Conservative even under an auto-approve rule: an invalid stored cap must not invert the gate.
    if (rule.maxAutoAmount !== null && (!Number.isFinite(rule.maxAutoAmount) || rule.maxAutoAmount < 0)) {
      return {
        requiresApproval: true,
        reason: action.actionType + " has an invalid auto-approve limit — owner approval required",
      };
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
  // No workspace rule → the #727 autonomy-by-default policy decides (it supersedes and subsumes the inline
  // #243 money predicate). `decideAutonomy` reads the action's STRUCTURAL fields (verb token + the explicit
  // capability/channel hints) against the env-resolved opt-out caps; it is the authority for the money gate
  // (charges/refunds/payouts, real ad spend, live payment keys) AND the per-capability / per-channel opt-out.
  const autonomy = decideAutonomy(
    { action: action.actionType, capability: action.capability, channel: action.channel },
    caps,
  );

  // 1) A capability or channel the workspace deliberately dialed OFF re-gates only its own actions (the new
  //    #727 opt-out). Defaults are ALL-ON, so a fresh workspace never hits this — everything stays autonomous.
  if (autonomy.gate === "capability_disabled" || autonomy.gate === "channel_disabled") {
    return { requiresApproval: true, reason: autonomy.reason };
  }

  // 2) Money is the one hard gate. It fires from the #727 classifier (the action's own money signals) OR the
  //    amount-aware #243 spend gate — `spendsMoney` still catches a real budget riding a generic action type
  //    (a positive `amount`) and an indeterminate cost (NaN/±Infinity), which the structural classifier does
  //    not read. The union can only ADD gating — it never relaxes a money gate (#727 invariant).
  const verdict = spendsMoney(action);
  if (autonomy.money) {
    return { requiresApproval: true, reason: autonomy.reason };
  }
  if (verdict === "yes") {
    return isMoneyAction(action.actionType)
      ? { requiresApproval: true, reason: `${action.actionType} moves money — owner approval required` }
      : {
          requiresApproval: true,
          reason: `commits real spend (${action.amount}) — owner approval required`,
        };
  }
  if (verdict === "unknown") {
    return {
      requiresApproval: true,
      reason: `${action.actionType} has an undetermined cost — owner approval required (never auto-spend on uncertainty)`,
    };
  }
  return { requiresApproval: false, reason: "autonomous by default — money is the only hard gate (#243/#727)" };
}

/** A request is expired once its TTL deadline has passed. Pure so expiry is deterministically tested. */
export function isExpired(expiresAt: Date | null, now: Date): boolean {
  return expiresAt !== null && expiresAt.getTime() <= now.getTime();
}
