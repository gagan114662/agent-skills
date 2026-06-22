/**
 * Cost observability service (issue #667) — the read surface for per-run and rolled-up token/cost accounting.
 *
 * Pure orchestration over an injected IO seam (`CostDeps`), exactly like the #560 `TraceService`: unit-tested
 * with fakes, bound to the real trace repo in `default.ts`. It never writes — a trace is written by the
 * runtime through the trace service; this only reads the captured tokens and turns them into cost. All math
 * lives in the pure `rollup.ts`/`pricing.ts`; this layer just fetches rows, enriches them with effective cost,
 * and assembles the per-agent + per-day views. Every method is workspace-scoped (#3 IDOR discipline).
 */

import {
  enrichRunCost,
  rollupByAgent,
  rollupByDay,
  summarizeRunCost,
  summarizeRuns,
  type AgentCostRollup,
  type CostTotals,
  type DailyCostRollup,
  type RunCostEventRow,
  type RunCostRow,
  type RunCostSummary,
} from "./rollup.js";

/** A time window for a cost summary. Open-ended on either side. */
export interface CostWindow {
  since?: Date;
  until?: Date;
  /** Cap on how many runs to scan (the repo enforces a hard ceiling regardless). */
  limit?: number;
}

/** Persistence seam — `default.ts` binds these to the #560 trace repo. */
export interface CostDeps {
  /** A run header reduced to cost fields, scoped to the workspace (undefined if absent/cross-workspace). */
  getRun(workspaceId: string, runId: string): Promise<RunCostRow | undefined>;
  /** A run's events reduced to cost fields, in any order. */
  listRunEvents(workspaceId: string, runId: string): Promise<RunCostEventRow[]>;
  /** Run headers (cost fields) in the window, scoped to the workspace, newest first. */
  listRunsInWindow(workspaceId: string, window: CostWindow): Promise<RunCostRow[]>;
}

/** The workspace-level cost summary: grand totals plus the per-agent and per-day rollups. */
export interface CostSummary {
  window: { since: string | null; until: string | null };
  totals: CostTotals;
  byAgent: AgentCostRollup[];
  byDay: DailyCostRollup[];
}

export class CostObservabilityService {
  constructor(
    private readonly deps: CostDeps,
    /** Model used to price a run whose cost was never recorded and whose events carry no usable usage. */
    private readonly fallbackModel: string = resolveFallbackModel(),
  ) {}

  /** Per-run cost: header totals + a per-model breakdown. Undefined if the run is absent or cross-workspace. */
  async getRunCost(workspaceId: string, runId: string): Promise<RunCostSummary | undefined> {
    const run = await this.deps.getRun(workspaceId, runId);
    if (!run) return undefined;
    const events = await this.deps.listRunEvents(workspaceId, runId);
    return summarizeRunCost(run, events, this.fallbackModel);
  }

  /** Workspace cost summary over a window: totals, per-agent, and per-day (the daily roll-up). */
  async getSummary(workspaceId: string, window: CostWindow = {}): Promise<CostSummary> {
    const rows = await this.deps.listRunsInWindow(workspaceId, window);
    const enriched = rows.map((r) => enrichRunCost(r, this.fallbackModel));
    return {
      window: {
        since: window.since ? window.since.toISOString() : null,
        until: window.until ? window.until.toISOString() : null,
      },
      totals: summarizeRuns(enriched),
      byAgent: rollupByAgent(enriched),
      byDay: rollupByDay(enriched),
    };
  }
}

/** The default fallback pricing model, overridable via env. Defaults to the current flagship. */
export function resolveFallbackModel(): string {
  return process.env.OBSERVABILITY_COST_DEFAULT_MODEL?.trim() || "claude-opus-4-8";
}
