/**
 * Multi-touch attribution: the pure credit math for #614 — tie each paying customer back to the full chain
 * of agent actions + channels that influenced them.
 *
 * `touches (agent action on a channel) → … → payment`. Where the #386 single-touch ledger credits ONE
 * originating artifact (the earliest exposure per tracking ref), this distributes a customer's paid revenue
 * across EVERY touch that happened-before the payment, by a chosen {@link AttributionModel}. Credit only ever
 * flows backward in time (a touch shown after the payment cannot have caused it) and only from real, already
 * existing payments — this module fabricates no revenue.
 *
 * Pure: no IO, no clock, no randomness. Every function is a total, deterministic transform over plain data,
 * unit-tested with literals. The injected `now`/repos live in `service.ts`.
 */

import {
  DEFAULT_ATTRIBUTION_MODEL,
  type AttributionModel,
  type CustomerJourney,
  type DimensionCredit,
  type Payment,
  type Touch,
  type TouchCredit,
} from "./types.js";

export interface BuildJourneysOptions {
  /** The multi-touch model that splits each customer's revenue across their touches. Default `linear`. */
  model?: AttributionModel;
  /**
   * A touch older than this many ms before the customer's first payment is too stale to have plausibly
   * caused it, so it earns no credit. Omit for no staleness ceiling (every prior touch is eligible).
   */
  maxChainAgeMs?: number;
}

/**
 * The fractional weights a model assigns across `n` ordered touches (earliest→latest). Always length `n` and
 * sums to 1 (for `n >= 1`); `n === 0` ⇒ `[]`. The single-touch case collapses every model to `[1]`.
 */
export function weightsFor(model: AttributionModel, n: number): number[] {
  if (n <= 0) return [];
  if (n === 1) return [1];
  switch (model) {
    case "first_touch": {
      const w = new Array<number>(n).fill(0);
      w[0] = 1;
      return w;
    }
    case "last_touch": {
      const w = new Array<number>(n).fill(0);
      w[n - 1] = 1;
      return w;
    }
    case "linear":
      return new Array<number>(n).fill(1 / n);
    case "position_based": {
      if (n === 2) return [0.5, 0.5];
      // 40% first, 40% last, the remaining 20% split evenly across the middle (U-shaped).
      const middle = 0.2 / (n - 2);
      const w = new Array<number>(n).fill(middle);
      w[0] = 0.4;
      w[n - 1] = 0.4;
      return w;
    }
    default:
      return new Array<number>(n).fill(1 / n);
  }
}

/**
 * Split `totalCents` into `weights.length` integer cents proportional to `weights`, summing EXACTLY to
 * `totalCents` (largest-remainder rounding so no cent is lost or invented). Assumes non-negative integer
 * `totalCents` and weights summing to ~1.
 */
export function distributeCents(totalCents: number, weights: readonly number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const raw = weights.map((w) => w * totalCents);
  const out = raw.map((r) => Math.floor(r));
  let remainder = totalCents - out.reduce((a, b) => a + b, 0);
  // Hand the leftover cents to the touches with the largest fractional parts (ties broken by index).
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => (b.frac !== a.frac ? b.frac - a.frac : a.i - b.i));
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) {
    const slot = order[k];
    if (slot) out[slot.i] = (out[slot.i] ?? 0) + 1;
  }
  return out;
}

/** Distinct values in order of first appearance. */
function distinctInOrder(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Build one customer's journey from their touches + payments under a model. Touches are ordered
 * earliest→latest; only those that happened at or before the earliest payment (and within `maxChainAgeMs`,
 * if set) are eligible to earn credit. A customer with no eligible touch still yields a journey with empty
 * `touches`/`credits` — the revenue is honestly unattributed.
 */
export function buildJourney(
  customerRef: string,
  touches: readonly Touch[],
  payments: readonly Payment[],
  opts: BuildJourneysOptions = {},
): CustomerJourney {
  const model = opts.model ?? DEFAULT_ATTRIBUTION_MODEL;
  const sortedPayments = [...payments].sort((a, b) => a.paidAtMs - b.paidAtMs);
  const totalPaidCents = sortedPayments.reduce((sum, p) => sum + p.amountCents, 0);
  const paidAtMs = sortedPayments[0]?.paidAtMs ?? 0;
  const currency = sortedPayments[0]?.currency ?? "usd";

  const eligible = [...touches]
    .filter((t) => {
      if (t.occurredAtMs > paidAtMs) return false; // L2: no backward causality.
      if (opts.maxChainAgeMs !== undefined && paidAtMs - t.occurredAtMs > opts.maxChainAgeMs) return false;
      return true;
    })
    .sort((a, b) => (a.occurredAtMs !== b.occurredAtMs ? a.occurredAtMs - b.occurredAtMs : a.artifactId < b.artifactId ? -1 : 1));

  const weights = weightsFor(model, eligible.length);
  const creditCents = distributeCents(totalPaidCents, weights);
  const credits: TouchCredit[] = eligible.map((t, i) => ({
    channel: t.channel,
    agent: t.agent,
    kind: t.kind,
    artifactId: t.artifactId,
    occurredAtMs: t.occurredAtMs,
    weight: weights[i] ?? 0,
    creditCents: creditCents[i] ?? 0,
  }));

  return {
    customerRef,
    currency,
    touches: eligible,
    payments: sortedPayments,
    totalPaidCents,
    paymentCount: sortedPayments.length,
    firstTouchAtMs: eligible[0]?.occurredAtMs ?? null,
    lastTouchAtMs: eligible[eligible.length - 1]?.occurredAtMs ?? null,
    paidAtMs,
    touchCount: eligible.length,
    channels: distinctInOrder(eligible.map((t) => t.channel)),
    agents: distinctInOrder(eligible.map((t) => t.agent)),
    model,
    credits,
  };
}

/**
 * Group touches + payments by `customerRef` and build a {@link CustomerJourney} for every customer that has
 * at least one payment. Touch-only customers (no payment yet) produce no journey — attribution is about
 * customers who actually paid. Journeys are returned highest-revenue first (ties broken by `customerRef`).
 */
export function buildJourneys(
  touches: readonly Touch[],
  payments: readonly Payment[],
  opts: BuildJourneysOptions = {},
): CustomerJourney[] {
  const touchesByRef = new Map<string, Touch[]>();
  for (const t of touches) {
    const list = touchesByRef.get(t.customerRef);
    if (list) list.push(t);
    else touchesByRef.set(t.customerRef, [t]);
  }
  const paymentsByRef = new Map<string, Payment[]>();
  for (const p of payments) {
    const list = paymentsByRef.get(p.customerRef);
    if (list) list.push(p);
    else paymentsByRef.set(p.customerRef, [p]);
  }

  const journeys: CustomerJourney[] = [];
  for (const [ref, refPayments] of paymentsByRef) {
    journeys.push(buildJourney(ref, touchesByRef.get(ref) ?? [], refPayments, opts));
  }
  return journeys.sort((a, b) =>
    b.totalPaidCents !== a.totalPaidCents
      ? b.totalPaidCents - a.totalPaidCents
      : a.customerRef < b.customerRef
        ? -1
        : a.customerRef > b.customerRef
          ? 1
          : 0,
  );
}

/** Roll multi-touch credit up by a chosen dimension of each touch. */
function rollupBy(
  journeys: readonly CustomerJourney[],
  dimension: (c: TouchCredit) => string,
): DimensionCredit[] {
  const acc = new Map<string, { attributedCents: number; touchCount: number; customers: Set<string> }>();
  for (const j of journeys) {
    for (const c of j.credits) {
      const key = dimension(c);
      const cur = acc.get(key) ?? { attributedCents: 0, touchCount: 0, customers: new Set<string>() };
      cur.attributedCents += c.creditCents;
      cur.touchCount += 1;
      cur.customers.add(j.customerRef);
      acc.set(key, cur);
    }
  }
  return [...acc.entries()]
    .map(([key, v]) => ({
      key,
      attributedCents: v.attributedCents,
      touchCount: v.touchCount,
      customerCount: v.customers.size,
    }))
    .sort((a, b) => (b.attributedCents !== a.attributedCents ? b.attributedCents - a.attributedCents : a.key < b.key ? -1 : 1));
}

/** Multi-touch attributed revenue by channel, highest first. */
export function rollupByChannel(journeys: readonly CustomerJourney[]): DimensionCredit[] {
  return rollupBy(journeys, (c) => c.channel);
}

/** Multi-touch attributed revenue by agent, highest first. */
export function rollupByAgent(journeys: readonly CustomerJourney[]): DimensionCredit[] {
  return rollupBy(journeys, (c) => c.agent);
}
