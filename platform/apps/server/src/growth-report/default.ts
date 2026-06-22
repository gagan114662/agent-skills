/**
 * Production binding for the weekly growth report (#620). The store here is deliberately **self-managed**: it
 * owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an intentional deviation from
 * the repo's usual migration convention, taken to keep the entire #620 change set inside `growth-report/` so
 * it never collides with a sibling branch's migration numbering or schema barrel — the same parallel-merge-
 * safety pattern as #588/#670/#676. The DDL is additive and idempotent, so it composes safely with the
 * migration runner.
 *
 * The default data source is {@link FakeGrowthDataSource} — a deterministic, offline generator — so a
 * deployment that enables the feature gets a coherent report with NO external calls. Wiring a real data
 * source to the analytics/funnel/experiment repositories (which would touch shared files) and the weekly
 * tick into the #559 scheduler are deliberate follow-ups.
 */

import { getPool } from "../db/index.js";
import { GrowthReportService } from "./service.js";
import { FakeGrowthDataSource, type GrowthDataSource } from "./source.js";
import type { GrowthReportRecord, GrowthReportStore } from "./store.js";
import type { ReportPeriod, WeeklyReport } from "./types.js";

const TABLE = "growth_report";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  week_start    text NOT NULL,
  week_end      text NOT NULL,
  report        jsonb NOT NULL,
  generated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS growth_report_workspace_week_idx
  ON ${TABLE} (workspace_id, week_start DESC);
`;

interface ReportRow {
  id: string;
  workspace_id: string;
  week_start: string;
  week_end: string;
  report: unknown;
  generated_at: Date;
}

function toRecord(row: ReportRow): GrowthReportRecord {
  const period: ReportPeriod = { weekStart: row.week_start, weekEnd: row.week_end };
  // The blob was written by `synthesizeWeeklyReport` (the only writer), so trust its shape.
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    period,
    report: row.report as WeeklyReport,
    generatedAt: row.generated_at,
  };
}

/** Postgres-backed {@link GrowthReportStore} that owns (and lazily creates) its own table. */
export class PgGrowthReportStore implements GrowthReportStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async save(record: GrowthReportRecord): Promise<GrowthReportRecord> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${TABLE} (id, workspace_id, week_start, week_end, report, generated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       ON CONFLICT (id) DO UPDATE SET
         week_end = EXCLUDED.week_end,
         report = EXCLUDED.report,
         generated_at = EXCLUDED.generated_at`,
      [
        record.id,
        record.workspaceId,
        record.period.weekStart,
        record.period.weekEnd,
        JSON.stringify(record.report),
        record.generatedAt,
      ],
    );
    return record;
  }

  async get(workspaceId: string, id: string): Promise<GrowthReportRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ReportRow>(
      `SELECT id, workspace_id, week_start, week_end, report, generated_at
       FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  async list(workspaceId: string): Promise<GrowthReportRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<ReportRow>(
      `SELECT id, workspace_id, week_start, week_end, report, generated_at
       FROM ${TABLE} WHERE workspace_id = $1 ORDER BY week_start DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }

  async latest(workspaceId: string): Promise<GrowthReportRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ReportRow>(
      `SELECT id, workspace_id, week_start, week_end, report, generated_at
       FROM ${TABLE} WHERE workspace_id = $1 ORDER BY week_start DESC LIMIT 1`,
      [workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }
}

let cached: GrowthReportService | undefined;

/** Build (once) the production growth-report service over the self-managed Postgres store + offline source. */
export function createDefaultGrowthReportService(dataSource: GrowthDataSource = new FakeGrowthDataSource()): GrowthReportService {
  if (!cached) cached = new GrowthReportService({ store: new PgGrowthReportStore(), dataSource });
  return cached;
}
