import { buildVoiceReply, type VoiceReplyDescriptor } from "../voice/reply.js";

/**
 * Outbound descriptors the Support Desk (#190, ADR-0190) produces — **pure** shapers over the existing
 * #13 actions, changing NEITHER `approvals/policy.ts` NOR any executor. A normal reply reuses #114's
 * `buildVoiceReply` (an `external.send`); a refund routes to the MONEY queue as a `billing.refund` draft
 * that is sensitive-by-default and recorded-only — never auto-executed (premortem #200 §4).
 */

/** A normal support reply → the #114 `external.send` descriptor (re-exported so call sites stay local). */
export function buildSupportReply(input: { summary: string; target?: string }): VoiceReplyDescriptor {
  return buildVoiceReply(input);
}

/** The single MONEY-queue kind the desk produces. Routes through the gated `billing.refund` action. */
export const SUPPORT_REFUND_KIND = "support.refund" as const;
export type SupportRefundKind = typeof SUPPORT_REFUND_KIND;

export interface RefundDraftInput {
  /** One-line summary for the MONEY review queue. */
  summary: string;
  /** The refund amount in cents, when the ticket implies one; null otherwise (the human fills it in). */
  amountCents: number | null;
  /** The payment intent id, when known from the ticket; omitted otherwise (the human supplies it). */
  paymentIntentId?: string;
  ticketId: string;
}

/**
 * The #13 action a refund draft becomes: always `billing.refund` (on `DEFAULT_SENSITIVE_ACTIONS`, so
 * gated with no rule needed), recorded-only. We never auto-approve this — it ALWAYS waits for a human, by
 * construction (the routing gate returns `money_queue`, and the executor is recorded-only in v1). When the
 * payment intent is unknown we omit it; the reviewer supplies it via the #13 edit before approving.
 */
export interface RefundDraftDescriptor {
  actionType: "billing.refund";
  amount: number | null;
  payload: { kind: SupportRefundKind; summary: string; ticketId: string; paymentIntentId?: string };
}

export function buildRefundDraft(input: RefundDraftInput): RefundDraftDescriptor {
  const payload: RefundDraftDescriptor["payload"] = {
    kind: SUPPORT_REFUND_KIND,
    summary: input.summary,
    ticketId: input.ticketId,
  };
  if (input.paymentIntentId !== undefined) payload.paymentIntentId = input.paymentIntentId;
  return { actionType: "billing.refund", amount: input.amountCents, payload };
}
