/**
 * Production binding for the per-agent scorecard (issue #593). The store here is deliberately **self-managed**: it
 * owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a shared
 * drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #593 change set inside
 * `agent-scorecard/` so it never collides with a sibling branch's migration numbering or schema barrel — the
 * explicit parallel-merge-safety goal (the proven #670/#741/#272 pattern). The DDL is additive and idempotent, so
 * it composes safely with the migration runner.
 *
 * Two tables:
 *   - `agent_scorecard_conversions` — the accumulating conversion ledger. `(workspace_id, event_id)` is unique, so
 *     `ON CONFLICT DO NOTHING` makes re-ingesting a feed safe ("updated as conversions land", idempotently).
 *   - `agent_scorecard_activity` — the current activity snapshot, keyed `(workspace_id, agent_id, channel)`. A
 *     refresh REPLACES the workspace's rows (activity is current-state, not a ledger).
 *
 * Every query carries `workspace_id` (#3 IDOR).
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { ScorecardService } from "./service.js";
import type { ScorecardStore } from "./store.js";
import type { AgentActivity, ConversionEvent, ConversionKind } from "./types.js";

const CONV_TABLE = "agent_scorecard_conversions";
const ACT_TABLE = "agent_scorecard_activity";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${CONV_TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  event_id      text NOT NULL,
  agent_id      text NOT NULL,
  channel       text NOT NULL DEFAULT 'unknown',
  kind          text NOT NULL,
  amount_usd    double precision NOT NULL DEFAULT 0,
  customer_id   text,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${CONV_TABLE}_ws_event_uq ON ${CONV_TABLE} (workspace_id, event_id);
CREATE INDEX IF NOT EXISTS ${CONV_TABLE}_ws_agent_idx ON ${CONV_TABLE} (workspace_id, agent_id);

CREATE TABLE IF NOT EXISTS ${ACT_TABLE} (
  id            text PRIMARY KEY,
  workspace_id  text NOT NULL,
  agent_id      text NOT NULL,
  channel       text NOT NULL DEFAULT 'unknown',
  touches       integer NOT NULL DEFAULT 0,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${ACT_TABLE}_ws_agent_channel_uq ON ${ACT_TABLE} (workspace_id, agent_id, channel);
`;

interface ConversionRow {
  workspace_id: string;
  event_id: string;
  agent_id: string;
  channel: string;
  kind: string;
  amount_usd: number | string;
  customer_id: string | null;
  occurred_at: Date;
}

interface ActivityRow {
  agent_id: string;
  channel: string;
  touches: number | string;
}

function toNumber(value: number | string): number {
  return typeof value === "number" ? value : Number(value);
}

function toEvent(r: ConversionRow): ConversionEvent {
  const event: ConversionEvent = {
    eventId: r.event_id,
    agentId: r.agent_id,
    channel: r.channel,
    kind: r.kind === "revenue" ? "revenue" : "pipeline",
    amountUsd: toNumber(r.amount_usd),
    occurredAt: r.occurred_at,
  };
  if (r.customer_id !== null) event.customerId = r.customer_id;
  return event;
}

/** Postgres-backed {@link ScorecardStore} that owns (and lazily creates) its own two tables. */
export class PgScorecardStore implements ScorecardStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async appendEvents(workspaceId: string, events: readonly ConversionEvent[]): Promise<number> {
    await this.ensureSchema();
    if (events.length === 0) return 0;
    const pool = getPool();
    let inserted = 0;
    for (const e of events) {
      const kind: ConversionKind = e.kind === "revenue" ? "revenue" : "pipeline";
      const res = await pool.query(
        `INSERT INTO ${CONV_TABLE}
           (id, workspace_id, event_id, agent_id, channel, kind, amount_usd, customer_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (workspace_id, event_id) DO NOTHING`,
        [
          newId(),
          workspaceId,
          e.eventId,
          e.agentId,
          e.channel,
          kind,
          e.amountUsd,
          e.customerId ?? null,
          e.occurredAt,
        ],
      );
      inserted += res.rowCount ?? 0;
    }
    return inserted;
  }

  async replaceActivity(workspaceId: string, activities: readonly AgentActivity[]): Promise<number> {
    await this.ensureSchema();
    const pool = getPool();
    // Activity is current-state: clear the workspace's snapshot, then write the latest. Idempotent on re-sync.
    await pool.query(`DELETE FROM ${ACT_TABLE} WHERE workspace_id = $1`, [workspaceId]);
    let written = 0;
    for (const a of activities) {
      const res = await pool.query(
        `INSERT INTO ${ACT_TABLE} (id, workspace_id, agent_id, channel, touches)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (workspace_id, agent_id, channel)
         DO UPDATE SET touches = EXCLUDED.touches, updated_at = now()`,
        [newId(), workspaceId, a.agentId, a.channel, Math.floor(a.touches)],
      );
      written += res.rowCount ?? 0;
    }
    return written;
  }

  async listEvents(workspaceId: string): Promise<ConversionEvent[]> {
    await this.ensureSchema();
    const res = await getPool().query<ConversionRow>(
      `SELECT * FROM ${CONV_TABLE} WHERE workspace_id = $1 ORDER BY occurred_at ASC, event_id ASC`,
      [workspaceId],
    );
    return res.rows.map(toEvent);
  }

  async listActivity(workspaceId: string): Promise<AgentActivity[]> {
    await this.ensureSchema();
    const res = await getPool().query<ActivityRow>(
      `SELECT agent_id, channel, touches FROM ${ACT_TABLE} WHERE workspace_id = $1`,
      [workspaceId],
    );
    return res.rows.map((r) => ({ agentId: r.agent_id, channel: r.channel, touches: toNumber(r.touches) }));
  }
}

/**
 * Build the production scorecard service over the self-managed Postgres store. The source is left as the
 * deterministic {@link FakeConversionSource} default — wire a live source here only once one exists and the
 * scorecard is enabled, so nothing external is ever queried by default.
 */
export function createDefaultScorecardService(): ScorecardService {
  return new ScorecardService({ store: new PgScorecardStore() });
}
