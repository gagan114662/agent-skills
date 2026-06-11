/**
 * Semantic layer — the canonical metric catalog (#155, ADR-0155 §2). **Pure**: a static registry of
 * metric *definitions*, each naming the governed scorer it is computed from. This is the structural
 * routing the Anthropic playbook calls for — a metric question resolves to exactly one definition, and
 * therefore one number, everywhere it is asked. The IO `service.ts` does the resolving + freshness; this
 * file only declares what a metric IS and where its single source of truth lives.
 *
 * IDs are stable + dotted (`<source>.<name>`) so they can be referenced from skills, evals, and the route
 * without ambiguity. Changing an id is a breaking change (and would trip the colocation CI check if the
 * governed surface moved without the skills following).
 */

/** The governed modules a metric can be sourced from — the existing scored loops. */
export const METRIC_SOURCES = ["growth", "demand", "venture", "moat", "usage"] as const;
export type MetricSource = (typeof METRIC_SOURCES)[number];

/** How a metric's number reads, so the renderer can format it without guessing. */
export const METRIC_UNITS = ["score_0_100", "score_0_10", "rate_0_1", "count", "cents"] as const;
export type MetricUnit = (typeof METRIC_UNITS)[number];

/**
 * The level a metric is canonically resolvable at. `workspace` metrics have a single governed
 * workspace-level number (the semantic layer answers them canonically). `venture` metrics are scored
 * per venture idea — at workspace scope there is no single governed number, so the semantic layer answers
 * them as a flagged `raw_data` fallback (honest: "scope to a venture"). The eval suites, the offline
 * fixtures, and the live resolver all key off this one field, so they never disagree.
 */
export const METRIC_SCOPES = ["workspace", "venture"] as const;
export type MetricScope = (typeof METRIC_SCOPES)[number];

/** A canonical metric definition: one number, one source of truth, one owning agent. */
export interface MetricDefinition {
  /** Stable dotted id, e.g. `growth.score`. The only handle skills/evals/routes use. */
  id: string;
  /** Human label for the answer line. */
  label: string;
  /** The governed scorer this metric is computed from (its single source of truth). */
  source: MetricSource;
  /** How the value reads. */
  unit: MetricUnit;
  /** The level this metric is canonically resolvable at (workspace vs per-venture). */
  scope: MetricScope;
  /** The fleet agent that is the authority for this metric (semantic-layer routing). */
  owner: string;
  /** One-line definition — what the number means, so an answer can explain itself. */
  description: string;
}

/**
 * The canonical catalog. Every metric the fleet may quote lives here, bound to a governed scorer:
 *  - growth   → `growth/score.ts` (scoreGrowth, funnelRates, growthToVentureSignal)
 *  - demand   → `demand/signals.ts` (aggregateFunnel → FunnelConversion)
 *  - venture  → `venture/rubric.ts` (aggregateScorecards)
 *  - moat     → `moat/score.ts` (scoreMoat)
 *  - usage    → `scale/usage.ts` (estimateCostCents)
 * Lens owns the analytics surface, so it is the default owner; brand/growth-adjacent metrics still resolve
 * through the same single function (the owner is about *who answers*, not *which number*).
 */
export const METRIC_CATALOG: readonly MetricDefinition[] = [
  {
    id: "growth.score",
    scope: "workspace",
    label: "Growth score",
    source: "growth",
    unit: "score_0_100",
    owner: "lens",
    description:
      "The 0–100 growth score — the weighted mean of activation, conversion, and retention from the " +
      "governed growth funnel (growth/score.ts scoreGrowth).",
  },
  {
    id: "growth.venture_signal",
    scope: "workspace",
    label: "Growth → venture distribution signal",
    source: "growth",
    unit: "score_0_10",
    owner: "lens",
    description:
      "The 0–10 distribution signal the growth score contributes to the venture scorecard " +
      "(growth/score.ts growthToVentureSignal).",
  },
  {
    id: "demand.visit_to_paid",
    scope: "venture",
    label: "Visit → paid conversion",
    source: "demand",
    unit: "rate_0_1",
    owner: "lens",
    description:
      "The fraction of externally-attributed visits that converted to a paid signal (demand/signals.ts " +
      "aggregateFunnel — self-attributed signals never count).",
  },
  {
    id: "venture.score",
    scope: "venture",
    label: "Venture fundability score",
    source: "venture",
    unit: "score_0_100",
    owner: "lens",
    description:
      "The 0–100 venture rubric score — the reviewer-weighted mean across the eight rubric dimensions " +
      "(venture/rubric.ts aggregateScorecards).",
  },
  {
    id: "moat.score",
    scope: "venture",
    label: "Moat score",
    source: "moat",
    unit: "score_0_100",
    owner: "lens",
    description:
      "The 0–100 moat score — the weighted mean of the four moat dimensions, including the fleet's own " +
      "accumulated evals + skills (moat/score.ts scoreMoat).",
  },
  {
    id: "usage.cost_cents",
    scope: "workspace",
    label: "Compute cost (cents)",
    source: "usage",
    unit: "cents",
    owner: "lens",
    description:
      "Estimated compute cost in cents for the current usage window (scale/usage.ts estimateCostCents).",
  },
] as const;

/** Look up a metric by id, or `undefined` for an unknown id. */
export function getMetric(id: string): MetricDefinition | undefined {
  return METRIC_CATALOG.find((m) => m.id === id);
}

/** Narrow an untrusted string to a known metric id. */
export function isMetricId(value: unknown): boolean {
  return typeof value === "string" && METRIC_CATALOG.some((m) => m.id === value);
}

/** List the catalog, optionally filtered to one governed source. Order is the catalog's declared order. */
export function listMetrics(source?: MetricSource): MetricDefinition[] {
  return METRIC_CATALOG.filter((m) => source === undefined || m.source === source);
}
