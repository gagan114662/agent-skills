/**
 * Production binding for the action-gate (issue #670). The store here is deliberately **self-managed**: it owns
 * its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a shared
 * drizzle migration + a one-line edit to `db/schema/index.ts`. That is an intentional deviation from the repo's
 * usual migration convention, taken to keep the entire #670 change set inside `action-gate/` so it never
 * collides with a sibling branch's migration numbering or schema barrel — the explicit parallel-merge-safety
 * goal. The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * The table is the recorded approval queue the acceptance criterion ("no public/irreversible action executes
 * without a recorded approval") rests on. Every workspace-scoped query carries the `workspace_id` (#3 IDOR).
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { ActionGateService } from "./service.js";
import type { GateClass } from "./classify.js";
import {
  TERMINAL_GATE_STATUSES,
  type CreateGateRequestInput,
  type DecideGatePatch,
  type GateRequest,
  type GateRequestStatus,
  type GateRequestStore,
} from "./store.js";

const TABLE = "action_gate_requests";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  action_type            text NOT NULL,
  surface                text,
  summary                text,
  klass                  text NOT NULL,
  fingerprint            text NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  requested_by_member_id text NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_by_member_id   text,
  decided_at             timestamptz,
  reason                 text,
  expires_at             timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, requested_at DESC);
`;

interface GateRow {
  id: string;
  workspace_id: string;
  action_type: string;
  surface: string | null;
  summary: string | null;
  klass: string;
  fingerprint: string;
  status: GateRequestStatus;
  requested_by_member_id: string;
  requested_at: Date;
  decided_by_member_id: string | null;
  decided_at: Date | null;
  reason: string | null;
  expires_at: Date;
}

function toGateRequest(r: GateRow): GateRequest {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    actionType: r.action_type,
    surface: r.surface,
    summary: r.summary,
    klass: r.klass as GateClass,
    fingerprint: r.fingerprint,
    status: r.status,
    requestedByMemberId: r.requested_by_member_id,
    requestedAt: r.requested_at,
    decidedByMemberId: r.decided_by_member_id,
    decidedAt: r.decided_at,
    reason: r.reason,
    expiresAt: r.expires_at,
  };
}

/** Postgres-backed {@link GateRequestStore} that owns (and lazily creates) its own table. */
export class PgGateRequestStore implements GateRequestStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateGateRequestInput): Promise<GateRequest> {
    await this.ensureSchema();
    const res = await getPool().query<GateRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, action_type, surface, summary, klass, fingerprint, requested_by_member_id, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.actionType,
        input.surface,
        input.summary,
        input.klass,
        input.fingerprint,
        input.requestedByMemberId,
        input.requestedAt,
        input.expiresAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("action-gate: INSERT ... RETURNING produced no row");
    return toGateRequest(row);
  }

  async get(workspaceId: string, id: string): Promise<GateRequest | null> {
    await this.ensureSchema();
    const res = await getPool().query<GateRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toGateRequest(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: GateRequestStatus): Promise<GateRequest[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<GateRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY requested_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<GateRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY requested_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toGateRequest);
  }

  async decide(workspaceId: string, id: string, patch: DecideGatePatch): Promise<GateRequest | null> {
    await this.ensureSchema();
    // Only a still-`pending` request can be decided — the WHERE clause makes the transition atomic.
    const res = await getPool().query<GateRow>(
      `UPDATE ${TABLE}
         SET status = $3, decided_by_member_id = $4, decided_at = $5, reason = $6
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, workspaceId, patch.status, patch.decidedByMemberId, patch.decidedAt, patch.reason],
    );
    return res.rows[0] ? toGateRequest(res.rows[0]) : null;
  }

  async markExecuted(workspaceId: string, id: string, executedAt: Date): Promise<GateRequest | null> {
    await this.ensureSchema();
    // Single-use: only an `approved` row flips to `executed`, atomically — two concurrent consumers cannot both win.
    const res = await getPool().query<GateRow>(
      `UPDATE ${TABLE}
         SET status = 'executed', decided_at = COALESCE(decided_at, $3)
       WHERE id = $1 AND workspace_id = $2 AND status = 'approved'
       RETURNING *`,
      [id, workspaceId, executedAt],
    );
    return res.rows[0] ? toGateRequest(res.rows[0]) : null;
  }

  async markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<GateRequest | null> {
    await this.ensureSchema();
    const terminal = TERMINAL_GATE_STATUSES.map((s) => `'${s}'`).join(", ");
    const res = await getPool().query<GateRow>(
      `UPDATE ${TABLE}
         SET status = 'expired', decided_at = COALESCE(decided_at, $3)
       WHERE id = $1 AND workspace_id = $2 AND status NOT IN (${terminal})
       RETURNING *`,
      [id, workspaceId, expiredAt],
    );
    return res.rows[0] ? toGateRequest(res.rows[0]) : null;
  }
}

/** Build the production action-gate service over the self-managed Postgres store. */
export function createDefaultActionGateService(): ActionGateService {
  return new ActionGateService({ store: new PgGateRequestStore() });
}
