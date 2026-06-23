/**
 * Production binding for the SEO content pipeline (issue #598). The store here is deliberately **self-managed**:
 * it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #598 change set inside
 * `seo-content/` so it never collides with a sibling branch's migration numbering or schema barrel — the explicit
 * parallel-merge-safety goal (the proven #597/#670/#742 pattern). The DDL is additive and idempotent, so it
 * composes safely with the migration runner.
 *
 * The default service binds the deterministic FAKE provider registry, so a deployment that flips
 * `SEO_CONTENT_PIPELINE_ENABLED` on still cannot make a live call or publish — a real transport is wired only in
 * a later, separately reviewed change. Every workspace-scoped query carries the `workspace_id` (#3 IDOR). The
 * artifacts (keyword / brief / draft) and the blocked reasons are stored as JSONB, since they are read back whole.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { SeoContentPipelineService } from "./service.js";
import type { CreatePipelineRunInput, PipelineRunPatch, PipelineStore } from "./store.js";
import type {
  ContentBrief,
  ContentDraft,
  GateReason,
  KeywordSpec,
  PipelineRun,
  RunStage,
  RunStatus,
} from "./types.js";

const TABLE = "seo_content_runs";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                  text PRIMARY KEY,
  workspace_id        text NOT NULL,
  topic               text NOT NULL,
  stage               text NOT NULL,
  status              text NOT NULL,
  keyword             jsonb,
  brief               jsonb,
  draft               jsonb,
  published_url       text,
  index_receipt_id    text,
  publish_approval_id text,
  index_approval_id   text,
  blocked_reasons     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at DESC);
`;

interface PipelineRow {
  id: string;
  workspace_id: string;
  topic: string;
  stage: RunStage;
  status: RunStatus;
  keyword: KeywordSpec | null;
  brief: ContentBrief | null;
  draft: ContentDraft | null;
  published_url: string | null;
  index_receipt_id: string | null;
  publish_approval_id: string | null;
  index_approval_id: string | null;
  blocked_reasons: GateReason[] | null;
  created_at: Date;
  updated_at: Date;
}

function toRecord(r: PipelineRow): PipelineRun {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    topic: r.topic,
    stage: r.stage,
    status: r.status,
    keyword: r.keyword,
    brief: r.brief,
    draft: r.draft,
    publishedUrl: r.published_url,
    indexReceiptId: r.index_receipt_id,
    publishApprovalId: r.publish_approval_id,
    indexApprovalId: r.index_approval_id,
    blockedReasons: r.blocked_reasons ?? [],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Serialize an artifact (or null) to a JSON string for a JSONB column. */
function json(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value);
}

/** Postgres-backed {@link PipelineStore} that owns (and lazily creates) its own table. */
export class PgPipelineStore implements PipelineStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreatePipelineRunInput, now: Date): Promise<PipelineRun> {
    await this.ensureSchema();
    const res = await getPool().query<PipelineRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, topic, stage, status, blocked_reasons, created_at, updated_at)
       VALUES ($1, $2, $3, 'keyword', 'active', '[]'::jsonb, $4, $4) RETURNING *`,
      [newId(), input.workspaceId, input.topic, now],
    );
    const row = res.rows[0];
    if (!row) throw new Error("seo-content: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<PipelineRun | null> {
    await this.ensureSchema();
    const res = await getPool().query<PipelineRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, status?: RunStatus): Promise<PipelineRun[]> {
    await this.ensureSchema();
    const res = status
      ? await getPool().query<PipelineRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND status = $2 ORDER BY created_at DESC, id DESC`,
          [workspaceId, status],
        )
      : await getPool().query<PipelineRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async applyPatch(workspaceId: string, id: string, patch: PipelineRunPatch): Promise<PipelineRun | null> {
    await this.ensureSchema();
    // The `stage = $expectedStage` predicate makes the advance an atomic compare-and-set: a concurrent advance
    // that already moved the run will not match, so no step ever runs twice.
    const res = await getPool().query<PipelineRow>(
      `UPDATE ${TABLE}
         SET stage = $4, status = $5, keyword = $6::jsonb, brief = $7::jsonb, draft = $8::jsonb,
             published_url = $9, index_receipt_id = $10, publish_approval_id = $11, index_approval_id = $12,
             blocked_reasons = $13::jsonb, updated_at = $14
       WHERE id = $1 AND workspace_id = $2 AND stage = $3
       RETURNING *`,
      [
        id,
        workspaceId,
        patch.expectedStage,
        patch.stage,
        patch.status,
        json(patch.keyword),
        json(patch.brief),
        json(patch.draft),
        patch.publishedUrl,
        patch.indexReceiptId,
        patch.publishApprovalId,
        patch.indexApprovalId,
        json(patch.blockedReasons),
        patch.updatedAt,
      ],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

/**
 * Build the production SEO content pipeline service over the self-managed Postgres store and the deterministic
 * FAKE provider registry (the default — it never makes a live call or publishes). A real transport is wired only
 * in a later, separately reviewed change.
 */
export function createDefaultSeoContentPipelineService(): SeoContentPipelineService {
  return new SeoContentPipelineService({ store: new PgPipelineStore() });
}
