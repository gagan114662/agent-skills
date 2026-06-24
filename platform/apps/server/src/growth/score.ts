import type { GrowthCaps } from "./caps.js";
import {
  isGrowthEventKind,
  type ExperimentStage,
  type FunnelRates,
  type GrowthEventRecord,
  type GrowthExperimentSuggestion,
  type GrowthFunnel,
  type GrowthScore,
  type GrowthSourceMetric,
} from "./types.js";

/**
 * The Growth Loop scoring math (#102, ADR-0102). **Pure + unit-tested**: the service does the IO
 * (read the events, persist the experiment, submit the #13 gate); these functions turn raw events into
 * the funnel, the rates, the 0–100 score, the #96 scorecard signal, and the "next experiments" — the
 * deterministic core, the #96 `rubric.ts` / #117 `decide.ts` split.
 */

/** Per-stage weights for the composite score; sum to 1 so a perfect funnel scores exactly 100. */
export const DEFAULT_GROWTH_WEIGHTS = {
  activation: 0.4,
  conversion: 0.35,
  retention: 0.25,
} as const;

/** Clamp a ratio into `[0,1]`, treating a non-positive denominator (and NaN) as 0. */
function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  const r = numerator / denominator;
  if (Number.isNaN(r)) return 0;
  return Math.max(0, Math.min(1, r));
}

/** Sum each event's `value` into its funnel stage; negative weights and unknown kinds are ignored. */
export function funnelFromEvents(events: readonly GrowthEventRecord[]): GrowthFunnel {
  const funnel: GrowthFunnel = { acquisition: 0, activation: 0, conversion: 0, retention: 0 };
  for (const e of events) {
    if (!isGrowthEventKind(e.kind)) continue;
    if (typeof e.value !== "number" || e.value <= 0) continue;
    funnel[e.kind] += e.value;
  }
  return funnel;
}

/** Stage-to-stage conversion rates, each guarded into `[0,1]` (`x/0 = 0`). */
export function funnelRates(funnel: GrowthFunnel): FunnelRates {
  return {
    activationRate: ratio(funnel.activation, funnel.acquisition),
    conversionRate: ratio(funnel.conversion, funnel.activation),
    retentionRate: ratio(funnel.retention, funnel.activation),
  };
}

/** Aggregate the same funnel by source cohort so volume and quality can be compared by channel. */
export function sourceMetricsFromEvents(events: readonly GrowthEventRecord[]): GrowthSourceMetric[] {
  const bySource = new Map<string, GrowthFunnel>();
  for (const e of events) {
    if (!isGrowthEventKind(e.kind)) continue;
    if (typeof e.value !== "number" || e.value <= 0) continue;
    const source = e.source || "(unattributed)";
    const funnel = bySource.get(source) ?? { acquisition: 0, activation: 0, conversion: 0, retention: 0 };
    funnel[e.kind] += e.value;
    bySource.set(source, funnel);
  }
  return [...bySource.entries()]
    .map(([source, funnel]) => ({
      source,
      ...funnel,
      conversionRate: ratio(funnel.conversion, funnel.acquisition),
    }))
    .sort((a, b) => b.acquisition - a.acquisition || b.conversionRate - a.conversionRate || a.source.localeCompare(b.source));
}

/**
 * The 0–100 growth score: the weighted mean of the three funnel rates, scaled to 100. Forced to 0 when
 * acquisition is below `caps.minTrafficForScore` (a high rate off a handful of visitors is noise, not
 * signal). Carries the funnel + rates through for the dashboard.
 */
export function scoreGrowth(funnel: GrowthFunnel, caps: GrowthCaps): GrowthScore {
  const rates = funnelRates(funnel);
  if (funnel.acquisition < caps.minTrafficForScore) {
    return { score: 0, rates, funnel };
  }
  const w = DEFAULT_GROWTH_WEIGHTS;
  const mean =
    w.activation * rates.activationRate +
    w.conversion * rates.conversionRate +
    w.retention * rates.retentionRate;
  const score = Math.max(0, Math.min(100, mean * 100));
  return { score, rates, funnel };
}

/** Map a 0–100 growth score onto the #96 rubric's 0–10 distribution-signal band (clamped). */
export function growthToVentureSignal(score: number): number {
  if (Number.isNaN(score)) return 0;
  return Math.max(0, Math.min(10, score / 10));
}

/** The channel + hypothesis to try when a given funnel stage is the bottleneck. */
const STAGE_PLAYBOOK: Record<ExperimentStage, { channel: string; hypothesis: string }> = {
  activation: {
    channel: "onboarding",
    hypothesis: "Streamline first-run onboarding + the landing page to lift activation.",
  },
  conversion: {
    channel: "pricing",
    hypothesis: "Sharpen the pricing page and the primary CTA to lift conversion.",
  },
  retention: {
    channel: "lifecycle",
    hypothesis: "Add a lifecycle email sequence to bring activated users back (retention).",
  },
};

/**
 * The next experiments to run, the **weakest funnel stage first** (the growth tick's "next 3"). One
 * suggestion per stage so the marketing fleet (#123) and the portfolio loop (#107) always get a ranked
 * three; ties hold the natural funnel order (activation → conversion → retention) via a stable sort.
 */
export function recommendExperiments(funnel: GrowthFunnel): GrowthExperimentSuggestion[] {
  const rates = funnelRates(funnel);
  const stages: { stage: ExperimentStage; rate: number }[] = [
    { stage: "activation", rate: rates.activationRate },
    { stage: "conversion", rate: rates.conversionRate },
    { stage: "retention", rate: rates.retentionRate },
  ];
  stages.sort((a, b) => a.rate - b.rate); // weakest first; Array.sort is stable, so ties hold order
  return stages.map((s) => ({ stage: s.stage, ...STAGE_PLAYBOOK[s.stage] }));
}
