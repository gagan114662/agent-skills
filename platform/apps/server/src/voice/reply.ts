/**
 * Outbound support replies (#114, ADR-0114) — a **pure** descriptor builder over the #13 `external.send`
 * action, mirroring the marketing `buildMarketingSend` (#123). A reply to a real customer is
 * sensitive-by-default (no workspace rule needed → gated). At execution time the approval executor must
 * have a support delivery path; otherwise the request fails loudly instead of masquerading as sent. This
 * module changes NEITHER `approvals/policy.ts` NOR executor wiring — it only shapes the submission an
 * agent's draft becomes, so an agent can never send a reply autonomously (v1: a human approves every send).
 */

/** The single outbound kind the voice loop produces. Routes through `external.send`. */
export const VOICE_REPLY_KIND = "support.reply" as const;
export type VoiceReplyKind = typeof VOICE_REPLY_KIND;

export interface VoiceReplyInput {
  /** One-line human-readable summary of the reply (the review-queue line). */
  summary: string;
  /** Optional target (the customer contact the reply would go to). */
  target?: string;
}

/** The #13 action a support reply becomes: always `external.send`, gated by default, moves no money. */
export interface VoiceReplyDescriptor {
  actionType: "external.send";
  amount: number | null;
  payload: { kind: VoiceReplyKind; summary: string; target?: string };
}

export function buildVoiceReply(input: VoiceReplyInput): VoiceReplyDescriptor {
  const payload: VoiceReplyDescriptor["payload"] = { kind: VOICE_REPLY_KIND, summary: input.summary };
  if (input.target !== undefined) payload.target = input.target;
  return { actionType: "external.send", amount: null, payload };
}
