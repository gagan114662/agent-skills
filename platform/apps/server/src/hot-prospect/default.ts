/**
 * Production binding for hot-prospect alerting (issue #622). The store here is deliberately **self-managed**:
 * it owns its table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an intentional deviation from
 * the repo's usual migration convention, taken to keep the entire #622 change set inside `hot-prospect/`
 * (plus its tests) so it never collides with a sibling branch's migration numbering or schema barrel — the
 * explicit parallel-merge-safety goal of the recent self-contained modules (#670/#674/#585/#611). The DDL is
 * additive and idempotent, so it composes safely with the migration runner.
 *
 * The default service is wired DEFAULT-OFF (the env master switch is off unless a deployment sets it) and its
 * approval gate is the recorded-only {@link RecordingApprovalGate} with NO notifier bound — so even with the
 * module enabled, a parked alert sends nothing until a real #13 gate + notifier are bound by app wiring (out
 * of this module's scope). Nothing here makes an external call.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { resolveHotProspectPolicy } from "./caps.js";
import { RecordingApprovalGate } from "./notify.js";
import { HotProspectService } from "./service.js";
import { FixtureSignalSource, type SignalSource } from "./source.js";
import type { AlertRecord, AlertStore, NewAlertRecord } from "./store.js";
import type { NotificationRoute } from "./types.js";

const ALERT_TABLE = "hot_prospect_alerts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${ALERT_TABLE} (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  prospect_id         text NOT NULL,
  score               double precision NOT NULL,
  reason              text NOT NULL,
  routes              jsonb NOT NULL DEFAULT '[]'::jsonb,
  approval_request_id text,
  raised_at           timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${ALERT_TABLE}_ws_prospect_idx ON ${ALERT_TABLE} (workspace_id, prospect_id, raised_at DESC);
`;

interface AlertRow {
  id: string;
  workspace_id: string;
  prospect_id: string;
  score: number;
  reason: string;
  routes: NotificationRoute[];
  approval_request_id: string | null;
  raised_at: Date;
}

function toRecord(r: AlertRow): AlertRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    prospectId: r.prospect_id,
    score: Number(r.score),
    reason: r.reason,
    routes: Array.isArray(r.routes) ? r.routes : [],
    approvalRequestId: r.approval_request_id,
    raisedAt: r.raised_at.toISOString(),
  };
}

/** Postgres-backed {@link AlertStore} that owns (and lazily creates) its own table. */
export class PgAlertStore implements AlertStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async lastAlertAt(workspaceId: string, prospectId: string): Promise<string | null> {
    await this.ensureSchema();
    const res = await getPool().query<{ raised_at: Date }>(
      `SELECT raised_at FROM ${ALERT_TABLE}
       WHERE workspace_id = $1 AND prospect_id = $2
       ORDER BY raised_at DESC
       LIMIT 1`,
      [workspaceId, prospectId],
    );
    const row = res.rows[0];
    return row ? row.raised_at.toISOString() : null;
  }

  async record(input: NewAlertRecord): Promise<AlertRecord> {
    await this.ensureSchema();
    const res = await getPool().query<AlertRow>(
      `INSERT INTO ${ALERT_TABLE}
         (id, workspace_id, prospect_id, score, reason, routes, approval_request_id, raised_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.prospectId,
        input.score,
        input.reason,
        JSON.stringify(input.routes),
        input.approvalRequestId,
        input.raisedAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("hot-prospect: insert produced no row");
    return toRecord(row);
  }

  async recent(workspaceId: string, limit = 50): Promise<AlertRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<AlertRow>(
      `SELECT * FROM ${ALERT_TABLE}
       WHERE workspace_id = $1
       ORDER BY raised_at DESC, id DESC
       LIMIT $2`,
      [workspaceId, Math.max(0, limit)],
    );
    return res.rows.map(toRecord);
  }
}

/**
 * Build the production hot-prospect service over the self-managed Postgres store + env-resolved policy
 * (DEFAULT-OFF). The signal source defaults to an empty {@link FixtureSignalSource} (no external read) until a
 * real source is bound; pass one in to wire production activity. The approval gate is recorded-only and binds
 * no notifier, so nothing is ever sent from here.
 */
export function createDefaultHotProspectService(source: SignalSource = new FixtureSignalSource()): HotProspectService {
  return new HotProspectService({
    source,
    store: new PgAlertStore(),
    gate: new RecordingApprovalGate(),
    policy: resolveHotProspectPolicy(),
  });
}
