/**
 * Production binding for run-replay captures (issue #668). The store here is deliberately **self-managed**:
 * it owns its single table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather
 * than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That keeps the entire #668
 * change set inside `run-replay/` so it never collides with a sibling branch's migration numbering or
 * schema barrel (the #635/#670 parallel-merge-safety convention). The DDL is additive and idempotent, so it
 * composes safely with the migration runner.
 *
 * Times are stored as `bigint` epoch-ms (the pure core's currency); the redacted inputs and the outcome
 * ride along as `jsonb`. Wiring this service to the run lifecycle (capture at start, record outcome at end)
 * is left to the integrator — a one-liner, intentionally out of this self-contained change.
 */

import { getPool } from "../db/index.js";
import { RunReplayService } from "./service.js";
import type { RunReplayStore } from "./store.js";
import type { CapturedRun, RunInputs, RunOutcome, RunStatus } from "./types.js";

const TABLE = "run_captures";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  run_id             text PRIMARY KEY,
  workspace_id       text NOT NULL,
  status             text NOT NULL DEFAULT 'running',
  inputs             jsonb NOT NULL,
  inputs_fingerprint text NOT NULL,
  replay_of          text,
  captured_at_ms     bigint NOT NULL,
  ended_at_ms        bigint,
  outcome            jsonb
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_idx ON ${TABLE} (workspace_id, captured_at_ms DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_replay_of_idx ON ${TABLE} (workspace_id, replay_of);
`;

interface Row {
  run_id: string;
  workspace_id: string;
  status: RunStatus;
  inputs: RunInputs;
  inputs_fingerprint: string;
  replay_of: string | null;
  captured_at_ms: string | number;
  ended_at_ms: string | number | null;
  outcome: RunOutcome | null;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));
const nOrNull = (v: string | number | null): number | null => (v === null ? null : n(v));

function toRecord(r: Row): CapturedRun {
  return {
    runId: r.run_id,
    workspaceId: r.workspace_id,
    status: r.status,
    inputs: r.inputs,
    inputsFingerprint: r.inputs_fingerprint,
    replayOf: r.replay_of,
    capturedAtMs: n(r.captured_at_ms),
    endedAtMs: nOrNull(r.ended_at_ms),
    outcome: r.outcome,
  };
}

/** Postgres-backed {@link RunReplayStore} that owns (and lazily creates) its own table. */
export class PgRunReplayStore implements RunReplayStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async insert(capture: CapturedRun): Promise<CapturedRun> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `INSERT INTO ${TABLE} (
         run_id, workspace_id, status, inputs, inputs_fingerprint, replay_of,
         captured_at_ms, ended_at_ms, outcome
       ) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9::jsonb)
       RETURNING *`,
      [
        capture.runId,
        capture.workspaceId,
        capture.status,
        JSON.stringify(capture.inputs),
        capture.inputsFingerprint,
        capture.replayOf,
        capture.capturedAtMs,
        capture.endedAtMs,
        capture.outcome === null ? null : JSON.stringify(capture.outcome),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("run-replay: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, runId: string): Promise<CapturedRun | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE run_id = $1 AND workspace_id = $2`,
      [runId, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async getByRunId(runId: string): Promise<CapturedRun | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(`SELECT * FROM ${TABLE} WHERE run_id = $1`, [runId]);
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async recordOutcome(runId: string, outcome: RunOutcome, endedAtMs: number): Promise<CapturedRun | null> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `UPDATE ${TABLE}
         SET status = $2, outcome = $3::jsonb, ended_at_ms = $4
       WHERE run_id = $1
       RETURNING *`,
      [runId, outcome.status, JSON.stringify(outcome), endedAtMs],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<CapturedRun[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY captured_at_ms DESC, run_id DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }

  async listReplaysOf(workspaceId: string, originalRunId: string): Promise<CapturedRun[]> {
    await this.ensureSchema();
    const res = await getPool().query<Row>(
      `SELECT * FROM ${TABLE}
       WHERE workspace_id = $1 AND replay_of = $2
       ORDER BY captured_at_ms ASC, run_id ASC`,
      [workspaceId, originalRunId],
    );
    return res.rows.map(toRecord);
  }
}

/**
 * Build the production replay service over the self-managed Postgres store. Pass `secretValues` (the run's
 * injected env secrets) so they are scrubbed from captured inputs in addition to the always-on
 * sensitive-key masking; with none supplied the key-scrubber still runs.
 */
export function createDefaultRunReplayService(
  opts: { secretValues?: readonly string[] } = {},
): RunReplayService {
  return new RunReplayService({
    store: new PgRunReplayStore(),
    secretValues: opts.secretValues,
  });
}
