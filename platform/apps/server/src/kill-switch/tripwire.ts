/**
 * Fleet dead-man's switch (issue #592) — the PURE tripwire decision. A misbehaving loop can keep acting while
 * the guard KPIs collapse or spend spikes; this function looks at the current fleet-wide guard metrics and
 * decides whether a tripwire has been breached and the whole fleet should be paused.
 *
 * This is the GLOBAL switch — distinct from the per-workspace #17 kill switch. It compares each monitored
 * metric against a ceiling and reports every breach (not just the first), so the alert names exactly which
 * KPIs cratered.
 *
 * Premortem (#200) encoded in the SHAPE:
 *  - **§6 injection defense / fail-closed.** Every decision is a pure function of NUMBERS — it never reads
 *    agent/provider free text, so a poisoned observability read can never *suppress* a trip. The metrics come
 *    from a monitoring read that could itself be degraded, so an INDETERMINATE reading (NaN/±Infinity) on a
 *    MONITORED metric is treated as a breach: pausing the fleet is cheap and reversible, while continuing to
 *    act on metrics we cannot trust is the exact failure mode #592 exists to stop. A negative reading clamps
 *    to 0 (a sensor cannot manufacture a *better-than-zero* signal that hides a real problem).
 *  - **A threshold of "unmonitored".** A threshold that is null / non-finite / ≤ 0 means "do not monitor this
 *    metric" — it can never breach. Only an explicit, positive ceiling arms a tripwire, so an empty config is
 *    an armed-but-inert switch (purely manual) rather than one that trips on everything.
 *
 * No IO, no clock — the service loads the metrics and persists the resulting switch state.
 */

/** A guard metric the dead-man's switch watches. */
export type GuardMetric = "spend_per_hour" | "error_rate" | "bounce_rate";

/** The current fleet-wide guard readings (a single monitoring snapshot). */
export interface GuardMetrics {
  /** Spend rate over the last hour, in cents. A spend SPIKE is the canonical #592 trigger. */
  spendPerHourCents: number;
  /** Share of recent agent actions that errored, in basis points (0–10000). */
  errorRateBps: number;
  /** Share of recent outbound that bounced, in basis points (0–10000). */
  bounceRateBps: number;
}

/**
 * The ceilings each metric may not cross. A `null` (or non-finite / non-positive) ceiling leaves that metric
 * UNMONITORED — it can never trip. Values are in the same units as {@link GuardMetrics}.
 */
export interface TripwireThresholds {
  maxSpendPerHourCents: number | null;
  maxErrorRateBps: number | null;
  maxBounceRateBps: number | null;
}

/** A single breached tripwire — which metric, what we observed, and the ceiling it crossed. */
export interface TripwireBreach {
  metric: GuardMetric;
  /** The reading that breached (after fail-closed normalization; `null` when the reading was indeterminate). */
  observed: number | null;
  /** The ceiling that was crossed. */
  threshold: number;
  /** Human-readable explanation, surfaced in the alert and asserted in tests. */
  reason: string;
}

/** The verdict of one tripwire pass over the fleet metrics. */
export interface TripwireEvaluation {
  /** True when at least one monitored metric breached its ceiling. */
  breached: boolean;
  /** Every breach this pass (empty when none). */
  breaches: TripwireBreach[];
}

/** Is this threshold an armed ceiling? Only a finite, strictly-positive value monitors its metric. */
function isArmed(threshold: number | null): threshold is number {
  return threshold !== null && Number.isFinite(threshold) && threshold > 0;
}

/** Pretty units for the breach reason. */
function fmt(metric: GuardMetric, value: number): string {
  if (metric === "spend_per_hour") return `$${(value / 100).toFixed(2)}/hr`;
  return `${(value / 100).toFixed(1)}%`;
}

/**
 * Evaluate one metric against its ceiling, fail-closed. Returns a breach, or null when the metric is within
 * bounds or unmonitored.
 */
function checkMetric(
  metric: GuardMetric,
  rawObserved: number,
  threshold: number | null,
): TripwireBreach | null {
  if (!isArmed(threshold)) return null; // unmonitored — never trips

  // #200 fail-closed: an indeterminate reading on a MONITORED metric trips the switch.
  if (!Number.isFinite(rawObserved)) {
    return {
      metric,
      observed: null,
      threshold,
      reason: `${metric} reading is indeterminate — tripping (cannot confirm the fleet is healthy)`,
    };
  }

  // A negative reading cannot hide a problem: clamp it to 0 (a sensor never reports better-than-nothing).
  const observed = rawObserved > 0 ? rawObserved : 0;
  if (observed >= threshold) {
    return {
      metric,
      observed,
      threshold,
      reason: `${metric} at ${fmt(metric, observed)} reached the ${fmt(metric, threshold)} ceiling`,
    };
  }
  return null;
}

/**
 * The dead-man's switch tripwire pass. Pure + total: given a fleet metrics snapshot and the configured
 * ceilings, report every breached tripwire. `breached` is true iff at least one monitored metric crossed.
 */
export function evaluateTripwires(
  metrics: GuardMetrics,
  thresholds: TripwireThresholds,
): TripwireEvaluation {
  const breaches: TripwireBreach[] = [];
  const spend = checkMetric("spend_per_hour", metrics.spendPerHourCents, thresholds.maxSpendPerHourCents);
  if (spend) breaches.push(spend);
  const error = checkMetric("error_rate", metrics.errorRateBps, thresholds.maxErrorRateBps);
  if (error) breaches.push(error);
  const bounce = checkMetric("bounce_rate", metrics.bounceRateBps, thresholds.maxBounceRateBps);
  if (bounce) breaches.push(bounce);
  return { breached: breaches.length > 0, breaches };
}

/** A one-line summary of an evaluation's breaches (for the alert message / logs). */
export function summarizeBreaches(breaches: TripwireBreach[]): string {
  if (breaches.length === 0) return "no tripwires breached";
  return breaches.map((b) => b.reason).join("; ");
}
