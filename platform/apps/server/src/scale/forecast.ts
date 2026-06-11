/**
 * Per-workspace compute-cost forecast + right-sizing + infra-ceiling gate (#113, ADR-0113). **Pure**:
 * given the `tenant_usage` trend (#71) and the resolved scale caps, project next window's spend,
 * recommend a scale call from live utilization, and flag a projected breach of the infra budget
 * ceiling (#108). No IO and no clock of its own — the whole thing is unit-tested in isolation (the
 * #17/#71/#96/#104 pure-core pattern). The Founder Console (#104) surfaces these; admission (#71) is
 * still the only thing that BLOCKS a launch — these are read-only signals, never a gate.
 */

/** One window's accrued usage (a `tenant_usage` row reduced to the trend inputs). */
export interface UsageTrendPoint {
  /** UTC `YYYY-MM` (calendar month). */
  window: string;
  computeSeconds: number;
  estimatedCostCents: number;
  sessionsStarted: number;
}

/** How the projection was derived: no history, a single point held flat, or a fitted trend. */
export type ForecastBasis = "empty" | "flat" | "trend";

export interface CostForecast {
  /** The window being forecast (the next calendar month). */
  window: string;
  projectedComputeSeconds: number;
  projectedCostCents: number;
  projectedSessionsStarted: number;
  basis: ForecastBasis;
  /** Forecast growth vs the last observed cost: `(projected − last)/last`; null when no nonzero base. */
  momChangePct: number | null;
}

/** Up to this many most-recent windows feed the slope — an old spike must not drag the projection. */
const TREND_LOOKBACK = 3;

/** Average of consecutive deltas over a series (the simple linear slope). `[]`/single → 0. */
function averageDelta(values: number[]): number {
  if (values.length < 2) return 0;
  return (values[values.length - 1]! - values[0]!) / (values.length - 1);
}

/** Project one metric: `last + averageDelta`, clamped to ≥ 0 and rounded. */
function projectMetric(values: number[]): number {
  const last = values[values.length - 1] ?? 0;
  return Math.max(0, Math.round(last + averageDelta(values)));
}

/**
 * Project next window's usage from the trend. Pure + deterministic + input-order-independent (the
 * trend is sorted by window first). 0 points → zeros (`empty`); 1 point → that point held (`flat`);
 * ≥2 → a clamped linear projection from the last {@link TREND_LOOKBACK} points (`trend`).
 */
export function forecastUsage(trend: UsageTrendPoint[], nextWindow: string): CostForecast {
  if (trend.length === 0) {
    return {
      window: nextWindow,
      projectedComputeSeconds: 0,
      projectedCostCents: 0,
      projectedSessionsStarted: 0,
      basis: "empty",
      momChangePct: null,
    };
  }

  const sorted = [...trend].sort((a, b) => (a.window < b.window ? -1 : a.window > b.window ? 1 : 0));
  const last = sorted[sorted.length - 1]!;

  if (sorted.length === 1) {
    return {
      window: nextWindow,
      projectedComputeSeconds: last.computeSeconds,
      projectedCostCents: last.estimatedCostCents,
      projectedSessionsStarted: last.sessionsStarted,
      basis: "flat",
      momChangePct: null,
    };
  }

  const recent = sorted.slice(-TREND_LOOKBACK);
  const projectedCostCents = projectMetric(recent.map((p) => p.estimatedCostCents));
  const projectedComputeSeconds = projectMetric(recent.map((p) => p.computeSeconds));
  const projectedSessionsStarted = projectMetric(recent.map((p) => p.sessionsStarted));

  return {
    window: nextWindow,
    projectedComputeSeconds,
    projectedCostCents,
    projectedSessionsStarted,
    basis: "trend",
    momChangePct:
      last.estimatedCostCents > 0
        ? (projectedCostCents - last.estimatedCostCents) / last.estimatedCostCents
        : null,
  };
}

export type RightSizingRecommendation = "scale_up" | "scale_down" | "hold";

export interface RightSizingInput {
  /** Sessions this tenant currently has in flight (#71 admission snapshot). */
  tenantInFlight: number;
  /** The tenant's in-flight cap; 0 = unlimited (no utilization to reason about). */
  tenantConcurrency: number;
}

export interface RightSizing {
  recommendation: RightSizingRecommendation;
  reason: string;
  /** `inFlight / cap` when a positive cap is set, else null (no cap → no utilization). */
  utilization: number | null;
}

/** Utilization at/above which we recommend adding capacity. */
const SCALE_UP_AT = 0.8;
/** Utilization at/below which we recommend shrinking (only when the cap is > 1). */
const SCALE_DOWN_AT = 0.2;

/**
 * Recommend a scale call from live utilization. Pure. With no positive cap there is nothing to
 * right-size (→ hold, null utilization). Saturated (≥ {@link SCALE_UP_AT}) → scale_up; idle
 * (≤ {@link SCALE_DOWN_AT}, cap > 1) → scale_down; otherwise hold. A cap of 1 is never shrunk.
 */
export function recommendRightSizing(input: RightSizingInput): RightSizing {
  const { tenantInFlight, tenantConcurrency } = input;
  if (tenantConcurrency <= 0) {
    return { recommendation: "hold", reason: "no concurrency cap set", utilization: null };
  }
  const utilization = tenantInFlight / tenantConcurrency;
  if (utilization >= SCALE_UP_AT) {
    return {
      recommendation: "scale_up",
      reason: `tenant concurrency ${Math.round(utilization * 100)}% utilized`,
      utilization,
    };
  }
  if (utilization <= SCALE_DOWN_AT && tenantConcurrency > 1) {
    return {
      recommendation: "scale_down",
      reason: `tenant concurrency only ${Math.round(utilization * 100)}% utilized`,
      utilization,
    };
  }
  return { recommendation: "hold", reason: "utilization within target band", utilization };
}

export interface InfraBudgetStatus {
  /** The configured infra ceiling in cents; 0 = no ceiling (never bites). */
  ceilingCents: number;
  projectedCostCents: number;
  /** Projected spend meets/passes a **positive** ceiling. */
  exceeded: boolean;
  /** `max(0, ceiling − projected)` under a positive ceiling, else null. */
  headroomCents: number | null;
  /** `projected / ceiling` under a positive ceiling, else null. */
  utilization: number | null;
}

/**
 * Whether the projected spend breaches the infra budget ceiling (#108). Pure. A 0/undefined ceiling
 * never bites (mirrors {@link budgetExceeded}). Read-only: this warns the founder; it never blocks a
 * launch (admission/#71 stays the only gate).
 */
export function infraBudgetStatus(projectedCostCents: number, ceilingCents: number): InfraBudgetStatus {
  if (ceilingCents <= 0) {
    return {
      ceilingCents: 0,
      projectedCostCents,
      exceeded: false,
      headroomCents: null,
      utilization: null,
    };
  }
  return {
    ceilingCents,
    projectedCostCents,
    exceeded: projectedCostCents >= ceilingCents,
    headroomCents: Math.max(0, ceilingCents - projectedCostCents),
    utilization: projectedCostCents / ceilingCents,
  };
}
