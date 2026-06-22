/**
 * Production binding for the X agent (issue #596). The store here is deliberately **self-managed**: it owns its
 * one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a shared drizzle
 * migration + an edit to `db/schema/index.ts`. That keeps the entire #596 change set inside `x-agent/` so it
 * never collides with a sibling branch's migration numbering or schema barrel — the explicit parallel-merge-
 * safety goal (the proven #670/#674/#587/#742 pattern). The DDL is additive and idempotent, so it composes
 * safely with the migration runner.
 *
 * The default service binds the deterministic sandbox provider, so a deployment that flips `X_AGENT_ENABLED` on
 * still cannot live-post — a real transport is wired only in a later, separately reviewed change. Every
 * workspace-scoped query carries the `workspace_id` (#3 IDOR). The composed content is snapshotted as jsonb so
 * the record is self-contained for the approval/review queue.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { XAgentService } from "./service.js";
import {
  type CreateActionInput,
  type PublishOutcomePatch,
  type ReverseOutcomePatch,
  type XActionStore,
} from "./store.js";
import type { XActionContent, XActionKind, XActionRecord, XActionStatus } from "./types.js";

const TABLE = "x_agent_actions";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                          text PRIMARY KEY,
  workspace_id                text NOT NULL,
  kind                        text NOT NULL,
  content                     jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_tweet_id             text,
  schedule_at                 timestamptz,
  status                      text NOT NULL,
  approval_request_id         text,
  external_id                 text,
  error                       text,
  reverse_approval_request_id text,
  reversed_at                 timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_kind_idx ON ${TABLE} (workspace_id, kind, created_at DESC);
`;

interface ActionRow {
  id: string;
  workspace_id: string;
  kind: XActionKind;
  content: XActionContent | string;
  target_tweet_id: string | null;
  schedule_at: Date | null;
  status: XActionStatus;
  approval_request_id: string | null;
  external_id: string | null;
  error: string | null;
  reverse_approval_request_id: string | null;
  reversed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function parseContent(value: XActionContent | string): XActionContent {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as XActionContent) : {};
  } catch {
    return {};
  }
}

function toRecord(r: ActionRow): XActionRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    content: parseContent(r.content),
    targetTweetId: r.target_tweet_id,
    scheduleAt: r.schedule_at,
    status: r.status,
    approvalRequestId: r.approval_request_id,
    externalId: r.external_id,
    error: r.error,
    reverseApprovalRequestId: r.reverse_approval_request_id,
    reversedAt: r.reversed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link XActionStore} that owns (and lazily creates) its own table. */
export class PgXActionStore implements XActionStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateActionInput, now: Date): Promise<XActionRecord> {
    await this.ensureSchema();
    const res = await getPool().query<ActionRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, kind, content, target_tweet_id, schedule_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'draft', $7, $7) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.kind,
        JSON.stringify(input.content),
        input.targetTweetId,
        input.scheduleAt,
        now,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("x-agent: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<XActionRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ActionRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: XActionStatus): Promise<XActionRecord[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<ActionRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<ActionRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async applyPublishOutcome(
    workspaceId: string,
    id: string,
    patch: PublishOutcomePatch,
  ): Promise<XActionRecord | null> {
    await this.ensureSchema();
    // Only a still-`draft` record can transition — the WHERE clause makes the publish atomic (never twice).
    const res = await getPool().query<ActionRow>(
      `UPDATE ${TABLE}
         SET status = $3, approval_request_id = $4, external_id = $5, error = $6, updated_at = $7
       WHERE id = $1 AND workspace_id = $2 AND status = 'draft'
       RETURNING *`,
      [id, workspaceId, patch.status, patch.approvalRequestId, patch.externalId, patch.error, patch.updatedAt],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async applyReverseOutcome(
    workspaceId: string,
    id: string,
    patch: ReverseOutcomePatch,
  ): Promise<XActionRecord | null> {
    await this.ensureSchema();
    // Only a still-`published` record can transition to `reversed` — atomic (never reversed twice).
    const res = await getPool().query<ActionRow>(
      `UPDATE ${TABLE}
         SET status = 'reversed', reverse_approval_request_id = $3, reversed_at = $4, updated_at = $5
       WHERE id = $1 AND workspace_id = $2 AND status = 'published'
       RETURNING *`,
      [id, workspaceId, patch.reverseApprovalRequestId, patch.reversedAt, patch.updatedAt],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

/**
 * Build the production X-agent service over the self-managed Postgres store and the deterministic sandbox
 * provider (the default — it never live-posts).
 */
export function createDefaultXAgentService(): XAgentService {
  return new XAgentService({ store: new PgXActionStore() });
}
