/**
 * Weekly growth report (issue #620) — domain types.
 *
 * The problem #620 fixes: there is no periodic synthesis of *what worked* and *what to do next*. The fix is a
 * weekly report — metrics, wins, experiments, and recommended next bets — that the analyst agent can produce
 * automatically with data-backed recommendations.
 *
 * This file is the vocabulary shared by the three layers of the module:
 *   - the **input** the data-source seam supplies for a week ({@link WeeklyGrowthData}),
 *   - the **pure synthesis** that turns that input into a report (see `synthesize.ts`),
 *   - the **report** itself ({@link WeeklyReport}), which the store persists and the renderer prints.
 *
 * Everything here is plain data — no IO, no clock, no DB — so the synthesis core stays pure and deterministic.
 */

/** The inclusive-start / exclusive-end window a report covers. ISO `YYYY-MM-DD` strings (no clock dependency). */
export interface ReportPeriod {
  /** Monday of the reported week, `YYYY-MM-DD`. */
  weekStart: string;
  /** Monday of the following week (exclusive end), `YYYY-MM-DD`. */
  weekEnd: string;
}

/**
 * One headline growth metric for the week, with the prior week's value so a delta can be computed. The
 * data-source supplies the raw numbers; the synthesis core derives the delta and direction.
 */
export interface MetricInput {
  /** Stable machine key, e.g. `signups`, `mrr`, `churn_rate`. */
  key: string;
  /** Human label, e.g. "New signups". */
  label: string;
  /** This week's value. */
  value: number;
  /** Last week's value (for the delta). */
  priorValue: number;
  /** Display unit, e.g. `count`, `usd`, `%`. Optional. */
  unit?: string;
  /**
   * Whether a higher value is good (signups, revenue) or bad (churn, CAC). Defaults to `true`. This decides
   * whether a movement counts as a win or a regression — it is NOT inferred from the sign of the delta.
   */
  higherIsBetter?: boolean;
}

/** The outcome of a growth experiment run (or still running) during the week. */
export type ExperimentStatus = "win" | "loss" | "inconclusive" | "running";

/** One growth experiment the team ran (or is running) this week. */
export interface ExperimentInput {
  /** Stable id. */
  id: string;
  /** Human name, e.g. "Pricing page social proof". */
  name: string;
  /** What was being tested. */
  hypothesis: string;
  status: ExperimentStatus;
  /** The metric the experiment targeted, e.g. `signups`. Optional. */
  metricKey?: string;
  /**
   * Observed relative lift as a fraction (0.12 = +12%), signed. Positive = improvement on the target metric.
   * Optional — `running`/`inconclusive` experiments may have none yet.
   */
  lift?: number;
}

/** Everything the data-source provides for one workspace-week — the sole input to the pure synthesis. */
export interface WeeklyGrowthData {
  workspaceId: string;
  period: ReportPeriod;
  metrics: MetricInput[];
  experiments: ExperimentInput[];
}

/** A metric after the synthesis core has computed its movement. */
export interface MetricSummary {
  key: string;
  label: string;
  value: number;
  priorValue: number;
  unit?: string;
  higherIsBetter: boolean;
  /** `value - priorValue`. */
  delta: number;
  /** Relative change as a fraction (`delta / |priorValue|`), or null when `priorValue` is 0. */
  deltaPct: number | null;
  /** `up` / `down` / `flat` by raw sign of the delta. */
  direction: "up" | "down" | "flat";
  /** Whether the movement is in the good direction (an `up` on a higher-is-better metric, etc.). */
  improved: boolean;
}

/** A data-backed win surfaced for the week (a metric that improved, or an experiment that won). */
export interface ReportWin {
  /** Where the win came from. */
  source: "metric" | "experiment";
  /** Short headline, e.g. "New signups up 18%". */
  headline: string;
  /** The evidence sentence, e.g. "Pricing experiment drove +12% on signups". */
  detail: string;
  /** A magnitude used to rank wins (the relative improvement as a fraction, always >= 0). */
  magnitude: number;
}

/** An experiment after synthesis — normalized for display in the report. */
export interface ExperimentSummary {
  id: string;
  name: string;
  hypothesis: string;
  status: ExperimentStatus;
  metricKey?: string;
  lift?: number;
}

/**
 * A recommended next bet: a concrete, prioritized action with a data-backed rationale. This is the core of
 * the acceptance criterion — recommendations must be *data-backed*, so every bet carries the evidence that
 * produced it.
 */
export interface NextBet {
  /** Stable kind, used for grouping/ranking. */
  kind: "scale_winner" | "fix_regression" | "extend_experiment" | "keep_steady";
  /** The recommended action, e.g. "Scale 'Pricing page social proof'". */
  action: string;
  /** Why — cites the metric/experiment evidence behind the recommendation. */
  rationale: string;
  /** Priority band, derived from the impact score. */
  priority: "high" | "medium" | "low";
  /** Numeric impact used to rank bets (higher = more important). */
  impact: number;
}

/** The synthesized weekly growth report — what gets persisted, rendered, and shown to the user. */
export interface WeeklyReport {
  workspaceId: string;
  period: ReportPeriod;
  /** A one-line synthesis of the week. */
  headline: string;
  metrics: MetricSummary[];
  wins: ReportWin[];
  experiments: ExperimentSummary[];
  /** Recommended next bets, ranked most-impactful first. */
  nextBets: NextBet[];
}
