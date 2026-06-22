/**
 * Production binding for the fleet dead-man's switch (issue #592). The store here is deliberately
 * **self-managed**: it owns its two tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first
 * use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #592 change set
 * inside `kill-switch/` (+ its tests) so it never collides with a sibling branch's migration numbering or
 * schema barrel — the explicit parallel-merge-safety goal (the same pattern as #670 / #674 / #676).
 * The DDL is additive and idempotent, so it composes safely with the migration runner.
 *
 * The single switch row is keyed on a constant so there is exactly one global switch (the contrast with the
 * per-workspace #17 kill switch). The default {@link KillSwitchAlertSink} writes to the server log
 * (best-effort); a deployment that wants the alert in Slack/email injects a different sink at construction.
 */

import type { FastifyBaseLogger } from "fastify";
import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { KillSwitchService, type KillSwitchAlert, type KillSwitchAlertSink } from "./service.js";
import {
  ARMED_STATE,
  type AppendEventInput,
  type KillSwitchEvent,
  type KillSwitchSource,
  type KillSwitchState,
  type KillSwitchStatus,
  type KillSwitchStore,
} from "./store.js";
import type { TripwireBreach } from "./tripwire.js";

const STATE_TABLE = "kill_switch_state";
const EVENT_TABLE = "kill_switch_events";

/** There is one global switch; its state row is pinned to this id. */
const GLOBAL_ID = "global";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${STATE_TABLE} (
  id                  text PRIMARY KEY,
  status              text NOT NULL DEFAULT 'armed',
  engaged_at          timestamptz,
  engaged_reason      text,
  source              text,
  engaged_by_member_id text,
  breaches            jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS ${EVENT_TABLE} (
  id               text PRIMARY KEY,
  at               timestamptz NOT NULL DEFAULT now(),
  action           text NOT NULL,
  source           text NOT NULL,
  reason           text,
  actor_member_id  text,
  breaches         jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS ${EVENT_TABLE}_at_idx ON ${EVENT_TABLE} (at DESC);
`;

interface StateRow {
  status: KillSwitchStatus;
  engaged_at: Date | null;
  engaged_reason: string | null;
  source: KillSwitchSource | null;
  engaged_by_member_id: string | null;
  breaches: TripwireBreach[] | string | null;
}

interface EventRow {
  id: string;
  at: Date;
  action: "engage" | "disengage";
  source: KillSwitchSource;
  reason: string | null;
  actor_member_id: string | null;
  breaches: TripwireBreach[] | string | null;
}

/** jsonb may arrive parsed (array) or as text depending on the driver; normalize to an array. */
function parseBreaches(raw: TripwireBreach[] | string | null): TripwireBreach[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function toState(row: StateRow): KillSwitchState {
  return {
    status: row.status,
    engagedAt: row.engaged_at,
    engagedReason: row.engaged_reason,
    source: row.source,
    engagedByMemberId: row.engaged_by_member_id,
    breaches: parseBreaches(row.breaches),
  };
}

function toEvent(row: EventRow): KillSwitchEvent {
  return {
    id: row.id,
    at: row.at,
    action: row.action,
    source: row.source,
    reason: row.reason,
    actorMemberId: row.actor_member_id,
    breaches: parseBreaches(row.breaches),
  };
}

/** Postgres-backed {@link KillSwitchStore} that owns (and lazily creates) its own tables. */
export class PgKillSwitchStore implements KillSwitchStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async getState(): Promise<KillSwitchState> {
    await this.ensureSchema();
    const res = await getPool().query<StateRow>(
      `SELECT status, engaged_at, engaged_reason, source, engaged_by_member_id, breaches
         FROM ${STATE_TABLE} WHERE id = $1`,
      [GLOBAL_ID],
    );
    const row = res.rows[0];
    return row ? toState(row) : { ...ARMED_STATE };
  }

  async saveState(state: KillSwitchState): Promise<void> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${STATE_TABLE}
         (id, status, engaged_at, engaged_reason, source, engaged_by_member_id, breaches, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now())
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         engaged_at = EXCLUDED.engaged_at,
         engaged_reason = EXCLUDED.engaged_reason,
         source = EXCLUDED.source,
         engaged_by_member_id = EXCLUDED.engaged_by_member_id,
         breaches = EXCLUDED.breaches,
         updated_at = now()`,
      [
        GLOBAL_ID,
        state.status,
        state.engagedAt,
        state.engagedReason,
        state.source,
        state.engagedByMemberId,
        JSON.stringify(state.breaches),
      ],
    );
  }

  async appendEvent(input: AppendEventInput): Promise<KillSwitchEvent> {
    await this.ensureSchema();
    const res = await getPool().query<EventRow>(
      `INSERT INTO ${EVENT_TABLE} (id, at, action, source, reason, actor_member_id, breaches)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [
        newId(),
        input.at,
        input.action,
        input.source,
        input.reason,
        input.actorMemberId,
        JSON.stringify(input.breaches),
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("kill-switch: INSERT ... RETURNING produced no row");
    return toEvent(row);
  }

  async listEvents(limit?: number): Promise<KillSwitchEvent[]> {
    await this.ensureSchema();
    const res =
      limit === undefined
        ? await getPool().query<EventRow>(`SELECT * FROM ${EVENT_TABLE} ORDER BY at DESC, id DESC`)
        : await getPool().query<EventRow>(
            `SELECT * FROM ${EVENT_TABLE} ORDER BY at DESC, id DESC LIMIT $1`,
            [Math.max(0, Math.trunc(limit))],
          );
    return res.rows.map(toEvent);
  }
}

/** A best-effort {@link KillSwitchAlertSink} that records the event on the server log. */
export function createLogAlertSink(log: FastifyBaseLogger): KillSwitchAlertSink {
  return {
    async alert(event: KillSwitchAlert): Promise<void> {
      const fields = { kind: event.kind, source: event.source, breaches: event.breaches.length };
      if (event.kind === "engaged") log.error(fields, `[kill-switch] ${event.message}`);
      else log.warn(fields, `[kill-switch] ${event.message}`);
    },
  };
}

/** Build the production dead-man's-switch service over the self-managed Postgres store + the log alert sink. */
export function createDefaultKillSwitchService(log: FastifyBaseLogger): KillSwitchService {
  return new KillSwitchService({ store: new PgKillSwitchStore(), alertSink: createLogAlertSink(log) });
}
