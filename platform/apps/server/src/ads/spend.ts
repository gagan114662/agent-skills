/**
 * Money-gated ad spend — the pure decision core (#272, ADR-0272). Bid DRAFTS campaigns; this governs the
 * MONEY boundary: a campaign launch, a budget raise, or a spend adjustment are the only ways real ad money
 * leaves the building. The premortem (#200 §4) makes ad spend IRREVERSIBLE — yesterday's spend can't be
 * refunded — so the rule is absolute:
 *
 *   - EVERY positive spend is a #13 money-gated owner yes with the EXACT amount shown
 *     (`provisioning.customer_spend`, the existing money action — no new money action is introduced). There
 *     is NO autonomous-spend path: the only outcome for a positive spend is `needs_approval`.
 *   - A spend OVER the configured HARD per-action cap is REFUSED outright (`blocked`) — not even approvable
 *     through the agent path; the owner must raise `ads.perActionCapCents` in config. This is the ceiling
 *     the system never crosses (premortem #200 §4: bounded blast radius, pre-committed).
 *   - An undetermined (non-finite) or invalid (negative / non-integer) cost is `blocked` — never auto-spend
 *     on uncertainty (#243/#200). A zero request is a `no_spend` no-op.
 *
 * Pure ⇒ unit-testable; the workspace scope + cap resolution live in `caps.ts`, the parking IO in
 * `service.ts`/`default.ts`.
 */
import { PROVISIONING_CUSTOMER_SPEND_ACTION } from "../approvals/policy.js";

/** The ways real ad money is committed. All three are money-gated identically (#272). */
export const ADS_SPEND_KINDS = ["campaign_launch", "budget_raise", "spend_adjustment"] as const;
export type AdsSpendKind = (typeof ADS_SPEND_KINDS)[number];

export function isAdsSpendKind(value: string): value is AdsSpendKind {
  return (ADS_SPEND_KINDS as readonly string[]).includes(value);
}

export interface AdsSpendRequest {
  kind: AdsSpendKind;
  /** The spend the owner is being asked to approve, in cents. */
  amountCents: number;
  /** Optional structural reference to the campaign the spend is for (data, never parsed for directives). */
  campaignRef?: string;
}

/** What the spend path resolved for this workspace: whether it is offered + the hard ceiling. */
export interface AdsSpendScope {
  /** The ad-spend path is offered for this workspace (the flag is on AND it is in scope — see caps.ts). */
  enabledForWorkspace: boolean;
  /** The HARD per-action cap in cents the system never crosses (0 ⇒ no spend approvable). */
  perActionCapCents: number;
}

export type AdsSpendDecision =
  /** Park a #13 money-gated owner approval with the exact amount shown. */
  | {
      status: "needs_approval";
      actionType: typeof PROVISIONING_CUSTOMER_SPEND_ACTION;
      amountCents: number;
      capCents: number;
      kind: AdsSpendKind;
      campaignRef: string | null;
      summary: string;
    }
  /** A no-op: nothing to spend. */
  | { status: "no_spend"; reason: string }
  /** Refused: off for the workspace, over the hard cap, no cap configured, or an invalid/undetermined cost. */
  | { status: "blocked"; reason: string };

function dollars(cents: number): string {
  return (cents / 100).toFixed(2);
}

const KIND_VERB: Record<AdsSpendKind, string> = {
  campaign_launch: "Launch ad campaign",
  budget_raise: "Raise ad budget",
  spend_adjustment: "Adjust ad spend",
};

/**
 * Decide what happens to a requested ad spend. Total + pure. The order encodes the safety invariants:
 * off-for-workspace and undetermined/invalid costs fail closed FIRST; a zero request is a no-op; the hard
 * cap is the last gate before approval, so a request can never be approved above the configured ceiling.
 */
export function decideAdsSpend(request: AdsSpendRequest, scope: AdsSpendScope): AdsSpendDecision {
  if (!scope.enabledForWorkspace) {
    return { status: "blocked", reason: "ad spend is not enabled for this workspace" };
  }
  const { amountCents } = request;
  // Never auto-spend on uncertainty (#200/#243): a non-finite cost is undetermined; a negative or
  // non-integer cost is malformed. Both are refused before they could ever reach the gate.
  if (!Number.isFinite(amountCents)) {
    return {
      status: "blocked",
      reason: "ad spend has an undetermined cost — never spend on uncertainty",
    };
  }
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    return { status: "blocked", reason: "ad spend amount must be a non-negative integer (cents)" };
  }
  if (amountCents === 0) {
    return { status: "no_spend", reason: "no spend requested" };
  }
  const cap = Math.floor(scope.perActionCapCents);
  if (!Number.isFinite(cap) || cap <= 0) {
    return {
      status: "blocked",
      reason: "no ad-spend cap is configured — the owner must set ads.perActionCapCents before any spend",
    };
  }
  if (amountCents > cap) {
    return {
      status: "blocked",
      reason: `$${dollars(amountCents)} exceeds the $${dollars(cap)} per-action cap the system never crosses — the owner must raise ads.perActionCapCents`,
    };
  }
  return {
    status: "needs_approval",
    actionType: PROVISIONING_CUSTOMER_SPEND_ACTION,
    amountCents,
    capCents: cap,
    kind: request.kind,
    campaignRef: request.campaignRef ?? null,
    summary: `${KIND_VERB[request.kind]} — $${dollars(amountCents)} spend (cap $${dollars(cap)})`.slice(0, 140),
  };
}
