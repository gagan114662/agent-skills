/**
 * Production binding for the daily agent standup digest (#589). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #589 change set
 * inside `standup-digest/` so it never collides with a sibling branch's migration numbering or schema barrel —
 * the same parallel-merge-safety pattern as #588/#620/#670. The DDL is additive and idempotent, so it
 * composes safely with the migration runner.
 *
 * The default data source is {@link FakeDailyActivitySource} — a deterministic, offline generator — so a
 * deployment that enables the feature gets a coherent digest with NO external calls. Wiring a real data source
 * to the trace/run/deliverable/decision repositories (which would touch shared files) and the daily tick into
 * the #559 scheduler are deliberate follow-ups.
 */

import { getPool } from "../db/index.js";
import { StandupDigestService } from "./service.js";
import { FakeDailyActivitySource, type DailyActivitySource } from "./source.js";
import type { StandupDigestRecord, StandupDigestStore } from "./store.js";
import type { DailyDigest, DigestPeriod } from "./types.js";

const TABLE = "standup_digest";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  day           text NOT NULL,
  digest        jsonb NOT NULL,
  generated_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS standup_digest_workspace_day_idx
  ON ${TABLE} (workspace_id, day DESC);
`;

interface DigestRow {
  id: string;
  workspace_id: string;
  day: string;
  digest: unknown;
  generated_at: Date;
}

function toRecord(row: DigestRow): StandupDigestRecord {
  const period: DigestPeriod = { day: row.day };
  // The blob was written by `synthesizeDailyDigest` (the only writer), so trust its shape.
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    period,
    digest: row.digest as DailyDigest,
    generatedAt: row.generated_at,
  };
}

/** Postgres-backed {@link StandupDigestStore} that owns (and lazily creates) its own table. */
export class PgStandupDigestStore implements StandupDigestStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async save(record: StandupDigestRecord): Promise<StandupDigestRecord> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${TABLE} (id, workspace_id, day, digest, generated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (id) DO UPDATE SET
         digest = EXCLUDED.digest,
         generated_at = EXCLUDED.generated_at`,
      [record.id, record.workspaceId, record.period.day, JSON.stringify(record.digest), record.generatedAt],
    );
    return record;
  }

  async get(workspaceId: string, id: string): Promise<StandupDigestRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<DigestRow>(
      `SELECT id, workspace_id, day, digest, generated_at
       FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  async list(workspaceId: string): Promise<StandupDigestRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<DigestRow>(
      `SELECT id, workspace_id, day, digest, generated_at
       FROM ${TABLE} WHERE workspace_id = $1 ORDER BY day DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }

  async latest(workspaceId: string): Promise<StandupDigestRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<DigestRow>(
      `SELECT id, workspace_id, day, digest, generated_at
       FROM ${TABLE} WHERE workspace_id = $1 ORDER BY day DESC LIMIT 1`,
      [workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }
}

let cached: StandupDigestService | undefined;

/** Build (once) the production standup-digest service over the self-managed Postgres store + offline source. */
export function createDefaultStandupDigestService(
  dataSource: DailyActivitySource = new FakeDailyActivitySource(),
): StandupDigestService {
  if (!cached) cached = new StandupDigestService({ store: new PgStandupDigestStore(), dataSource });
  return cached;
}
