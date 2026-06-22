/**
 * Production binding for run-timeout tracking (issue #635). The store here is deliberately
 * **self-managed**: it owns its single table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on
 * first use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That keeps
 * the entire #635 change set inside `run-timeout/` so it never collides with a sibling branch's migration
 * numbering or schema barrel (the #670 parallel-merge-safety convention). The DDL is additive and
 * idempotent, so it composes safely with the migration runner.
 *
 * Times are stored as `bigint` epoch-ms (the pure core's currency); diagnostics ride along as `jsonb`.
 * Wiring this service to a scheduler + the worktree pool / lock release is left to the integrator (a
 * one-liner, intentionally out of this self-contained change) — see {@link createResourceReleaser}.
 */

import { getPool } from "../db/index.js";
import { RunTimeoutService } from "./service.js";
import type { RunTimeoutStore } from "./store.js";
import {
  createResourceReleaser,
  type ReleaseLogger,
  type ResourceReleaser,
  type ResourceReleaserOptions,
} from "./resources.js";
import type { RunTimeoutPatch, RunTimeoutRecord, TimeoutDiagnostics, TimeoutKind } from "./types.js";

const TABLE = "run_timeouts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  run_id               text PRIMARY KEY,
  workspace_id         text NOT NULL,
  session_id           text,
  lock_key             text,
  status               text NOT NULL DEFAULT 'running',
  started_at_ms        bigint NOT NULL,
  deadline_at_ms       bigint NOT NULL,
  run_timeout_ms       bigint NOT NULL,
  step_timeout_ms      bigint NOT NULL,
  step_name            text,
  step_started_at_ms   bigint,
  last_heartbeat_at_ms bigint NOT NULL,
  ended_at_ms          bigint,
  timeout_kind         text,
  diagnostics          jsonb
);
CREATE INDEX IF NOT EXISTS ${TABLE}_running_idx ON ${TABLE} (status, deadline_at_ms);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_idx ON ${TABLE} (workspace_id, started_at_ms DESC);
`;

interface Row {
  run_id: string;
  workspace_id: string;
  session_id: string | null;
  lock_key: string | null;
  status: RunTimeoutRecord["status"];
  started_at_ms: string | number;
  deadline_at_ms: string | number;
  run_timeout_ms: string | number;
  step_timeout_ms: string | number;
  step_name: string | null;
  step_started_at_ms: string | number | null;
  last_heartbeat_at_ms: string | number;
  ended_at_ms: string | number | null;
  timeout_kind: TimeoutKind | null;
  diagnostics: TimeoutDiagnostics | null;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));
const nOrNull = (v: string | number | null): number | null => (v === null ? null : n(v));

function toRecord(r: Row): RunTimeoutRecord {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    lockKey: r.lock_key,
    status: r.status,
    startedAtMs: n(r.started_at_ms),
    deadlineAtMs: n(r.deadline_at_ms),
    runTimeoutMs: n(r.run_timeout_ms),
    stepTimeoutMs: n(r.step_timeout_ms),
    stepName: r.step_name,
    stepStartedAtMs: nOrNull(r.step_started_at_ms),
    lastHeartbeatAtMs: n(r.last_heartbeat_at_ms),
    endedAtMs: nOrNull(r.ended_at_ms),
    timeoutKind: r.timeout_kind,
    diagnostics: r.diagnostics,
  };
}

/** Maps a {@link RunTimeoutPatch} field to its `(column, value)`; `undefined` patch fields are skipped. */
const PATCH_COLUMNS: Array<[keyof RunTimeoutPatch, string]> = [
  ["status", "status"],
  ["stepName", "step_name"],
  ["stepStartedAtMs", "step_started_at_ms"],
  ["lastHeartbeatAtMs", "last_heartbeat_at_ms"],
  ["endedAtMs", "ended_at_ms"],
  ["timeoutKind", "timeout_kind"],
  ["diagnostics", "diagnostics"],
];

/** Postgres-backed {@link RunTimeoutStore} that owns (and lazily creates) its own table. */
export class PgRunTimeoutStore implements RunTimeoutStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async insert(record: RunTimeoutRecord): Promise<RunTimeoutRecord> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `INSERT INTO ${TABLE} (
         run_id, workspace_id, session_id, lock_key, status,
         started_at_ms, deadline_at_ms, run_timeout_ms, step_timeout_ms,
         step_name, step_started_at_ms, last_heartbeat_at_ms, ended_at_ms,
         timeout_kind, diagnostics
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       RETURNING *`,
      [
        record.runId,
        record.workspaceId,
        record.sessionId,
        record.lockKey,
        record.status,
        record.startedAtMs,
        record.deadlineAtMs,
        record.runTimeoutMs,
        record.stepTimeoutMs,
        record.stepName,
        record.stepStartedAtMs,
        record.lastHeartbeatAtMs,
        record.endedAtMs,
        record.timeoutKind,
        record.diagnostics === null ? null : JSON.stringify(record.diagnostics),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("run-timeout: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, runId: string): Promise<RunTimeoutRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE run_id = $1 AND workspace_id = $2`,
      [runId, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async getByRunId(runId: string): Promise<RunTimeoutRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(`SELECT * FROM ${TABLE} WHERE run_id = $1`, [runId]);
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async patch(runId: string, patch: RunTimeoutPatch): Promise<RunTimeoutRecord | null> {
    await this.ensureSchema();
    const sets: string[] = [];
    const values: unknown[] = [runId];
    for (const [field, column] of PATCH_COLUMNS) {
      const value = patch[field];
      if (value === undefined) continue;
      if (field === "diagnostics") {
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

  async listRunning(): Promise<RunTimeoutRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE status = 'running' ORDER BY deadline_at_ms ASC, run_id ASC`,
    );
    return res.rows.map(toRecord);
  }

  async listByWorkspace(workspaceId: string): Promise<RunTimeoutRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY started_at_ms DESC, run_id DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }
}

/**
 * Build the production timeout service over the self-managed Postgres store. Pass `releaser` (built via
 * {@link createResourceReleaser} from the worktree pool + lock APIs) to free a hung run's resources; with
 * none supplied the sweep still transitions state, it just frees nothing.
 */
export function createDefaultRunTimeoutService(opts: { releaser?: ResourceReleaser } = {}): RunTimeoutService {
  return new RunTimeoutService({ store: new PgRunTimeoutStore(), releaser: opts.releaser });
}

/** Convenience re-export so an integrator imports the releaser builder from the same module. */
export { createResourceReleaser };
export type { ReleaseLogger, ResourceReleaserOptions };
