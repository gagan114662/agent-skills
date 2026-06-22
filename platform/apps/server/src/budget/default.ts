/**
 * Production binding for the spend-cap governor (issue #670). The store here is deliberately
 * **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #670 change set
 * inside `budget/` + `routes/budget.ts` (plus two appended `app.ts` lines) so it never collides with a
 * sibling branch's migration numbering or schema barrel — the explicit parallel-merge-safety goal of #670.
 * The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * The default {@link AlertSink} writes to the server log (best-effort). A deployment that wants the alert to
 * reach Slack/email can inject a different sink when constructing the service — no change here.
 */

import type { FastifyBaseLogger } from "fastify";
import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { BudgetGovernorService, type AlertEvent, type AlertSink } from "./service.js";
import {
  ZERO_RECORD,
  type BudgetStore,
  type CapRaise,
  type CapRaiseStatus,
  type CreateRaiseInput,
  type DecideRaisePatch,
  type GovernorRecord,
} from "./store.js";

const STATE_TABLE = "budget_governor_state";
const RAISE_TABLE = "budget_cap_raises";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
  workspace_id     text PRIMARY KEY,
  cap_cents        bigint NOT NULL DEFAULT 0,
  committed_cents  bigint NOT NULL DEFAULT 0,
  projected_cents  bigint NOT NULL DEFAULT 0,
  alerted_bps      integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${RAISE_TABLE} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  from_cents             bigint NOT NULL,
  to_cents               bigint NOT NULL,
  status                 text NOT NULL DEFAULT 'pending',
  requested_by_member_id text NOT NULL,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  decided_by_member_id   text,
  decided_at             timestamptz,
  reason                 text
);
CREATE INDEX IF NOT EXISTS ${RAISE_TABLE}_ws_status_idx ON ${RAISE_TABLE} (workspace_id, status, requested_at DESC);
`;

interface RaiseRow {
  id: string;
  workspace_id: string;
  from_cents: string | number;
  to_cents: string | number;
  status: CapRaiseStatus;
  requested_by_member_id: string;
  requested_at: Date;
  decided_by_member_id: string | null;
  decided_at: Date | null;
  reason: string | null;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));

function toCapRaise(r: RaiseRow): CapRaise {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    fromCents: n(r.from_cents),
    toCents: n(r.to_cents),
    status: r.status,
    requestedByMemberId: r.requested_by_member_id,
    requestedAt: r.requested_at,
    decidedByMemberId: r.decided_by_member_id,
    decidedAt: r.decided_at,
    reason: r.reason,
  };
}

/** Postgres-backed {@link BudgetStore} that owns (and lazily creates) its own tables. */
export class PgBudgetStore implements BudgetStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async getRecord(workspaceId: string): Promise<GovernorRecord> {
    await this.ensureSchema();
    const res = await getPool().query(
      `SELECT cap_cents, committed_cents, projected_cents, alerted_bps FROM ${STATE_TABLE} WHERE workspace_id = $1`,
      [workspaceId],
    );
    const row = res.rows[0];
    if (!row) return { ...ZERO_RECORD };
    return {
      capCents: n(row.cap_cents),
      committedCents: n(row.committed_cents),
      projectedCents: n(row.projected_cents),
      alertedBps: n(row.alerted_bps),
    };
  }

  async saveRecord(workspaceId: string, record: GovernorRecord): Promise<void> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${STATE_TABLE} (workspace_id, cap_cents, committed_cents, projected_cents, alerted_bps, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (workspace_id) DO UPDATE SET
         cap_cents = EXCLUDED.cap_cents,
         committed_cents = EXCLUDED.committed_cents,
         projected_cents = EXCLUDED.projected_cents,
         alerted_bps = EXCLUDED.alerted_bps,
         updated_at = now()`,
      [workspaceId, record.capCents, record.committedCents, record.projectedCents, record.alertedBps],
    );
  }

  async createRaise(input: CreateRaiseInput): Promise<CapRaise> {
    await this.ensureSchema();
    const res = await getPool().query<RaiseRow>(
      `INSERT INTO ${RAISE_TABLE} (id, workspace_id, from_cents, to_cents, requested_by_member_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [newId(), input.workspaceId, input.fromCents, input.toCents, input.requestedByMemberId],
    );
    return toCapRaise(res.rows[0]);
  }

  async getRaise(workspaceId: string, id: string): Promise<CapRaise | null> {
    await this.ensureSchema();
    const res = await getPool().query<RaiseRow>(
      `SELECT * FROM ${RAISE_TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toCapRaise(res.rows[0]) : null;
  }

  async listRaises(workspaceId: string, status?: CapRaiseStatus): Promise<CapRaise[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<RaiseRow>(
          `SELECT * FROM ${RAISE_TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY requested_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<RaiseRow>(
          `SELECT * FROM ${RAISE_TABLE} WHERE workspace_id = $1 ORDER BY requested_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toCapRaise);
  }

  async updateRaise(workspaceId: string, id: string, patch: DecideRaisePatch): Promise<CapRaise | null> {
    await this.ensureSchema();
    // Only a still-`pending` raise can be decided — the WHERE clause makes the transition atomic.
    const res = await getPool().query<RaiseRow>(
      `UPDATE ${RAISE_TABLE}
         SET status = $3, decided_by_member_id = $4, decided_at = $5, reason = $6
       WHERE id = $1 AND workspace_id = $2 AND status = 'pending'
       RETURNING *`,
      [id, workspaceId, patch.status, patch.decidedByMemberId, patch.decidedAt, patch.reason],
    );
    return res.rows[0] ? toCapRaise(res.rows[0]) : null;
  }
}

/** A best-effort {@link AlertSink} that records the warning on the server log. */
export function createLogAlertSink(log: FastifyBaseLogger): AlertSink {
  return {
    async alert(event: AlertEvent): Promise<void> {
      log.warn(
        { workspaceId: event.workspaceId, kind: event.kind, utilizationBps: event.status.utilizationBps },
        `[budget] ${event.message}`,
      );
    },
  };
}

/** Build the production governor service over the self-managed Postgres store + the log alert sink. */
export function createDefaultBudgetService(log: FastifyBaseLogger): BudgetGovernorService {
  return new BudgetGovernorService({ store: new PgBudgetStore(), alertSink: createLogAlertSink(log) });
}
