/**
 * Production binding for the trend-ingestion source (issue #743). The store here is deliberately **self-managed**:
 * it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #743 change set inside
 * `trends/` so it never collides with a sibling branch's migration numbering or schema barrel — the explicit
 * parallel-merge-safety goal (the proven #670/#674/#587 pattern). The DDL is additive and idempotent, so it
 * composes safely with the migration runner.
 *
 * Dedupe is enforced at the database: a UNIQUE (workspace_id, niche, dedupe_key) constraint backs an
 * `INSERT ... ON CONFLICT DO UPDATE`, so re-ingesting the same trend updates the row in place instead of
 * duplicating it. Every query carries the `workspace_id` (#3 IDOR). This file is imported DIRECTLY by app
 * wiring and intentionally NOT re-exported from `index.ts`, so pure consumers/tests never load the pg driver.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { resolveTrendCaps } from "./caps.js";
import { TrendService } from "./service.js";
import { EmptyTrendSource, FixtureTrendSource } from "./provider.js";
import type { StoredTrendRecord, TrendFormat } from "./types.js";
import type { TrendStore, UpsertTrendInput } from "./store.js";

const TABLE = "trend_records";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL,
  niche        text NOT NULL,
  dedupe_key   text NOT NULL,
  hook         text NOT NULL,
  format       text NOT NULL,
  score        integer NOT NULL DEFAULT 0,
  source_ref   text NOT NULL DEFAULT '',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, niche, dedupe_key)
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_niche_score_idx ON ${TABLE} (workspace_id, niche, score DESC);
`;

interface TrendRow {
  id: string;
  workspace_id: string;
  niche: string;
  dedupe_key: string;
  hook: string;
  format: string;
  score: number;
  source_ref: string;
  created_at: Date;
  updated_at: Date;
}

function toRecord(r: TrendRow): StoredTrendRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    niche: r.niche,
    dedupeKey: r.dedupe_key,
    hook: r.hook,
    format: r.format as TrendFormat,
    score: r.score,
    sourceRef: r.source_ref,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link TrendStore} that owns (and lazily creates) its own table. */
export class PgTrendStore implements TrendStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async upsertMany(
    workspaceId: string,
    inputs: readonly UpsertTrendInput[],
  ): Promise<StoredTrendRecord[]> {
    await this.ensureSchema();
    if (inputs.length === 0) return [];
    const out: StoredTrendRecord[] = [];
    // One statement per input keeps the dedupe semantics obvious; batches are small (capped by maxResults).
    for (const input of inputs) {
      const res = await getPool().query<TrendRow>(
        `INSERT INTO ${TABLE}
           (id, workspace_id, niche, dedupe_key, hook, format, score, source_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (workspace_id, niche, dedupe_key) DO UPDATE
           SET hook = EXCLUDED.hook,
               format = EXCLUDED.format,
               score = EXCLUDED.score,
               source_ref = EXCLUDED.source_ref,
               updated_at = now()
         RETURNING *`,
        [
          newId(),
          workspaceId,
          input.niche,
          input.dedupeKey,
          input.record.hook,
          input.record.format,
          input.record.score,
          input.record.sourceRef,
        ],
      );
      const row = res.rows[0];
      if (!row) throw new Error("trends: INSERT ... RETURNING produced no row");
      out.push(toRecord(row));
    }
    return out;
  }

  async listByNiche(workspaceId: string, niche: string, limit?: number): Promise<StoredTrendRecord[]> {
    await this.ensureSchema();
    const capped = limit && limit > 0 ? Math.trunc(limit) : null;
    const res = capped
      ? await getPool().query<TrendRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND niche = $2
             ORDER BY score DESC, hook ASC, source_ref ASC LIMIT $3`,
          [workspaceId, niche, capped],
        )
      : await getPool().query<TrendRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND niche = $2
             ORDER BY score DESC, hook ASC, source_ref ASC`,
          [workspaceId, niche],
        );
    return res.rows.map(toRecord);
  }
}

/**
 * Build the production trend service over the self-managed Postgres store. The live `source` is the honest
 * {@link EmptyTrendSource} placeholder (no live integration is wired yet, so an enabled-but-unconfigured
 * deployment returns nothing rather than fabricated data); the deterministic {@link FixtureTrendSource} is the
 * disabled-default and error fallback. Flip `TRENDS_ENABLED=1` and inject a real source to go live.
 */
export function createDefaultTrendService(): TrendService {
  return new TrendService({
    store: new PgTrendStore(),
    source: new EmptyTrendSource(),
    fallback: new FixtureTrendSource(),
    caps: resolveTrendCaps(),
  });
}
