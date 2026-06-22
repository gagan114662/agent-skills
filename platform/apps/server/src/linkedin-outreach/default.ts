/**
 * Production binding for the LinkedIn outreach agent module (issue #595). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use,
 * rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #595 change set
 * inside `linkedin-outreach/` so it never collides with a sibling branch's migration numbering or schema barrel —
 * the explicit parallel-merge-safety goal (the proven #670/#674/#587 pattern). The DDL is additive and
 * idempotent, so it composes safely with the migration runner.
 *
 * The default service binds the deterministic sandbox provider, so a deployment that flips
 * `LINKEDIN_OUTREACH_ENABLED` on still cannot live-send — a real transport is wired only in a later, separately
 * reviewed change. Every workspace-scoped query carries the `workspace_id` (#3 IDOR). The prospect is snapshotted
 * as jsonb so the touch is self-contained for the approval/review queue.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { LinkedInOutreachService } from "./service.js";
import {
  type CreateTouchInput,
  type OutreachOutcomePatch,
  type OutreachStore,
} from "./store.js";
import type { OutreachKind, OutreachStatus, OutreachTouch, Prospect } from "./types.js";

const TABLE = "linkedin_outreach_touches";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  prospect_ref        text NOT NULL,
  prospect            jsonb NOT NULL DEFAULT '{}'::jsonb,
  kind                text NOT NULL,
  body                text NOT NULL DEFAULT '',
  status              text NOT NULL,
  approval_request_id text,
  external_id         text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_sent_idx ON ${TABLE} (workspace_id, status, updated_at DESC);
`;

interface TouchRow {
  id: string;
  workspace_id: string;
  prospect_ref: string;
  prospect: Prospect | string;
  kind: OutreachKind;
  body: string;
  status: OutreachStatus;
  approval_request_id: string | null;
  external_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseProspect(value: Prospect | string): Prospect {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Prospect) : { ref: "", name: "" };
  } catch {
    return { ref: "", name: "" };
  }
}

function toTouch(r: TouchRow): OutreachTouch {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    prospectRef: r.prospect_ref,
    prospect: parseProspect(r.prospect),
    kind: r.kind,
    body: r.body,
    status: r.status,
    approvalRequestId: r.approval_request_id,
    externalId: r.external_id,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link OutreachStore} that owns (and lazily creates) its own table. */
export class PgOutreachStore implements OutreachStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateTouchInput, now: Date): Promise<OutreachTouch> {
    await this.ensureSchema();
    const res = await getPool().query<TouchRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, prospect_ref, prospect, kind, body, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'drafted', $7, $7) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.prospectRef,
        JSON.stringify(input.prospect),
        input.kind,
        input.body,
        now,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("linkedin-outreach: INSERT ... RETURNING produced no row");
    return toTouch(row);
  }

  async get(workspaceId: string, id: string): Promise<OutreachTouch | null> {
    await this.ensureSchema();
    const res = await getPool().query<TouchRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toTouch(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: OutreachStatus): Promise<OutreachTouch[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<TouchRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<TouchRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toTouch);
  }

  async countSentSince(workspaceId: string, since: Date): Promise<number> {
    await this.ensureSchema();
    const res = await getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${TABLE}
        WHERE workspace_id = $1 AND status = 'sent' AND updated_at >= $2`,
      [workspaceId, since],
    );
    return Number.parseInt(res.rows[0]?.count ?? "0", 10);
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: OutreachOutcomePatch,
  ): Promise<OutreachTouch | null> {
    await this.ensureSchema();
    // Only a still-`drafted` touch can transition — the WHERE clause makes the send atomic (never twice).
    const res = await getPool().query<TouchRow>(
      `UPDATE ${TABLE}
         SET status = $3, approval_request_id = $4, external_id = $5, error = $6, updated_at = $7
       WHERE id = $1 AND workspace_id = $2 AND status = 'drafted'
       RETURNING *`,
      [
        id,
        workspaceId,
        patch.status,
        patch.approvalRequestId,
        patch.externalId,
        patch.error,
        patch.updatedAt,
      ],
    );
    return res.rows[0] ? toTouch(res.rows[0]) : null;
  }
}

/**
 * Build the production LinkedIn-outreach service over the self-managed Postgres store and the deterministic
 * sandbox provider (the default — it never live-sends).
 */
export function createDefaultLinkedInOutreachService(): LinkedInOutreachService {
  return new LinkedInOutreachService({ store: new PgOutreachStore() });
}
