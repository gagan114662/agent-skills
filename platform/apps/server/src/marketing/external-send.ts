/**
 * Marketing external sends (#123) — a **pure** descriptor builder over the #13 `external.send` action.
 * A social post, an email, or ad spend is sensitive-by-default (no workspace rule needed → gated),
 * drafted in-channel, and recorded-only after a human approves (the existing #13 executor). This module
 * changes NEITHER `approvals/policy.ts` NOR the executor — so the gate and every approval test are
 * untouched; it only shapes the submission an agent's draft becomes.
 */

/** The outbound send kinds the marketing fleet produces. All route through `external.send`. */
export const MARKETING_SEND_KINDS = ["social.post", "email.send", "ad.spend"] as const;
export type MarketingSendKind = (typeof MARKETING_SEND_KINDS)[number];

export function isMarketingSendKind(value: unknown): value is MarketingSendKind {
  return typeof value === "string" && (MARKETING_SEND_KINDS as readonly string[]).includes(value);
}

export interface MarketingSendInput {
  kind: MarketingSendKind;
  /** One-line human-readable summary of what would go out (the review-queue line). */
  summary: string;
  /** Optional target (handle / list / campaign). */
  target?: string;
  /** Ad spend in cents — threaded as the action `amount` so the #13 spend-threshold gate can re-gate. */
  amountCents?: number;
}

/** The #13 action a marketing send becomes: always `external.send`, gated by default. */
export interface MarketingSendDescriptor {
  actionType: "external.send";
  amount: number | null;
  payload: { kind: MarketingSendKind; summary: string; target?: string };
}

/**
 * Build the `external.send` descriptor for a marketing send. Throws on an unknown kind (defence in
 * depth — only the three known outbound kinds are ever submittable through this path).
 */
export function buildMarketingSend(input: MarketingSendInput): MarketingSendDescriptor {
  if (!isMarketingSendKind(input.kind)) {
    throw new Error(`unknown marketing send kind: ${String(input.kind)}`);
  }
  const payload: MarketingSendDescriptor["payload"] = { kind: input.kind, summary: input.summary };
  if (input.target !== undefined) payload.target = input.target;
  return {
    actionType: "external.send",
    amount: typeof input.amountCents === "number" ? input.amountCents : null,
    payload,
  };
}
