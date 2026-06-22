/**
 * Weekly growth report — the **persistence seam** (issue #620).
 *
 * The narrow interface the service consumes to persist and read back generated reports. A report is keyed by
 * `${workspaceId}:${weekStart}`, so re-generating the same week upserts rather than duplicating — weekly
 * reports are idempotent. Everything is workspace-scoped (the `workspaceId` is the first argument of every
 * read) so a caller can only ever see its own tenant's reports — the #3 IDOR boundary.
 *
 * The production binding is the self-managed Postgres store in `growth-report/default.ts`; unit tests inject
 * {@link InMemoryGrowthReportStore}, so the service is tested with no database (the #17
 * pure-decision + injected-seam pattern).
 */

import type { ReportPeriod, WeeklyReport } from "./types.js";

/** A persisted report: the synthesized {@link WeeklyReport} plus its identity and generation timestamp. */
export interface GrowthReportRecord {
  /** `${workspaceId}:${weekStart}` — stable per workspace-week (upsert key). */
  id: string;
  workspaceId: string;
  period: ReportPeriod;
  report: WeeklyReport;
  /** When the report was generated (caller-supplied; the service injects its clock). */
  generatedAt: Date;
}

export interface GrowthReportStore {
  /** Persist a report (upsert by {@link GrowthReportRecord.id}). Returns the saved record. */
  save(record: GrowthReportRecord): Promise<GrowthReportRecord>;
  /** Load one report by id (scoped to the workspace); null if absent. */
  get(workspaceId: string, id: string): Promise<GrowthReportRecord | null>;
  /** A workspace's reports, newest week first. */
  list(workspaceId: string): Promise<GrowthReportRecord[]>;
  /** The most recent report for a workspace (by week), or null if none yet. */
  latest(workspaceId: string): Promise<GrowthReportRecord | null>;
}

/** Build the stable upsert id for a workspace-week. */
export function reportId(workspaceId: string, weekStart: string): string {
  return `${workspaceId}:${weekStart}`;
}

/** Newest-week-first comparator (descending by `weekStart`, lexicographic on ISO dates = chronological). */
function byWeekDesc(a: GrowthReportRecord, b: GrowthReportRecord): number {
  return a.period.weekStart < b.period.weekStart ? 1 : a.period.weekStart > b.period.weekStart ? -1 : 0;
}

/**
 * In-memory {@link GrowthReportStore} for unit tests. Deterministic: no clock or id generation of its own —
 * the caller supplies `id` and `generatedAt`, so a test never depends on wall-clock time.
 */
export class InMemoryGrowthReportStore implements GrowthReportStore {
  private readonly records = new Map<string, GrowthReportRecord>();

  async save(record: GrowthReportRecord): Promise<GrowthReportRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async get(workspaceId: string, id: string): Promise<GrowthReportRecord | null> {
    const rec = this.records.get(id);
    return rec && rec.workspaceId === workspaceId ? rec : null;
  }

  async list(workspaceId: string): Promise<GrowthReportRecord[]> {
    return [...this.records.values()].filter((r) => r.workspaceId === workspaceId).sort(byWeekDesc);
  }

  async latest(workspaceId: string): Promise<GrowthReportRecord | null> {
    const all = await this.list(workspaceId);
    return all[0] ?? null;
  }
}
