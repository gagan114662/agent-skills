/**
 * Production binding for the community participation agent (issue #597). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use,
 * rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #597 change set
 * inside `community/` so it never collides with a sibling branch's migration numbering or schema barrel — the
 * explicit parallel-merge-safety goal (the proven #670/#674/#742 pattern). The DDL is additive and idempotent, so
 * it composes safely with the migration runner.
 *
 * The default service binds the deterministic sandbox provider registry, so a deployment that flips
 * `COMMUNITY_PARTICIPATION_ENABLED` on still cannot live-fetch or live-post — a real transport is wired only in a
 * later, separately reviewed change. Every workspace-scoped query carries the `workspace_id` (#3 IDOR).
 *
 * The caller supplies the {@link ProductContext} (name/url/topics/disclosure) — this binding does not hardcode it.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import type { ProductContext } from "./draft.js";
import { CommunityParticipationService } from "./service.js";
import type {
  CreateParticipationInput,
  ParticipationOutcomePatch,
  ParticipationStore,
} from "./store.js";
import type { CommunityPlatform, ParticipationRecord, ParticipationStatus } from "./types.js";

const TABLE = "community_participation_records";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  platform            text NOT NULL,
  community_ref       text NOT NULL,
  thread_id           text NOT NULL,
  thread_title        text NOT NULL DEFAULT '',
  body                text NOT NULL DEFAULT '',
  mentions_product    boolean NOT NULL DEFAULT false,
  relevance           double precision NOT NULL DEFAULT 0,
  status              text NOT NULL,
  approval_request_id text,
  external_id         text,
  error               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_community_idx ON ${TABLE} (workspace_id, platform, community_ref, updated_at DESC);
`;

interface ParticipationRow {
  id: string;
  workspace_id: string;
  platform: CommunityPlatform;
  community_ref: string;
  thread_id: string;
  thread_title: string;
  body: string;
  mentions_product: boolean;
  relevance: number;
  status: ParticipationStatus;
  approval_request_id: string | null;
  external_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(r: ParticipationRow): ParticipationRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    platform: r.platform,
    communityRef: r.community_ref,
    threadId: r.thread_id,
    threadTitle: r.thread_title,
    body: r.body,
    mentionsProduct: r.mentions_product,
    relevance: r.relevance,
    status: r.status,
    approvalRequestId: r.approval_request_id,
    externalId: r.external_id,
    error: r.error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link ParticipationStore} that owns (and lazily creates) its own table. */
export class PgParticipationStore implements ParticipationStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateParticipationInput, now: Date): Promise<ParticipationRecord> {
    await this.ensureSchema();
    const res = await getPool().query<ParticipationRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, platform, community_ref, thread_id, thread_title, body,
          mentions_product, relevance, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $10) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.platform,
        input.communityRef,
        input.threadId,
        input.threadTitle,
        input.body,
        input.mentionsProduct,
        input.relevance,
        now,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("community: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<ParticipationRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<ParticipationRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: ParticipationStatus): Promise<ParticipationRecord[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<ParticipationRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<ParticipationRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async recentPosted(
    workspaceId: string,
    platform: CommunityPlatform,
    communityRef: string,
    limit: number,
  ): Promise<ParticipationRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<ParticipationRow>(
      `SELECT * FROM ${TABLE}
         WHERE workspace_id = $1 AND platform = $2 AND community_ref = $3 AND status = 'posted'
       ORDER BY updated_at DESC, id DESC
       LIMIT $4`,
      [workspaceId, platform, communityRef, Math.max(0, limit)],
    );
    return res.rows.map(toRecord);
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: ParticipationOutcomePatch,
  ): Promise<ParticipationRecord | null> {
    await this.ensureSchema();
    // Only a still-`queued` record can transition — the WHERE clause makes the post atomic (never twice).
    const res = await getPool().query<ParticipationRow>(
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
 * Build the production community-participation service over the self-managed Postgres store and the deterministic
 * sandbox provider registry (the default — it never live-participates). The caller supplies the product context.
 */
export function createDefaultCommunityParticipationService(
  product: ProductContext,
): CommunityParticipationService {
  return new CommunityParticipationService({ store: new PgParticipationStore(), product });
}
