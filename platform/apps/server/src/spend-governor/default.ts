/**
 * Production binding for the per-channel spend governor (issue #591). The store here is deliberately
 * **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #591 change set
 * inside `spend-governor/` so it never collides with a sibling branch's migration numbering or schema barrel —
 * the explicit parallel-merge-safety goal of #591. The DDL is additive and idempotent, so it composes safely
 * with the migration runner.
 *
 * The default {@link AlertSink} writes to the server log (best-effort). A deployment that wants the alert to
 * reach Slack/email can inject a different sink when constructing the service — no change here.
 */

import type { FastifyBaseLogger } from "fastify";
import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { SpendGovernorService, type AlertEvent, type AlertSink } from "./service.js";
import {
  ZERO_RECORD,
  type CapRaise,
  type CapRaiseStatus,
  type ChannelRecord,
  type ChannelRecordRow,
  type ChannelSpendStore,
  type CreateRaiseInput,
  type DecideRaisePatch,
} from "./store.js";

const STATE_TABLE = "spend_governor_channel_state";
const RAISE_TABLE = "spend_governor_cap_raises";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
  workspace_id     text NOT NULL,
  channel          text NOT NULL,
  cap_cents        bigint NOT NULL DEFAULT 0,
  committed_cents  bigint NOT NULL DEFAULT 0,
  projected_cents  bigint NOT NULL DEFAULT 0,
  period_key       bigint NOT NULL DEFAULT 0,
  alerted_bps      integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, channel)
);
CREATE TABLE IF NOT EXISTS ${RAISE_TABLE} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  channel                text NOT NULL,
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

interface StateRow {
  channel: string;
  cap_cents: string | number;
  committed_cents: string | number;
  projected_cents: string | number;
  period_key: string | number;
  alerted_bps: string | number;
}

interface RaiseRow {
  id: string;
  workspace_id: string;
  channel: string;
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

function toRecord(r: StateRow): ChannelRecord {
  return {
    capCents: n(r.cap_cents),
    committedCents: n(r.committed_cents),
    projectedCents: n(r.projected_cents),
    periodKey: n(r.period_key),
    alertedBps: n(r.alerted_bps),
  };
}

function toCapRaise(r: RaiseRow): CapRaise {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    channel: r.channel,
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

/** Postgres-backed {@link ChannelSpendStore} that owns (and lazily creates) its own tables. */
export class PgChannelSpendStore implements ChannelSpendStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async getRecord(workspaceId: string, channel: string): Promise<ChannelRecord> {
    await this.ensureSchema();
    const res = await getPool().query<StateRow>(
      `SELECT channel, cap_cents, committed_cents, projected_cents, period_key, alerted_bps
         FROM ${STATE_TABLE} WHERE workspace_id = $1 AND channel = $2`,
      [workspaceId, channel],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : { ...ZERO_RECORD };
  }

  async saveRecord(workspaceId: string, channel: string, record: ChannelRecord): Promise<void> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${STATE_TABLE}
         (workspace_id, channel, cap_cents, committed_cents, projected_cents, period_key, alerted_bps, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (workspace_id, channel) DO UPDATE SET
         cap_cents = EXCLUDED.cap_cents,
         committed_cents = EXCLUDED.committed_cents,
         projected_cents = EXCLUDED.projected_cents,
         period_key = EXCLUDED.period_key,
         alerted_bps = EXCLUDED.alerted_bps,
         updated_at = now()`,
      [
        workspaceId,
        channel,
        record.capCents,
        record.committedCents,
        record.projectedCents,
        record.periodKey,
        record.alertedBps,
      ],
    );
  }

  async listRecords(workspaceId: string): Promise<ChannelRecordRow[]> {
    await this.ensureSchema();
    const res = await getPool().query<StateRow>(
      `SELECT channel, cap_cents, committed_cents, projected_cents, period_key, alerted_bps
         FROM ${STATE_TABLE} WHERE workspace_id = $1 ORDER BY channel ASC`,
      [workspaceId],
    );
    return res.rows.map((r) => ({ ...toRecord(r), channel: r.channel }));
  }

  async createRaise(input: CreateRaiseInput): Promise<CapRaise> {
    await this.ensureSchema();
    const res = await getPool().query<RaiseRow>(
      `INSERT INTO ${RAISE_TABLE} (id, workspace_id, channel, from_cents, to_cents, requested_by_member_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [newId(), input.workspaceId, input.channel, input.fromCents, input.toCents, input.requestedByMemberId],
    );
    const row = res.rows[0];
    if (!row) throw new Error("spend-governor: INSERT ... RETURNING produced no row");
    return toCapRaise(row);
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
        { workspaceId: event.workspaceId, channel: event.channel, kind: event.kind, utilizationBps: event.status.utilizationBps },
        `[spend-governor] ${event.message}`,
      );
    },
  };
}

/** Build the production governor service over the self-managed Postgres store + the log alert sink. */
export function createDefaultSpendGovernorService(log: FastifyBaseLogger): SpendGovernorService {
  return new SpendGovernorService({ store: new PgChannelSpendStore(), alertSink: createLogAlertSink(log) });
}
