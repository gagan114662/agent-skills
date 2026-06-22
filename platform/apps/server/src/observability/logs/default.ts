/**
 * Production binding for the durable run-log store (issues #665/#666). Like the #670 budget store, this is
 * deliberately **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run
 * lazily on first use, rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps
 * the whole change set inside `observability/logs/` (+ the already-registered traces route) so it never
 * collides with a sibling branch's migration numbering or schema barrel — the parallel-merge-safety goal.
 * The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * Durability is the point (#665): lines live in Postgres, so a run's log is still readable after the server
 * restarts — unlike the runtime's in-memory line buffer, which dies with the process. `seq` is a DB identity
 * column (globally monotonic), so it doubles as a stable poll cursor without a per-run counter race.
 */

import { getPool } from "../../db/index.js";
import { newId } from "../../db/id.js";
import { RunLogService } from "./service.js";
import { LOG_LIST_HARD_LIMIT, type LogStore, type PersistLineInput } from "./store.js";
import type { LogQuery, LogStream, RunFailure, RunLogLine } from "./types.js";

const LINE_TABLE = "run_log_lines";
const FAILURE_TABLE = "run_failures";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${LINE_TABLE} (
  id           text PRIMARY KEY,
  seq          bigint GENERATED ALWAYS AS IDENTITY,
  workspace_id text NOT NULL,
  run_id       text NOT NULL,
  stream       text NOT NULL,
  body         text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${LINE_TABLE}_ws_run_seq_idx ON ${LINE_TABLE} (workspace_id, run_id, seq);
CREATE INDEX IF NOT EXISTS ${LINE_TABLE}_occurred_idx ON ${LINE_TABLE} (occurred_at);
CREATE TABLE IF NOT EXISTS ${FAILURE_TABLE} (
  workspace_id text NOT NULL,
  run_id       text NOT NULL,
  tool_name    text NOT NULL,
  args         jsonb NOT NULL DEFAULT '{}'::jsonb,
  error        text NOT NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, run_id)
);
CREATE INDEX IF NOT EXISTS ${FAILURE_TABLE}_occurred_idx ON ${FAILURE_TABLE} (occurred_at);
`;

interface LineRow {
  id: string;
  seq: string | number;
  workspace_id: string;
  run_id: string;
  stream: string;
  body: string;
  occurred_at: Date;
}

interface FailureRow {
  workspace_id: string;
  run_id: string;
  tool_name: string;
  args: Record<string, unknown>;
  error: string;
  occurred_at: Date;
}

const num = (v: string | number): number => (typeof v === "number" ? v : Number(v));

function toLine(r: LineRow): RunLogLine {
  return {
    id: r.id,
    seq: num(r.seq),
    workspaceId: r.workspace_id,
    runId: r.run_id,
    stream: r.stream as LogStream,
    text: r.body,
    occurredAt: r.occurred_at,
  };
}

function toFailure(r: FailureRow): RunFailure {
  return {
    workspaceId: r.workspace_id,
    runId: r.run_id,
    toolName: r.tool_name,
    args: r.args ?? {},
    error: r.error,
    occurredAt: r.occurred_at,
  };
}

/** Postgres-backed {@link LogStore} that owns (and lazily creates) its own tables. */
export class PgLogStore implements LogStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async appendLines(input: PersistLineInput[]): Promise<RunLogLine[]> {
    if (input.length === 0) return [];
    await this.ensureSchema();
    // One multi-row INSERT; the DB assigns `seq` (identity) and RETURNING preserves insertion order.
    const params: unknown[] = [];
    const tuples = input.map((l, i) => {
      const b = i * 6; // 6 params per row: id, workspace_id, run_id, stream, body, occurred_at
      params.push(newId(), l.workspaceId, l.runId, l.stream, l.text, l.occurredAt);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    });
    const res = await getPool().query<LineRow>(
      `INSERT INTO ${LINE_TABLE} (id, workspace_id, run_id, stream, body, occurred_at)
       VALUES ${tuples.join(", ")}
       RETURNING id, seq, workspace_id, run_id, stream, body, occurred_at`,
      params,
    );
    return res.rows.map(toLine);
  }

  async listLines(workspaceId: string, runId: string, query: LogQuery): Promise<RunLogLine[]> {
    await this.ensureSchema();
    const after = query.afterSeq ?? 0;
    const limit =
      query.limit && Number.isFinite(query.limit) && query.limit > 0
        ? Math.min(LOG_LIST_HARD_LIMIT, Math.floor(query.limit))
        : LOG_LIST_HARD_LIMIT;
    const res = await getPool().query<LineRow>(
      `SELECT id, seq, workspace_id, run_id, stream, body, occurred_at
         FROM ${LINE_TABLE}
        WHERE workspace_id = $1 AND run_id = $2 AND seq > $3
        ORDER BY seq ASC
        LIMIT $4`,
      [workspaceId, runId, after, limit],
    );
    return res.rows.map(toLine);
  }

  async recordFailure(failure: RunFailure): Promise<void> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${FAILURE_TABLE} (workspace_id, run_id, tool_name, args, error, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6)
       ON CONFLICT (workspace_id, run_id) DO UPDATE SET
         tool_name = EXCLUDED.tool_name,
         args = EXCLUDED.args,
         error = EXCLUDED.error,
         occurred_at = EXCLUDED.occurred_at`,
      [
        failure.workspaceId,
        failure.runId,
        failure.toolName,
        JSON.stringify(failure.args ?? {}),
        failure.error,
        failure.occurredAt,
      ],
    );
  }

  async getFailure(workspaceId: string, runId: string): Promise<RunFailure | null> {
    await this.ensureSchema();
    const res = await getPool().query<FailureRow>(
      `SELECT workspace_id, run_id, tool_name, args, error, occurred_at
         FROM ${FAILURE_TABLE} WHERE workspace_id = $1 AND run_id = $2`,
      [workspaceId, runId],
    );
    return res.rows[0] ? toFailure(res.rows[0]) : null;
  }

  async prune(olderThan: Date): Promise<number> {
    await this.ensureSchema();
    const lines = await getPool().query(`DELETE FROM ${LINE_TABLE} WHERE occurred_at < $1`, [olderThan]);
    const failures = await getPool().query(`DELETE FROM ${FAILURE_TABLE} WHERE occurred_at < $1`, [olderThan]);
    return (lines.rowCount ?? 0) + (failures.rowCount ?? 0);
  }
}

/** Build the production run-log service over the self-managed Postgres store. */
export function createDefaultRunLogService(): RunLogService {
  return new RunLogService(new PgLogStore());
}
