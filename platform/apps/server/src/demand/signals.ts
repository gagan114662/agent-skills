import {
  DEMAND_SIGNAL_CLASSES,
  isExternallyAttributed,
  type DemandSignal,
  type DemandSignalClass,
} from "./provenance.js";

/**
 * Funnel telemetry (#101). **Pure** aggregation of demand signals into per-stage counts and the
 * stage-to-stage conversion rates the experiment registry evaluates against its locked bar.
 *
 * Only **externally-attributed** signals are counted — a self-generated "visit" cannot inflate a funnel
 * (the circularity #101 exists to kill). The funnel is therefore evidence of real strangers acting, by
 * construction.
 */

/** Per-class counts over the externally-attributed signals. */
export type FunnelCounts = Record<DemandSignalClass, number>;

/** Stage-to-stage conversion rates (0 when the denominator stage is empty — never NaN). */
export interface FunnelConversion {
  visitToCta: number;
  ctaToCheckout: number;
  checkoutToPaid: number;
  visitToPaid: number;
}

export interface Funnel {
  counts: FunnelCounts;
  /** Sum of the amounts on real `paid` signals (the realized willingness-to-pay). */
  paidAmountCents: number;
  conversion: FunnelConversion;
}

/** Relative strength of a signal class (`paid` strongest) — drives the demand-dimension score. */
export function signalStrength(c: DemandSignalClass): number {
  return DEMAND_SIGNAL_CLASSES.indexOf(c) + 1; // visit=1 … paid=5
}

/** Safe ratio: 0 when the denominator is 0 (avoids NaN in an empty-stage funnel). */
function ratio(numerator: number, denominator: number): number {
  return denominator > 0 ? numerator / denominator : 0;
}

/** Aggregate externally-attributed signals into per-stage counts + conversion rates. */
export function aggregateFunnel(signals: DemandSignal[]): Funnel {
  const counts: FunnelCounts = {
    visit: 0,
    cta_click: 0,
    checkout_started: 0,
    waitlist: 0,
    paid: 0,
  };
  let paidAmountCents = 0;
  for (const s of signals) {
    // Circular evidence cannot move the funnel — only real, externally-attributed actions count.
    if (!isExternallyAttributed(s.provenance)) continue;
    counts[s.signalClass] += 1;
    if (s.signalClass === "paid") paidAmountCents += Math.max(0, s.amountCents);
  }
  return {
    counts,
    paidAmountCents,
    conversion: {
      visitToCta: ratio(counts.cta_click, counts.visit),
      ctaToCheckout: ratio(counts.checkout_started, counts.cta_click),
      checkoutToPaid: ratio(counts.paid, counts.checkout_started),
      visitToPaid: ratio(counts.paid, counts.visit),
    },
  };
}
