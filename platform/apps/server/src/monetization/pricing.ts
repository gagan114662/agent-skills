/**
 * Venture monetization — the pure core (issue #188, ADR-0188). Dependency-free (no DB, no Stripe, no
 * config) so the whole unit job imports it and it is the single source of truth for "what is a pricing
 * draft", "what does a price experiment project", and "exactly what money figure does the owner see on
 * the #13 / Slack card". The IO orchestration (vault, provider, money queue, webhook) lives in
 * `service.ts`; this file only validates shapes and computes honest, clearly-labeled numbers.
 *
 * The premortem (#200) shapes the math:
 *   - **FM#2 self-reported metrics are fiction**: {@link projectExperimentImpact} returns an
 *     `estimateLabel: "UNVERIFIED"` projection — a forecast, never a result. Only externally-verified
 *     revenue (a Stripe receipt) ever counts as a measured outcome (see `service.ts`).
 *   - **FM#4 reversibility / money is irreversible**: {@link summarizeActivation} /
 *     {@link summarizePayoutSettings} render the EXACT amount the owner is approving, so the money
 *     boundary is a pre-committed human decision with the figure in front of them, never post-hoc.
 */

/** Lifecycle of a pricing plan. A `draft` is reversible/free; everything past it touches money. */
export const PLAN_STATUSES = ["draft", "pending_activation", "active", "archived"] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

/** Lifecycle of a pricing experiment. Proposed → (owner yes) active → concluded with a verified result. */
export const EXPERIMENT_STATUSES = ["proposed", "active", "concluded", "abandoned"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

/** Recurring interval for a price; `null` = a one-time charge. Mirrors the #98 billing seam. */
export type PriceInterval = "day" | "week" | "month" | "year";
const PRICE_INTERVALS: readonly PriceInterval[] = ["day", "week", "month", "year"];

/** Result of validating a draft/experiment shape. `ok:false` → a 400 at submit (mirrors #13's contract). */
export type ValidationResult = { ok: true } | { ok: false; error: string };

/** The fields that define a pricing draft (a product + price the fleet proposes for a venture). */
export interface PricingDraftInput {
  /** Human-facing product name (e.g. "Pro plan"). */
  name: string;
  /** Unit amount in the smallest currency unit (cents). Must be a positive integer. */
  amountCents: number;
  /** ISO 4217 currency code (e.g. "usd"). */
  currency: string;
  /** Recurring interval, or null for a one-time price. */
  interval: PriceInterval | null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/** True iff `value` is a valid recurring interval or `null` (one-time). */
export function isPriceInterval(value: unknown): value is PriceInterval | null {
  return value === null || (typeof value === "string" && PRICE_INTERVALS.includes(value as PriceInterval));
}

/**
 * Validate a pricing draft (#188 AC1). A draft is reversible and money-free, so this only guards the
 * shape: a non-empty name, a positive-integer `amountCents`, a 3-letter currency, and a valid interval
 * (or null). Pure — the single submit-time check shared by the route and the service.
 */
export function validatePricingDraft(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "draft must be an object" };
  }
  const p = input as Record<string, unknown>;
  if (!nonEmptyString(p.name)) return { ok: false, error: "name required" };
  if (!isPositiveInt(p.amountCents)) return { ok: false, error: "amountCents must be a positive integer" };
  if (typeof p.currency !== "string" || p.currency.trim().length !== 3) {
    return { ok: false, error: "currency must be a 3-letter ISO code" };
  }
  if (!isPriceInterval(p.interval === undefined ? null : p.interval)) {
    return { ok: false, error: "interval must be day|week|month|year or null" };
  }
  return { ok: true };
}

// ---- pricing experiments (#188 AC3) --------------------------------------------------------------

/** What a lens/bid proposes for a price test: the live baseline vs. the candidate, with traffic + conv. */
export interface ExperimentProjectionInput {
  /** The current live price (cents). */
  baselineAmountCents: number;
  /** The proposed test price (cents). */
  candidateAmountCents: number;
  /** Expected paying customers per period at the baseline price. */
  baselineConversions: number;
  /** Expected paying customers per period at the candidate price (the lens's hypothesis). */
  candidateConversions: number;
}

/**
 * A projected revenue impact for a pricing experiment. EVERY field is a forecast — `estimateLabel` is
 * the hard-coded `"UNVERIFIED"` so no caller can mistake a projection for a measured result (#200 FM#2).
 * The owner sees this on the proposal; only a real Stripe receipt later proves the actual outcome.
 */
export interface ExperimentProjection {
  baselineRevenueCents: number;
  candidateRevenueCents: number;
  /** candidate − baseline; positive = projected lift, negative = projected drop. */
  deltaCents: number;
  /** Signed percentage change vs. the baseline (0 when the baseline is 0). */
  deltaPct: number;
  /** ALWAYS `"UNVERIFIED"` — this is a forecast, not a result. */
  estimateLabel: "UNVERIFIED";
}

/**
 * Project the per-period revenue impact of a price change (#188 AC3). Pure arithmetic over the lens's
 * own conversion hypothesis: `revenue = price × conversions` for each arm, then the signed delta + pct.
 * Returns the `"UNVERIFIED"` label so the projection can never be confused with a measured outcome.
 * Defensive: negative inputs are clamped to 0 (a projection is never negative revenue).
 */
export function projectExperimentImpact(input: ExperimentProjectionInput): ExperimentProjection {
  const baselinePrice = Math.max(0, input.baselineAmountCents);
  const candidatePrice = Math.max(0, input.candidateAmountCents);
  const baselineConv = Math.max(0, input.baselineConversions);
  const candidateConv = Math.max(0, input.candidateConversions);
  const baselineRevenueCents = Math.round(baselinePrice * baselineConv);
  const candidateRevenueCents = Math.round(candidatePrice * candidateConv);
  const deltaCents = candidateRevenueCents - baselineRevenueCents;
  const deltaPct =
    baselineRevenueCents === 0 ? 0 : Math.round((deltaCents / baselineRevenueCents) * 1000) / 10;
  return {
    baselineRevenueCents,
    candidateRevenueCents,
    deltaCents,
    deltaPct,
    estimateLabel: "UNVERIFIED",
  };
}

/**
 * The verified outcome of a concluded experiment (#188 AC3) — built ONLY from externally-verified
 * revenue (a Stripe receipt over the test window), never from an estimate. `projectedDeltaCents` carries
 * the original forecast so the owner/scorecard can see forecast-vs-reality (the #200 taste-gap signal).
 */
export interface ExperimentResult {
  /** Externally-verified revenue collected during the test window (cents). */
  verifiedRevenueCents: number;
  /** The forecast made at proposal time, for the forecast-vs-reality comparison. */
  projectedDeltaCents: number;
  /** Verified revenue − the baseline the experiment proposed against. */
  realizedDeltaCents: number;
}

/** Compute the realized (verified) delta for a concluded experiment vs. its proposed baseline. */
export function summarizeExperimentResult(input: {
  verifiedRevenueCents: number;
  baselineRevenueCents: number;
  projectedDeltaCents: number;
}): ExperimentResult {
  const verifiedRevenueCents = Math.max(0, Math.round(input.verifiedRevenueCents));
  return {
    verifiedRevenueCents,
    projectedDeltaCents: Math.round(input.projectedDeltaCents),
    realizedDeltaCents: verifiedRevenueCents - Math.max(0, Math.round(input.baselineRevenueCents)),
  };
}

// ---- money-decision summaries (#188 AC2) ---------------------------------------------------------

/** The money-moving operations that must queue as a #13 MONEY decision (premortem FM#4). */
export const MONEY_DECISION_KINDS = ["activate_price", "price_change", "payout_settings"] as const;
export type MoneyDecisionKind = (typeof MONEY_DECISION_KINDS)[number];

/**
 * Format cents as a human amount (e.g. 2500 + usd → "$25.00"). Matches #98's `formatAmount` so the Slack
 * card reads identically to the billing surface. Falls back to "<amount> <CUR>" for non-usd currencies.
 */
export function formatMoney(amountCents: number, currency: string): string {
  const major = (amountCents / 100).toFixed(2);
  const symbol = currency.toLowerCase() === "usd" ? "$" : "";
  return symbol ? `${symbol}${major}` : `${major} ${currency.toUpperCase()}`;
}

/** Render a price with its interval suffix (e.g. "$25.00/month", or "$25.00" one-time). */
export function formatPrice(amountCents: number, currency: string, interval: PriceInterval | null): string {
  return `${formatMoney(amountCents, currency)}${interval ? `/${interval}` : ""}`;
}

/**
 * Build the EXACT-amount summary the owner approves for activating (or re-pricing) a venture's plan
 * (#188 AC2). When `previousAmountCents` is present, this is a price CHANGE and the line shows the
 * before→after so the owner sees precisely what customers will be charged. Pure so the queue card and
 * the Slack one-tap render the same string from the same payload.
 */
export function summarizeActivation(input: {
  ventureName: string;
  planName: string;
  amountCents: number;
  currency: string;
  interval: PriceInterval | null;
  previousAmountCents?: number | null;
}): string {
  const next = formatPrice(input.amountCents, input.currency, input.interval);
  if (typeof input.previousAmountCents === "number") {
    const prev = formatPrice(input.previousAmountCents, input.currency, input.interval);
    return `Re-price "${input.planName}" for ${input.ventureName}: ${prev} → ${next}`;
  }
  return `Activate "${input.planName}" pricing for ${input.ventureName}: ${next} (customers can pay)`;
}

/** Build the EXACT summary the owner approves for changing a venture's payout destination (#188 AC2). */
export function summarizePayoutSettings(input: { ventureName: string; destination: string }): string {
  return `Change payout settings for ${input.ventureName}: route to ${input.destination}`;
}
