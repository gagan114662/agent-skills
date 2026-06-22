/**
 * Production binding for the conflict-resolution arbiter (issue #587). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #587
 * change set inside `conflict-resolution/` so it never collides with a sibling branch's migration numbering or
 * schema barrel — the explicit parallel-merge-safety goal (the proven #670/#674/#676 pattern). The DDL is
 * additive and idempotent, so it composes safely with the migration runner.
 *
 * The table is the escalation queue the acceptance criterion ("the user sees one clear decision when arbitration
 * escalates") rests on. Every workspace-scoped query carries the `workspace_id` (#3 IDOR). The candidate
 * proposals are snapshotted as jsonb so the review queue is self-contained.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { ConflictResolutionService } from "./service.js";
import {
  type ConflictRecord,
  type ConflictStatus,
  type ConflictStore,
  type CreateConflictInput,
  type DecideConflictPatch,
} from "./store.js";
import type { Proposal, ResolutionOutcome } from "./types.js";

const TABLE = "conflict_resolutions";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  objective_id           text NOT NULL,
  status                 text NOT NULL,
  outcome                text NOT NULL,
  winner_proposal_id     text,
  candidates             jsonb NOT NULL DEFAULT '[]'::jsonb,
  reason                 text NOT NULL DEFAULT '',
  requested_by_member_id text,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_by_member_id   text,
  decided_at             timestamptz,
  expires_at             timestamptz
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_objective_idx ON ${TABLE} (workspace_id, objective_id, requested_at DESC);
`;

interface ConflictRow {
  id: string;
  workspace_id: string;
  objective_id: string;
  status: ConflictStatus;
  outcome: ResolutionOutcome;
  winner_proposal_id: string | null;
  candidates: Proposal[] | string;
  reason: string;
  requested_by_member_id: string | null;
  requested_at: Date;
  decided_by_member_id: string | null;
  decided_at: Date | null;
  expires_at: Date | null;
}

function parseCandidates(value: Proposal[] | string): Proposal[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Proposal[]) : [];
  } catch {
    return [];
  }
}

function toRecord(r: ConflictRow): ConflictRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    objectiveId: r.objective_id,
    status: r.status,
    outcome: r.outcome,
    winnerProposalId: r.winner_proposal_id,
    candidates: parseCandidates(r.candidates),
    reason: r.reason,
    requestedByMemberId: r.requested_by_member_id,
    requestedAt: r.requested_at,
    decidedByMemberId: r.decided_by_member_id,
    decidedAt: r.decided_at,
    expiresAt: r.expires_at,
  };
}

/** Postgres-backed {@link ConflictStore} that owns (and lazily creates) its own table. */
export class PgConflictStore implements ConflictStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateConflictInput): Promise<ConflictRecord> {
    await this.ensureSchema();
    const res = await getPool().query<ConflictRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, objective_id, status, outcome, winner_proposal_id, candidates, reason,
          requested_by_member_id, requested_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.objectiveId,
        input.status,
        input.outcome,
        input.winnerProposalId,
        JSON.stringify(input.candidates),
        input.reason,
        input.requestedByMemberId,
        input.requestedAt,
        input.expiresAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("conflict-resolution: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<ConflictRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ConflictRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: ConflictStatus): Promise<ConflictRecord[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<ConflictRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY requested_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<ConflictRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY requested_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async decide(
    workspaceId: string,
    id: string,
    patch: DecideConflictPatch,
  ): Promise<ConflictRecord | null> {
    await this.ensureSchema();
    // Only a still-`escalated` record can be decided — the WHERE clause makes the transition atomic.
    const res = await getPool().query<ConflictRow>(
      `UPDATE ${TABLE}
         SET status = 'resolved', winner_proposal_id = $3, decided_by_member_id = $4, decided_at = $5,
             reason = COALESCE($6, reason)
       WHERE id = $1 AND workspace_id = $2 AND status = 'escalated'
       RETURNING *`,
      [id, workspaceId, patch.winnerProposalId, patch.decidedByMemberId, patch.decidedAt, patch.reason],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<ConflictRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ConflictRow>(
      `UPDATE ${TABLE}
         SET status = 'expired', decided_at = COALESCE(decided_at, $3)
       WHERE id = $1 AND workspace_id = $2 AND status = 'escalated'
       RETURNING *`,
      [id, workspaceId, expiredAt],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

/** Build the production conflict-resolution service over the self-managed Postgres store. */
export function createDefaultConflictResolutionService(): ConflictResolutionService {
  return new ConflictResolutionService({ store: new PgConflictStore() });
}
