/**
 * Perf-budget gate + latency math (#113, ADR-0113). **Pure**: the percentile/throughput summary and
 * the regression gate the CI `perf` job fails the PR on. Kept dependency-free and unit-testable with
 * no network (the driver in `./driver.ts` produces the {@link PerfResult}s this evaluates). Budgets are
 * deliberately **floor guards against catastrophic regression** (generous absolute thresholds), not
 * tight SLOs — so the gate catches a 10× slowdown without flapping on shared-runner noise.
 */

/** One scenario's measured outcome (produced by `runLoad`). */
export interface PerfResult {
  name: string;
  /** Total requests issued. */
  requests: number;
  /** Wall-clock duration of the run, ms. */
  durationMs: number;
  /** Throughput: requests per second. */
  rps: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  /** Requests that threw or returned `{ ok: false }`. */
  errors: number;
  /** `errors / requests` (0 when no requests). */
  errorRate: number;
}

/** A declared budget for a scenario. Every bound is optional — only what's set is enforced. */
export interface PerfBudget {
  name: string;
  /** Minimum acceptable throughput (req/s). */
  minRps?: number;
  /** Maximum acceptable median latency (ms). */
  maxP50Ms?: number;
  /** Maximum acceptable tail latency (ms). */
  maxP99Ms?: number;
  /** Maximum acceptable error rate (fraction 0..1). */
  maxErrorRate?: number;
}

export type BudgetMetric = "rps" | "p50Ms" | "p99Ms" | "errorRate";

export interface BudgetViolation {
  name: string;
  metric: BudgetMetric;
  /** The threshold that was breached. */
  budget: number;
  /** The measured value. */
  actual: number;
}

export interface BudgetEvaluation {
  ok: boolean;
  violations: BudgetViolation[];
}

export interface LatencySummary {
  count: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

/** Nearest-rank percentile (`q` in 0..1) over latency samples (ms). Empty → 0. Order-independent. */
export function percentile(samplesMs: number[], q: number): number {
  if (samplesMs.length === 0) return 0;
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[idx]!;
}

/** p50/p99/max/mean over latency samples (ms). Empty → all zeros. */
export function summarize(samplesMs: number[]): LatencySummary {
  if (samplesMs.length === 0) return { count: 0, p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0 };
  const sum = samplesMs.reduce((a, b) => a + b, 0);
  return {
    count: samplesMs.length,
    p50Ms: percentile(samplesMs, 0.5),
    p99Ms: percentile(samplesMs, 0.99),
    maxMs: Math.max(...samplesMs),
    meanMs: sum / samplesMs.length,
  };
}

/** The capacity-model anchor: throughput per vCPU. A zero/negative core count → the raw rps. */
export function rpsPerVcpu(rps: number, vcpus: number): number {
  return vcpus > 0 ? rps / vcpus : rps;
}

/**
 * Evaluate measured results against declared budgets. A budget with no matching result is itself a
 * violation (the scenario never ran). Results with no budget are ignored (only declared budgets gate).
 * Returns every breached metric — not just the first — so one run shows all the regressions.
 */
export function evaluateBudgets(results: PerfResult[], budgets: PerfBudget[]): BudgetEvaluation {
  const byName = new Map(results.map((r) => [r.name, r]));
  const violations: BudgetViolation[] = [];

  for (const b of budgets) {
    const r = byName.get(b.name);
    if (!r) {
      violations.push({ name: b.name, metric: "rps", budget: b.minRps ?? 0, actual: 0 });
      continue;
    }
    if (b.minRps !== undefined && r.rps < b.minRps) {
      violations.push({ name: b.name, metric: "rps", budget: b.minRps, actual: r.rps });
    }
    if (b.maxP50Ms !== undefined && r.p50Ms > b.maxP50Ms) {
      violations.push({ name: b.name, metric: "p50Ms", budget: b.maxP50Ms, actual: r.p50Ms });
    }
    if (b.maxP99Ms !== undefined && r.p99Ms > b.maxP99Ms) {
      violations.push({ name: b.name, metric: "p99Ms", budget: b.maxP99Ms, actual: r.p99Ms });
    }
    if (b.maxErrorRate !== undefined && r.errorRate > b.maxErrorRate) {
      violations.push({ name: b.name, metric: "errorRate", budget: b.maxErrorRate, actual: r.errorRate });
    }
  }

  return { ok: violations.length === 0, violations };
}
