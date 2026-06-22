/**
 * Weekly growth report — the **service** (issue #620).
 *
 * Orchestrates the three seams into the one capability the issue asks for: *a coherent weekly report,
 * produced automatically, with data-backed recommendations.*
 *
 *   data-source  →  pure synthesis  →  store
 *   (what happened)  (what it means)   (so it can be read back)
 *
 * `generateReport` is the manual path; `runScheduledReport` is the weekly-tick seam a scheduler (#559) would
 * call — it is idempotent per week (re-running the same week returns the already-stored report rather than
 * regenerating). Both are gated by the env master switch (default OFF), so nothing runs until the feature is
 * deliberately enabled.
 *
 * The clock is injected (`now`), and the data + persistence are seams, so the service is fully unit-testable
 * with no DB, no network, and no wall-clock dependency.
 */

import { resolveGrowthReportCaps, type GrowthReportCaps } from "./caps.js";
import type { GrowthDataSource } from "./source.js";
import { reportId, type GrowthReportRecord, type GrowthReportStore } from "./store.js";
import { synthesizeWeeklyReport } from "./synthesize.js";
import type { ReportPeriod } from "./types.js";

/** A growth-report-domain rejection (e.g. the feature is disabled). Routes/callers map this to 4xx. */
export class GrowthReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrowthReportError";
  }
}

export interface GrowthReportSettings {
  enabled: boolean;
  maxNextBets: number;
}

export interface GrowthReportServiceDeps {
  store: GrowthReportStore;
  dataSource: GrowthDataSource;
  /** Caps override (tests pass an enabled value); defaults to the env-resolved caps. */
  caps?: GrowthReportCaps;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

/** Zero-pad to 2 digits. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Format a Date as a UTC `YYYY-MM-DD` string (no timezone drift). */
function isoDate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * The Monday-to-Monday week (UTC) containing `now`: `weekStart` is the Monday of that week, `weekEnd` the
 * following Monday (exclusive). Pure given its argument — the service supplies the clock.
 */
export function weekPeriodContaining(now: Date): ReportPeriod {
  const day = now.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const daysSinceMonday = (day + 6) % 7;
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysSinceMonday * 86_400_000;
  const start = new Date(startMs);
  const end = new Date(startMs + 7 * 86_400_000);
  return { weekStart: isoDate(start), weekEnd: isoDate(end) };
}

export class GrowthReportService {
  private readonly store: GrowthReportStore;
  private readonly dataSource: GrowthDataSource;
  private readonly caps: GrowthReportCaps;
  private readonly now: () => Date;

  constructor(deps: GrowthReportServiceDeps) {
    this.store = deps.store;
    this.dataSource = deps.dataSource;
    this.caps = deps.caps ?? resolveGrowthReportCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the feature is enabled for this deployment (gates generation). */
  get enabled(): boolean {
    return this.caps.enabled;
  }

  settings(): GrowthReportSettings {
    return { enabled: this.caps.enabled, maxNextBets: this.caps.maxNextBets };
  }

  /**
   * Generate (and persist) the report for a specific week. Fetches the week's data via the source, runs the
   * pure synthesis, and upserts the result keyed by workspace-week. Throws {@link GrowthReportError} if the
   * feature is disabled.
   */
  async generateReport(workspaceId: string, period: ReportPeriod): Promise<GrowthReportRecord> {
    if (!this.caps.enabled) throw new GrowthReportError("growth report is disabled");
    const data = await this.dataSource.fetch(workspaceId, period);
    const report = synthesizeWeeklyReport(data, { maxNextBets: this.caps.maxNextBets });
    const record: GrowthReportRecord = {
      id: reportId(workspaceId, period.weekStart),
      workspaceId,
      period,
      report,
      generatedAt: this.now(),
    };
    return this.store.save(record);
  }

  /**
   * The weekly scheduler tick (#559 seam). Generates the report for the week containing `now` — but only
   * once: if a report for that week already exists it is returned unchanged (idempotent). Returns null when
   * the feature is disabled, so a scheduler can call it unconditionally.
   */
  async runScheduledReport(workspaceId: string): Promise<GrowthReportRecord | null> {
    if (!this.caps.enabled) return null;
    const period = weekPeriodContaining(this.now());
    const existing = await this.store.get(workspaceId, reportId(workspaceId, period.weekStart));
    if (existing) return existing;
    return this.generateReport(workspaceId, period);
  }

  /** Load one report by id (workspace-scoped); null if absent. */
  getReport(workspaceId: string, id: string): Promise<GrowthReportRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /** A workspace's reports, newest week first. */
  listReports(workspaceId: string): Promise<GrowthReportRecord[]> {
    return this.store.list(workspaceId);
  }

  /** The most recent report for a workspace, or null if none yet. */
  latestReport(workspaceId: string): Promise<GrowthReportRecord | null> {
    return this.store.latest(workspaceId);
  }
}
