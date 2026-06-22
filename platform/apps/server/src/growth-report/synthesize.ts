/**
 * Weekly growth report — the **pure synthesis core** (issue #620).
 *
 * `synthesizeWeeklyReport` is a deterministic, side-effect-free function from one week's raw growth data to a
 * finished {@link WeeklyReport}: it computes each metric's movement, surfaces the wins (metrics that improved
 * and experiments that won), normalizes the experiments, and — the heart of the acceptance criterion —
 * derives a ranked list of **data-backed recommended next bets**. Every bet carries the exact metric or
 * experiment evidence that produced it, so a recommendation can always be justified.
 *
 * No IO, no clock, no randomness: given the same {@link WeeklyGrowthData} it always produces the same report,
 * which is what makes the whole module unit-testable with no database and no network (the #17
 * pure-decision + injected-seam pattern). The service layer (`service.ts`) supplies the data and persists the
 * result; this file only thinks.
 */

import type {
  ExperimentSummary,
  MetricInput,
  MetricSummary,
  NextBet,
  ReportWin,
  WeeklyGrowthData,
  WeeklyReport,
} from "./types.js";

/** Impact (in percentage-points) at/above which a next bet is `high` priority. */
export const HIGH_PRIORITY_IMPACT = 15;
/** Impact at/above which a next bet is `medium` priority (below it is `low`). */
export const MEDIUM_PRIORITY_IMPACT = 7;

/** Format a fraction (`0.18`) as a signed percent string (`"+18%"`); sub-1% magnitudes keep one decimal. */
export function formatPct(fraction: number): string {
  const pct = fraction * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "−" : "";
  const abs = Math.abs(pct);
  const body = abs > 0 && abs < 1 ? abs.toFixed(1) : String(Math.round(abs));
  return `${sign}${body}%`;
}

/** Compute one metric's movement: delta, relative change, direction, and whether it improved. Pure. */
export function summarizeMetric(m: MetricInput): MetricSummary {
  const higherIsBetter = m.higherIsBetter ?? true;
  const delta = m.value - m.priorValue;
  const deltaPct = m.priorValue === 0 ? null : delta / Math.abs(m.priorValue);
  const direction: MetricSummary["direction"] = delta > 0 ? "up" : delta < 0 ? "down" : "flat";
  const improved = direction === "flat" ? false : (direction === "up") === higherIsBetter;
  return {
    key: m.key,
    label: m.label,
    value: m.value,
    priorValue: m.priorValue,
    unit: m.unit,
    higherIsBetter,
    delta,
    deltaPct,
    direction,
    improved,
  };
}

/**
 * The magnitude (a non-negative fraction) used to rank a metric movement. Uses the relative change when a
 * prior value exists; when the prior was 0 but the metric moved, it counts as a full "new" signal (1.0).
 */
function metricMagnitude(s: MetricSummary): number {
  if (s.deltaPct !== null) return Math.abs(s.deltaPct);
  return s.delta !== 0 ? 1 : 0;
}

function describeMovement(s: MetricSummary): string {
  if (s.deltaPct !== null) return `${s.direction} ${formatPct(s.deltaPct)}`;
  // Prior week was 0: report the absolute arrival rather than an undefined percentage.
  return `${s.direction} (${s.priorValue} → ${s.value})`;
}

/** Collect the week's wins from improved metrics and winning experiments, ranked by magnitude (desc). */
function collectWins(metrics: MetricSummary[], data: WeeklyGrowthData): ReportWin[] {
  const wins: ReportWin[] = [];

  for (const s of metrics) {
    const magnitude = metricMagnitude(s);
    if (!s.improved || magnitude === 0) continue;
    wins.push({
      source: "metric",
      headline: `${s.label} ${describeMovement(s)}`,
      detail: `${s.label} moved ${describeMovement(s)} week over week (${s.priorValue} → ${s.value}).`,
      magnitude,
    });
  }

  for (const e of data.experiments) {
    if (e.status !== "win") continue;
    const magnitude = e.lift !== undefined ? Math.abs(e.lift) : 0;
    const liftText = e.lift !== undefined ? ` drove ${formatPct(e.lift)}` : " was a win";
    const onMetric = e.metricKey ? ` on ${e.metricKey}` : "";
    wins.push({
      source: "experiment",
      headline: `${e.name} won`,
      detail: `Experiment "${e.name}"${liftText}${onMetric}.`,
      magnitude,
    });
  }

  // Stable sort by magnitude desc — equal magnitudes keep their insertion order (metrics before experiments).
  return wins
    .map((w, i) => ({ w, i }))
    .sort((a, b) => b.w.magnitude - a.w.magnitude || a.i - b.i)
    .map(({ w }) => w);
}

function priorityFor(impact: number): NextBet["priority"] {
  if (impact >= HIGH_PRIORITY_IMPACT) return "high";
  if (impact >= MEDIUM_PRIORITY_IMPACT) return "medium";
  return "low";
}

/**
 * Derive the recommended next bets from the week's data. Three data-backed sources, each carrying its
 * evidence:
 *   - **scale_winner** — a winning experiment with positive lift: double down on what worked.
 *   - **fix_regression** — a metric that moved the wrong way: investigate and reverse it.
 *   - **extend_experiment** — an inconclusive/running experiment: keep it going to reach a verdict.
 * If nothing actionable surfaced, a single low-priority `keep_steady` bet is returned so the report is never
 * empty. Bets are ranked by impact (desc), with a stable kind-order tiebreak.
 */
function recommendNextBets(metrics: MetricSummary[], data: WeeklyGrowthData, maxNextBets: number): NextBet[] {
  const bets: NextBet[] = [];

  for (const e of data.experiments) {
    if (e.status !== "win") continue;
    const lift = e.lift ?? 0;
    if (lift <= 0) continue;
    const impact = 100 * lift;
    const onMetric = e.metricKey ? ` on ${e.metricKey}` : "";
    bets.push({
      kind: "scale_winner",
      action: `Scale "${e.name}"`,
      rationale: `It won this week with ${formatPct(lift)}${onMetric}; roll it out more widely to compound the gain.`,
      priority: priorityFor(impact),
      impact,
    });
  }

  for (const s of metrics) {
    if (s.improved || s.direction === "flat") continue;
    const magnitude = metricMagnitude(s);
    if (magnitude === 0) continue;
    const impact = 100 * magnitude;
    bets.push({
      kind: "fix_regression",
      action: `Investigate the decline in ${s.label}`,
      rationale: `${s.label} moved ${describeMovement(s)} week over week (${s.priorValue} → ${s.value}); find and reverse the cause before it compounds.`,
      priority: priorityFor(impact),
      impact,
    });
  }

  for (const e of data.experiments) {
    if (e.status !== "inconclusive" && e.status !== "running") continue;
    const earlyLift = e.lift !== undefined ? Math.abs(e.lift) : 0;
    const impact = 6 + 40 * earlyLift;
    const signal =
      e.lift !== undefined
        ? `early signal is ${formatPct(e.lift)}`
        : `it has not reached a verdict yet`;
    bets.push({
      kind: "extend_experiment",
      action: `Extend "${e.name}" to reach a verdict`,
      rationale: `Status is ${e.status} and ${signal}; keep it running (or add traffic) before deciding.`,
      priority: priorityFor(impact),
      impact,
    });
  }

  if (bets.length === 0) {
    bets.push({
      kind: "keep_steady",
      action: "Hold the current strategy",
      rationale: "No significant metric movements or experiment outcomes this week; keep executing and gather more signal.",
      priority: "low",
      impact: 0,
    });
  }

  const KIND_ORDER: Record<NextBet["kind"], number> = {
    scale_winner: 0,
    fix_regression: 1,
    extend_experiment: 2,
    keep_steady: 3,
  };

  return bets
    .map((b, i) => ({ b, i }))
    .sort((a, b) => b.b.impact - a.b.impact || KIND_ORDER[a.b.kind] - KIND_ORDER[b.b.kind] || a.i - b.i)
    .map(({ b }) => b)
    .slice(0, maxNextBets);
}

function buildHeadline(period: WeeklyGrowthData["period"], wins: ReportWin[], metrics: MetricSummary[]): string {
  // The biggest mover by magnitude, regardless of direction — the single most notable number of the week.
  const ranked = metrics
    .map((s) => ({ s, mag: metricMagnitude(s) }))
    .filter((x) => x.mag > 0)
    .sort((a, b) => b.mag - a.mag);
  const top = ranked[0];
  const winCount = wins.length;
  const winPart = winCount === 1 ? "1 win" : `${winCount} wins`;
  const moverPart = top ? `; biggest mover: ${top.s.label} ${describeMovement(top.s)}` : "";
  return `Week of ${period.weekStart}: ${winPart}${moverPart}.`;
}

function toExperimentSummary(data: WeeklyGrowthData): ExperimentSummary[] {
  return data.experiments.map((e) => ({
    id: e.id,
    name: e.name,
    hypothesis: e.hypothesis,
    status: e.status,
    metricKey: e.metricKey,
    lift: e.lift,
  }));
}

export interface SynthesizeOptions {
  /** Cap on recommended next bets (defaults to {@link GROWTH_REPORT_DEFAULTS}.maxNextBets via the service). */
  maxNextBets?: number;
}

/**
 * Synthesize a week's raw growth data into a finished {@link WeeklyReport}. Pure and deterministic — the
 * single function the service calls to produce the report's body.
 */
export function synthesizeWeeklyReport(data: WeeklyGrowthData, opts: SynthesizeOptions = {}): WeeklyReport {
  const maxNextBets = Math.max(1, Math.trunc(opts.maxNextBets ?? 5));
  const metrics = data.metrics.map(summarizeMetric);
  const wins = collectWins(metrics, data);
  const experiments = toExperimentSummary(data);
  const nextBets = recommendNextBets(metrics, data, maxNextBets);
  const headline = buildHeadline(data.period, wins, metrics);
  return {
    workspaceId: data.workspaceId,
    period: data.period,
    headline,
    metrics,
    wins,
    experiments,
    nextBets,
  };
}
