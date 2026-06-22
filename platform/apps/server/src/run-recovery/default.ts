/**
 * Production binding for run-recovery tracking (issue #643). The store here is deliberately
 * **self-managed**: it owns its single table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on
 * first use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That keeps
 * the entire #643 change set inside `run-recovery/` so it never collides with a sibling branch's migration
 * numbering or schema barrel (the #635/#670 parallel-merge-safety convention). The DDL is additive and
 * idempotent, so it composes safely with the migration runner.
 *
 * Times are stored as `bigint` epoch-ms (the pure core's currency); diagnostics ride along as `jsonb`. The
 * per-process instance id defaults to a fresh random uuid generated at module load — each boot is a new
 * owner, which is exactly what makes a crash detectable. Wiring this service to the boot sequence and the
 * worktree pool / lock APIs is left to the integrator (a one-liner, intentionally out of this
 * self-contained change) — see {@link createRunReconciler}.
 */

import { getPool } from "../db/index.js";
import { RunRecoveryService } from "./service.js";
import { resolveInstanceId } from "./caps.js";
import type { RunRecoveryStore } from "./store.js";
import {
  createRunReconciler,
  type ReconcileLogger,
  type RunReconciler,
  type RunReconcilerOptions,
} from "./reconcile.js";
import type { FailureReason, RecoveryDiagnostics, RunRecord, RunRecordPatch } from "./types.js";

const TABLE = "run_recoveries";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  run_id               text PRIMARY KEY,
  workspace_id         text NOT NULL,
  session_id           text,
  lock_key             text,
  owner_instance_id    text NOT NULL,
  status               text NOT NULL DEFAULT 'running',
  resumable            boolean NOT NULL DEFAULT false,
  started_at_ms        bigint NOT NULL,
  last_heartbeat_at_ms bigint NOT NULL,
  resume_attempts      integer NOT NULL DEFAULT 0,
  last_recovered_at_ms bigint,
  ended_at_ms          bigint,
  failure_reason       text,
  recovery             jsonb
);
CREATE INDEX IF NOT EXISTS ${TABLE}_orphan_idx ON ${TABLE} (status, owner_instance_id);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_idx ON ${TABLE} (workspace_id, started_at_ms DESC);
`;

interface Row {
  run_id: string;
  workspace_id: string;
  session_id: string | null;
  lock_key: string | null;
  owner_instance_id: string;
  status: RunRecord["status"];
  resumable: boolean;
  started_at_ms: string | number;
  last_heartbeat_at_ms: string | number;
  resume_attempts: string | number;
  last_recovered_at_ms: string | number | null;
  ended_at_ms: string | number | null;
  failure_reason: FailureReason | null;
  recovery: RecoveryDiagnostics | null;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));
const nOrNull = (v: string | number | null): number | null => (v === null ? null : n(v));

function toRecord(r: Row): RunRecord {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    lockKey: r.lock_key,
    ownerInstanceId: r.owner_instance_id,
    status: r.status,
    resumable: r.resumable,
    startedAtMs: n(r.started_at_ms),
    lastHeartbeatAtMs: n(r.last_heartbeat_at_ms),
    resumeAttempts: n(r.resume_attempts),
    lastRecoveredAtMs: nOrNull(r.last_recovered_at_ms),
    endedAtMs: nOrNull(r.ended_at_ms),
    failureReason: r.failure_reason,
    recovery: r.recovery,
  };
}

/** Maps a {@link RunRecordPatch} field to its `(column, value)`; `undefined` patch fields are skipped. */
const PATCH_COLUMNS: Array<[keyof RunRecordPatch, string]> = [
  ["ownerInstanceId", "owner_instance_id"],
  ["status", "status"],
  ["resumable", "resumable"],
  ["lastHeartbeatAtMs", "last_heartbeat_at_ms"],
  ["resumeAttempts", "resume_attempts"],
  ["lastRecoveredAtMs", "last_recovered_at_ms"],
  ["endedAtMs", "ended_at_ms"],
  ["failureReason", "failure_reason"],
  ["recovery", "recovery"],
];

/** Postgres-backed {@link RunRecoveryStore} that owns (and lazily creates) its own table. */
export class PgRunRecoveryStore implements RunRecoveryStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async insert(record: RunRecord): Promise<RunRecord> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `INSERT INTO ${TABLE} (
         run_id, workspace_id, session_id, lock_key, owner_instance_id, status, resumable,
         started_at_ms, last_heartbeat_at_ms, resume_attempts, last_recovered_at_ms,
         ended_at_ms, failure_reason, recovery
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)
       RETURNING *`,
      [
        record.runId,
        record.workspaceId,
        record.sessionId,
        record.lockKey,
        record.ownerInstanceId,
        record.status,
        record.resumable,
        record.startedAtMs,
        record.lastHeartbeatAtMs,
        record.resumeAttempts,
        record.lastRecoveredAtMs,
        record.endedAtMs,
        record.failureReason,
        record.recovery === null ? null : JSON.stringify(record.recovery),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("run-recovery: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, runId: string): Promise<RunRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE run_id = $1 AND workspace_id = $2`,
      [runId, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async getByRunId(runId: string): Promise<RunRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(`SELECT * FROM ${TABLE} WHERE run_id = $1`, [runId]);
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async patch(runId: string, patch: RunRecordPatch): Promise<RunRecord | null> {
    await this.ensureSchema();
    const sets: string[] = [];
    const values: unknown[] = [runId];
    for (const [field, column] of PATCH_COLUMNS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (field === "recovery") {
        values.push(value === null ? null : JSON.stringify(value));
        sets.push(`${column} = $${values.length}::jsonb`);
      } else {
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
    }
    if (sets.length === 0) return this.getByRunId(runId);
    const res = await getPool().query<Row>(
      `UPDATE ${TABLE} SET ${sets.join(", ")} WHERE run_id = $1 RETURNING *`,
      values,
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async listOrphaned(liveInstanceId: string): Promise<RunRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE}
       WHERE status = 'running' AND owner_instance_id <> $1
       ORDER BY started_at_ms ASC, run_id ASC`,
      [liveInstanceId],
    );
    return res.rows.map(toRecord);
  }

  async listByWorkspace(workspaceId: string): Promise<RunRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY started_at_ms DESC, run_id DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }
}

/**
 * Build the production recovery service over the self-managed Postgres store. Pass `reconciler` (built via
 * {@link createRunReconciler} from the worktree pool + lock APIs) to reconcile recovered runs' resources;
 * with none supplied the pass still transitions state, it just reconciles nothing. `instanceId` defaults
 * to {@link resolveInstanceId}.
 */
export function createDefaultRunRecoveryService(
  opts: { reconciler?: RunReconciler; instanceId?: string } = {},
): RunRecoveryService {
  return new RunRecoveryService({
    store: new PgRunRecoveryStore(),
    instanceId: opts.instanceId ?? resolveInstanceId(),
    reconciler: opts.reconciler,
  });
}

/** Convenience re-export so an integrator imports the reconciler builder from the same module. */
export { createRunReconciler };
export type { ReconcileLogger, RunReconcilerOptions };
