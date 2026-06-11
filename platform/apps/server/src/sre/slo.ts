import type { ServiceSignal, SloEvaluation, SloObservation, SloTarget } from "./types.js";
import { breaches, severityFor } from "./guards.js";

/**
 * Pure SLO evaluation (#112, ADR-0112 §1). Given a per-service observation and its target, decide
 * whether the SLO is breached, how much **error budget** remains (0..1), and the severity. Like #17
 * `decideWorkflowAction` and #105 `decideRevival`, this is pure + unit-tested for every kind and
 * boundary; the engine reads the live signal and does the side effects.
 *
 * Budget semantics, by kind:
 *  - `availability`: the budget is the allowed-failure allowance `1 − target`. Remaining =
 *    `1 − observedErrorRate / allowance`, clamped 0..1. At the target the budget is exactly spent
 *    (remaining 0) but not breached; below the target it is breached with remaining 0.
 *  - `latency_p95` / `queue_lag`: a "lower is better" headroom budget. Remaining =
 *    `1 − overage / target` where `overage = max(0, value − target)`, clamped 0..1. At/under the
 *    target the budget is full; at 2× the target it is exhausted.
 */
export function evaluateSlo(target: SloTarget, observation: SloObservation): SloEvaluation {
  // No signal ⇒ nothing to judge: in-SLO, full budget. Prevents a quiet service from false-paging.
  if (observation.sampleCount <= 0) {
    return {
      kind: observation.kind,
      breached: false,
      budgetRemaining: 1,
      severity: "warning",
      value: observation.value,
      target: target.target,
    };
  }

  const breached = breaches(observation.kind, observation.value, target.target);
  const budgetRemaining = clamp01(budgetRemainingFor(target, observation.value));
  return {
    kind: observation.kind,
    breached,
    budgetRemaining,
    severity: severityFor(budgetRemaining, target.criticalAtBudgetBurn),
    value: observation.value,
    target: target.target,
  };
}

function budgetRemainingFor(target: SloTarget, value: number): number {
  if (target.kind === "availability") {
    const allowance = 1 - target.target; // allowed error rate
    if (allowance <= 0) return value >= 1 ? 1 : 0; // 100% target: any error ⇒ no budget
    const observedErrorRate = 1 - value;
    return 1 - observedErrorRate / allowance;
  }
  // latency_p95 / queue_lag: headroom up to the target.
  const overage = Math.max(0, value - target.target);
  if (target.target <= 0) return overage > 0 ? 0 : 1; // zero-tolerance target
  return 1 - overage / target.target;
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Map a raw per-service signal (read off `/metrics` + health) to one observation per SLO kind. A
 * failed health probe forces the availability observation to 0 with a non-zero sample count, so a
 * down dependency breaches even with no HTTP traffic.
 */
export function observeService(signal: ServiceSignal): SloObservation[] {
  const availabilityValue = !signal.healthy
    ? 0
    : signal.windowRequests > 0
      ? (signal.windowRequests - signal.windowErrors) / signal.windowRequests
      : 1;
  const availabilitySamples = signal.healthy
    ? signal.windowRequests
    : Math.max(1, signal.windowRequests);

  return [
    { kind: "availability", value: availabilityValue, sampleCount: availabilitySamples },
    {
      kind: "latency_p95",
      value: signal.p95LatencyMs,
      sampleCount: signal.p95LatencyMs > 0 ? signal.windowRequests : 0,
    },
    {
      kind: "queue_lag",
      value: signal.queueLagSeconds,
      sampleCount: signal.queueLagSeconds > 0 ? 1 : 0,
    },
  ];
}
