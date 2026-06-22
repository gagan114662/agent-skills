/**
 * Production binding for the social publishing connectors module (issue #742). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use,
 * rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #742 change set
 * inside `social-publishing/` so it never collides with a sibling branch's migration numbering or schema barrel —
 * the explicit parallel-merge-safety goal (the proven #670/#674/#587 pattern). The DDL is additive and
 * idempotent, so it composes safely with the migration runner.
 *
 * The default service binds the deterministic sandbox provider registry, so a deployment that flips
 * `SOCIAL_PUBLISHING_ENABLED` on still cannot live-post — a real transport is wired only in a later, separately
 * reviewed change. Every workspace-scoped query carries the `workspace_id` (#3 IDOR). The asset is snapshotted as
 * jsonb so the record is self-contained for the approval/review queue.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { SocialPublishingService } from "./service.js";
import {
  type CreatePublishInput,
  type PublishOutcomePatch,
  type PublishStore,
} from "./store.js";
import type { PublishAsset, PublishRecord, PublishStatus, SocialPlatform } from "./types.js";

const TABLE = "social_publish_records";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  platform            text NOT NULL,
  asset               jsonb NOT NULL DEFAULT '{}'::jsonb,
  caption             text NOT NULL DEFAULT '',
  schedule_at         timestamptz,
  status              text NOT NULL,
  approval_request_id text,
  external_id         text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_platform_idx ON ${TABLE} (workspace_id, platform, created_at DESC);
`;

interface PublishRow {
  id: string;
  workspace_id: string;
  platform: SocialPlatform;
  asset: PublishAsset | string;
  caption: string;
  schedule_at: Date | null;
  status: PublishStatus;
  approval_request_id: string | null;
  external_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function parseAsset(value: PublishAsset | string): PublishAsset {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as PublishAsset) : { ref: "" };
  } catch {
    return { ref: "" };
  }
}

function toRecord(r: PublishRow): PublishRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    platform: r.platform,
    asset: parseAsset(r.asset),
    caption: r.caption,
    scheduleAt: r.schedule_at,
    status: r.status,
    approvalRequestId: r.approval_request_id,
    externalId: r.external_id,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link PublishStore} that owns (and lazily creates) its own table. */
export class PgPublishStore implements PublishStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreatePublishInput, now: Date): Promise<PublishRecord> {
    await this.ensureSchema();
    const res = await getPool().query<PublishRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, platform, asset, caption, schedule_at, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'queued', $7, $7) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.platform,
        JSON.stringify(input.asset),
        input.caption,
        input.scheduleAt,
        now,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("social-publishing: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<PublishRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<PublishRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: PublishStatus): Promise<PublishRecord[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<PublishRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<PublishRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: PublishOutcomePatch,
  ): Promise<PublishRecord | null> {
    await this.ensureSchema();
    // Only a still-`queued` record can transition — the WHERE clause makes the publish atomic (never twice).
    const res = await getPool().query<PublishRow>(
      `UPDATE ${TABLE}
         SET status = $3, approval_request_id = $4, external_id = $5, error = $6, updated_at = $7
       WHERE id = $1 AND workspace_id = $2 AND status = 'queued'
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
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

/**
 * Build the production social-publishing service over the self-managed Postgres store and the deterministic
 * sandbox provider registry (the default — it never live-posts).
 */
export function createDefaultSocialPublishingService(): SocialPublishingService {
  return new SocialPublishingService({ store: new PgPublishStore() });
}
