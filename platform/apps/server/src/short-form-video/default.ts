/**
 * Production binding for the short-form video agent (#740). The store here is deliberately **self-managed**:
 * it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an intentional deviation from
 * the repo's usual migration convention, taken to keep the entire #740 change set inside `short-form-video/`
 * so it never collides with a sibling branch's migration numbering or schema barrel — the same
 * parallel-merge-safety pattern as #588/#670/#674. The DDL is additive and idempotent, so it composes safely
 * with the migration runner.
 *
 * The default service is OFF until `SHORTFORM_VIDEO_ENABLED=1` (see `config.ts`) and binds the deterministic
 * offline {@link FakeVideoProvider}, so importing/wiring this module can never, by itself, cause an external
 * call or a spend.
 */

import { getPool } from "../db/index.js";
import { resolveShortFormVideoConfig } from "./config.js";
import { FakeVideoProvider } from "./provider.js";
import { ShortFormVideoService } from "./service.js";
import type { VideoJobRecord, VideoJobStatus, VideoScript, RenderedVideo } from "./types.js";
import type { VideoJobStore } from "./store.js";

const TABLE = "short_form_video_job";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                      text PRIMARY KEY,
  workspace_id            text NOT NULL,
  requested_by_member_id  text NOT NULL,
  topic                   text NOT NULL,
  status                  text NOT NULL,
  script                  jsonb,
  video                   jsonb,
  error                   text,
  created_at              timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ${TABLE}_workspace_created_idx
  ON ${TABLE} (workspace_id, created_at DESC);
`;

interface JobRow {
  id: string;
  workspace_id: string;
  requested_by_member_id: string;
  topic: string;
  status: string;
  script: unknown;
  video: unknown;
  error: string | null;
  created_at: Date;
}

const VALID_STATUSES: readonly VideoJobStatus[] = ["disabled", "missing_brief", "script_only", "rendered"];

function toStatus(raw: string): VideoJobStatus {
  return VALID_STATUSES.includes(raw as VideoJobStatus) ? (raw as VideoJobStatus) : "script_only";
}

function toRecord(row: JobRow): VideoJobRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    requestedByMemberId: row.requested_by_member_id,
    topic: row.topic,
    status: toStatus(row.status),
    // The blobs were written by this module (already validated/sanitized), so this is a shape cast, not a
    // re-sanitization. `null` survives for the disabled/missing-brief paths.
    script: (row.script ?? null) as VideoScript | null,
    video: (row.video ?? null) as RenderedVideo | null,
    error: row.error,
    createdAt: row.created_at,
  };
}

/** Postgres-backed {@link VideoJobStore} that owns (and lazily creates) its own table. */
export class PgVideoJobStore implements VideoJobStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async save(record: VideoJobRecord): Promise<VideoJobRecord> {
    await this.ensureSchema();
    const res = await getPool().query<JobRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, requested_by_member_id, topic, status, script, video, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9)
       ON CONFLICT (id) DO UPDATE SET
         status = EXCLUDED.status,
         script = EXCLUDED.script,
         video = EXCLUDED.video,
         error = EXCLUDED.error
       RETURNING id, workspace_id, requested_by_member_id, topic, status, script, video, error, created_at`,
      [
        record.id,
        record.workspaceId,
        record.requestedByMemberId,
        record.topic,
        record.status,
        record.script ? JSON.stringify(record.script) : null,
        record.video ? JSON.stringify(record.video) : null,
        record.error,
        record.createdAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("short-form-video: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<VideoJobRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<JobRow>(
      `SELECT id, workspace_id, requested_by_member_id, topic, status, script, video, error, created_at
       FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    const row = res.rows[0];
    return row ? toRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string, limit = 50): Promise<VideoJobRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<JobRow>(
      `SELECT id, workspace_id, requested_by_member_id, topic, status, script, video, error, created_at
       FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return res.rows.map(toRecord);
  }
}

let cached: ShortFormVideoService | undefined;

/**
 * Build (once) the production short-form video service: config resolved from the environment (default OFF),
 * the deterministic offline {@link FakeVideoProvider}, over the self-managed Postgres store.
 */
export function createDefaultShortFormVideoService(): ShortFormVideoService {
  if (!cached) {
    cached = new ShortFormVideoService({
      config: resolveShortFormVideoConfig(),
      provider: new FakeVideoProvider(),
      store: new PgVideoJobStore(),
    });
  }
  return cached;
}
