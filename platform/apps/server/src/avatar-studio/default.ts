/**
 * Production binding for the AI UGC avatar studio (issue #741). The store here is deliberately **self-managed**:
 * it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use, rather than a
 * shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #741 change set inside
 * `avatar-studio/` so it never collides with a sibling branch's migration numbering or schema barrel — the
 * explicit parallel-merge-safety goal (the proven #670/#674/#272 pattern). The DDL is additive and idempotent, so
 * it composes safely with the migration runner.
 *
 * The `(workspace_id, avatar_id)` unique key is what makes the first render WIN — `ON CONFLICT DO NOTHING` then a
 * read-back returns the original row, so persona consistency holds even under concurrent renders. Every query
 * carries `workspace_id` (#3 IDOR). The face/voice config is snapshotted as jsonb so the studio is self-contained.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { AvatarStudioService } from "./service.js";
import type { AvatarStudioStore, CreateAvatarInput, StoredAvatar } from "./store.js";
import type { AvatarConfig } from "./types.js";

const TABLE = "avatar_studio_avatars";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id                     text PRIMARY KEY,
  workspace_id           text NOT NULL,
  avatar_id              text NOT NULL,
  display_name           text NOT NULL DEFAULT '',
  config                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider               text NOT NULL DEFAULT 'fake',
  requested_by_member_id text,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ${TABLE}_ws_avatar_uq ON ${TABLE} (workspace_id, avatar_id);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_created_idx ON ${TABLE} (workspace_id, created_at DESC);
`;

interface AvatarRow {
  id: string;
  workspace_id: string;
  avatar_id: string;
  display_name: string;
  config: AvatarConfig | string;
  provider: string;
  requested_by_member_id: string | null;
  created_at: Date;
}

function parseConfig(value: AvatarConfig | string): AvatarConfig {
  const parsed = typeof value === "string" ? (JSON.parse(value) as AvatarConfig) : value;
  return parsed;
}

function toStored(r: AvatarRow): StoredAvatar {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    avatarId: r.avatar_id,
    displayName: r.display_name,
    config: parseConfig(r.config),
    provider: r.provider,
    requestedByMemberId: r.requested_by_member_id,
    createdAt: r.created_at,
  };
}

/** Postgres-backed {@link AvatarStudioStore} that owns (and lazily creates) its own table. */
export class PgAvatarStudioStore implements AvatarStudioStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateAvatarInput): Promise<StoredAvatar> {
    await this.ensureSchema();
    // First render wins: ON CONFLICT DO NOTHING, then read back the canonical row (existing or just-inserted).
    await getPool().query(
      `INSERT INTO ${TABLE}
         (id, workspace_id, avatar_id, display_name, config, provider, requested_by_member_id, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
       ON CONFLICT (workspace_id, avatar_id) DO NOTHING`,
      [
        newId(),
        input.workspaceId,
        input.avatarId,
        input.displayName,
        JSON.stringify(input.config),
        input.provider,
        input.requestedByMemberId,
        input.createdAt,
      ],
    );
    const row = await this.getByAvatarId(input.workspaceId, input.avatarId);
    if (!row) throw new Error("avatar-studio: row vanished after upsert");
    return row;
  }

  async getByAvatarId(workspaceId: string, avatarId: string): Promise<StoredAvatar | null> {
    await this.ensureSchema();
    const res = await getPool().query<AvatarRow>(
      `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND avatar_id = $2`,
      [workspaceId, avatarId],
    );
    return res.rows[0] ? toStored(res.rows[0]) : null;
  }

  async list(workspaceId: string): Promise<StoredAvatar[]> {
    await this.ensureSchema();
    const res = await getPool().query<AvatarRow>(
      `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
      [workspaceId],
    );
    return res.rows.map(toStored);
  }
}

/**
 * Build the production avatar-studio service over the self-managed Postgres store. The provider is left as the
 * deterministic {@link FakeAvatarProvider} default — wire a live provider here only once one exists and the studio
 * is enabled, so nothing external is ever called by default.
 */
export function createDefaultAvatarStudioService(): AvatarStudioService {
  return new AvatarStudioService({ store: new PgAvatarStudioStore() });
}
