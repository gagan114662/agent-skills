/**
 * Shared types for the Growth Loop (#102, ADR-0102). The pure `score`/`caps` modules and the IO
 * `service`/`default` agree on these — mirroring the #96 venture / #117 flywheel `types.ts` split
 * (const-tuple taxonomies + `is*` guards, row-mirroring records, pure derived views at the bottom).
 */

/**
 * The funnel stages the growth loop instruments — the AARRR-lite pipeline the issue names: traffic in
 * (`acquisition`, tagged with a source), first value (`activation`), money (`conversion`), and coming
 * back (`retention`). Bounded + stable: each is a CHECK value and a low-cardinality metric label.
 */
export const GROWTH_EVENT_KINDS = ["acquisition", "activation", "conversion", "retention"] as const;
export type GrowthEventKind = (typeof GROWTH_EVENT_KINDS)[number];

export function isGrowthEventKind(value: unknown): value is GrowthEventKind {
  return typeof value === "string" && (GROWTH_EVENT_KINDS as readonly string[]).includes(value);
}

/** Lifecycle of a channel experiment proposed by the marketing fleet (#123). */
export const EXPERIMENT_STATUSES = [
  "proposed",
  "approved",
  "running",
  "paused",
  "completed",
  "abandoned",
] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export function isExperimentStatus(value: unknown): value is ExperimentStatus {
  return typeof value === "string" && (EXPERIMENT_STATUSES as readonly string[]).includes(value);
}

/** One growth event (one row in `growth_events`) — the durable, workspace-scoped instrumentation log. */
export interface GrowthEventRecord {
  id: string;
  workspaceId: string;
  /** The venture idea (#96) this event belongs to (soft reference), or null for workspace-level signal. */
  ideaId: string | null;
  kind: GrowthEventKind;
  /** The traffic/attribution source (e.g. `producthunt`, `hn`, `organic`); `''` when unattributed. */
  source: string;
  /** The count/weight this event carries (default 1). Negative weights are ignored by the funnel. */
  value: number;
  /** Free-form bag (path, campaign, variant) — never aggregated, surfaced for drill-down only. */
  metadata: Record<string, unknown>;
  occurredAt: Date;
  createdAt: Date;
}

/** One channel experiment (one row in `growth_experiments`) — proposed by an agent, posting #13-gated. */
export interface GrowthExperimentRecord {
  id: string;
  workspaceId: string;
  /** The venture idea (#96) this experiment promotes (soft reference), or null. */
  ideaId: string | null;
  /** The channel (e.g. `producthunt`, `reddit`, `seo`, `lifecycle`). */
  channel: string;
  /** The experiment hypothesis the agent is testing. */
  hypothesis: string;
  /** The variant/package/content/campaign arm under test; `''` when not applicable. */
  variant: string;
  /** The primary metric this experiment is judged on; `''` when not set. */
  metricKey: string;
  /** The content engine's measurable target query (e.g. a keyword to rank for); `''` when none. */
  targetQuery: string;
  status: ExperimentStatus;
  /** The marketing agent member that proposed it (soft reference), or null. */
  proposedByMemberId: string | null;
  /** The #13 approval request gating an external post for this experiment (soft reference), or null. */
  approvalRequestId: string | null;
  /** A one-line outcome summary once the experiment completes; `''` while pending. */
  resultSummary: string;
  /** The measured result once completed; `''` while pending. */
  result: string;
  /** The keep/kill/iterate decision made from the result; `''` while pending. */
  decision: string;
  createdAt: Date;
  updatedAt: Date;
}

// ---- derived views (pure) ----------------------------------------------------------------------

/** The aggregated funnel counts (summed `value` per kind). */
export interface GrowthFunnel {
  acquisition: number;
  activation: number;
  conversion: number;
  retention: number;
}

/** Stage-to-stage conversion rates, each guarded into `[0,1]`. */
export interface FunnelRates {
  activationRate: number;
  conversionRate: number;
  retentionRate: number;
}

/** The 0–100 growth score + the funnel/rates it was derived from (for the dashboard). */
export interface GrowthScore {
  score: number;
  rates: FunnelRates;
  funnel: GrowthFunnel;
}

/** The weakest funnel stage to attack next. */
export type ExperimentStage = "activation" | "conversion" | "retention";

/** A recommended next experiment, targeting the weakest stage (the growth tick's "next 3"). */
export interface GrowthExperimentSuggestion {
  stage: ExperimentStage;
  channel: string;
  hypothesis: string;
}
