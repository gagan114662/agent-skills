/**
 * Production binding for workspace backup/export (issue #676). Like the #670 spend-cap governor, the store
 * here is **self-managed**: it owns its tables via idempotent `CREATE TABLE IF NOT EXISTS` run lazily on
 * first use, rather than a shared drizzle migration + a one-line edit to `db/schema/index.ts`. That is an
 * intentional deviation from the repo's usual migration convention, taken to keep the entire #676 change set
 * inside `backup/` + `routes/backup.ts` so it never collides with a sibling branch's migration numbering or
 * schema barrel — the explicit parallel-merge-safety goal of #676. The DDL is additive and idempotent, so
 * it composes safely with the migration runner.
 *
 * The default {@link BackupDataSource} reads a conservative allowlist of clearly workspace-scoped tables
 * (best-effort: an absent table is skipped, never fatal), producing a real, restorable export. The default
 * {@link RestoreSink} durably records the restored snapshot into a self-managed `workspace_restore_log`
 * table. Replaying a restored snapshot back into the live application tables requires per-table column/FK
 * handling that would touch shared repository code; that re-insertion is a deliberate follow-up (mirroring
 * how #670 left spend-enforcement call-site wiring out of its first change set).
 */

import type { FastifyBaseLogger } from "fastify";
import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import type { WorkspaceSnapshot } from "./archive.js";
import { countRows } from "./archive.js";
import {
  WorkspaceBackupService,
  type BackupDataSource,
  type RestoreSink,
} from "./service.js";
import type { BackupKind, BackupRecord, BackupStore, SaveBackupInput, StoredBackup } from "./store.js";

const BACKUP_TABLE = "workspace_backups";
const RESTORE_LOG_TABLE = "workspace_restore_log";

/**
 * Workspace-scoped tables included in a backup by default. All carry a `workspace_id` column. Override with
 * the `WORKSPACE_BACKUP_TABLES` env var (comma-separated) for a deployment that wants a different set. The
 * names are a fixed allowlist (never user input), so interpolating them into SQL identifiers is safe.
 */
const DEFAULT_BACKUP_TABLES = [
  "agent_sessions",
  "automations",
  "automation_runs",
  "approval_requests",
  "approval_policies",
  "channels",
] as const;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
  id                 text PRIMARY KEY,
  workspace_id       text NOT NULL,
  kind               text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  checksum           text NOT NULL,
  size_bytes         bigint NOT NULL,
  collection_counts  jsonb NOT NULL DEFAULT '{}'::jsonb,
  envelope           text NOT NULL
);
CREATE INDEX IF NOT EXISTS ${BACKUP_TABLE}_ws_created_idx ON ${BACKUP_TABLE} (workspace_id, created_at DESC);
CREATE TABLE IF NOT EXISTS ${RESTORE_LOG_TABLE} (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL,
  applied_at   timestamptz NOT NULL DEFAULT now(),
  collections  integer NOT NULL,
  rows         integer NOT NULL,
  snapshot     jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS ${RESTORE_LOG_TABLE}_ws_applied_idx ON ${RESTORE_LOG_TABLE} (workspace_id, applied_at DESC);
`;

interface BackupRow {
  id: string;
  workspace_id: string;
  kind: BackupKind;
  created_at: Date;
  checksum: string;
  size_bytes: string | number;
  collection_counts: Record<string, number> | null;
  envelope: string;
}

const n = (v: string | number): number => (typeof v === "number" ? v : Number(v));

function toRecord(r: BackupRow): BackupRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    createdAt: r.created_at,
    checksum: r.checksum,
    sizeBytes: n(r.size_bytes),
    collectionCounts: r.collection_counts ?? {},
  };
}

/** Postgres-backed {@link BackupStore} that owns (and lazily creates) its own tables. */
export class PgBackupStore implements BackupStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async save(input: SaveBackupInput): Promise<BackupRecord> {
    await this.ensureSchema();
    const sizeBytes = Buffer.byteLength(input.envelope, "utf8");
    const res = await getPool().query<BackupRow>(
      `INSERT INTO ${BACKUP_TABLE}
         (id, workspace_id, kind, created_at, checksum, size_bytes, collection_counts, envelope)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.kind,
        input.createdAt,
        input.checksum,
        sizeBytes,
        JSON.stringify(input.collectionCounts),
        input.envelope,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("backup: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async list(workspaceId: string): Promise<BackupRecord[]> {
    await this.ensureSchema();
    const res = await getPool().query<BackupRow>(
      `SELECT id, workspace_id, kind, created_at, checksum, size_bytes, collection_counts, envelope
         FROM ${BACKUP_TABLE} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC`,
      [workspaceId],
    );
    return res.rows.map(toRecord);
  }

  async get(workspaceId: string, id: string): Promise<StoredBackup | null> {
    await this.ensureSchema();
    const res = await getPool().query<BackupRow>(
      `SELECT id, workspace_id, kind, created_at, checksum, size_bytes, collection_counts, envelope
         FROM ${BACKUP_TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    const row = res.rows[0];
    return row ? { record: toRecord(row), envelope: row.envelope } : null;
  }

  async prune(workspaceId: string, keep: number): Promise<number> {
    await this.ensureSchema();
    // Keep the newest `keep` rows; delete the rest. The subquery picks the survivors by recency.
    const res = await getPool().query(
      `DELETE FROM ${BACKUP_TABLE}
        WHERE workspace_id = $1
          AND id NOT IN (
            SELECT id FROM ${BACKUP_TABLE}
             WHERE workspace_id = $1
             ORDER BY created_at DESC, id DESC
             LIMIT $2
          )`,
      [workspaceId, Math.max(0, keep)],
    );
    return res.rowCount ?? 0;
  }
}

/** Resolve the backup table allowlist from env (`WORKSPACE_BACKUP_TABLES`) or the conservative default. */
function resolveBackupTables(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env.WORKSPACE_BACKUP_TABLES;
  if (!raw) return [...DEFAULT_BACKUP_TABLES];
  const tables = raw
    .split(",")
    .map((t) => t.trim())
    // Defence: only simple snake_case identifiers may be interpolated into SQL.
    .filter((t) => /^[a-z_][a-z0-9_]*$/.test(t));
  return tables.length > 0 ? tables : [...DEFAULT_BACKUP_TABLES];
}

/**
 * Default {@link BackupDataSource}: reads each allowlisted, workspace-scoped table best-effort. A table that
 * does not exist (or lacks `workspace_id`) is skipped with a log warning rather than failing the whole
 * backup, so the export degrades gracefully across deployments with different schemas.
 */
export class PgBackupDataSource implements BackupDataSource {
  constructor(
    private readonly log: FastifyBaseLogger,
    private readonly tables: string[] = resolveBackupTables(),
  ) {}

  async snapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
    const collections: Record<string, unknown[]> = {};
    for (const table of this.tables) {
      try {
        const res = await getPool().query<{ row: unknown }>(
          `SELECT to_jsonb(t.*) AS row FROM ${table} t WHERE t.workspace_id = $1`,
          [workspaceId],
        );
        collections[table] = res.rows.map((r) => r.row);
      } catch (err) {
        this.log.warn({ table, err }, "[backup] skipped table during snapshot");
      }
    }
    return { collections };
  }
}

/**
 * Default {@link RestoreSink}: durably records the restored snapshot into the self-managed
 * `workspace_restore_log`. Replaying the snapshot back into live application tables (per-table column/FK
 * handling) is a deliberate follow-up — see the module header.
 */
export class PgRestoreSink implements RestoreSink {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async restore(workspaceId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    await this.ensureSchema();
    await getPool().query(
      `INSERT INTO ${RESTORE_LOG_TABLE} (id, workspace_id, collections, rows, snapshot)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [
        newId(),
        workspaceId,
        Object.keys(snapshot.collections).length,
        countRows(snapshot),
        JSON.stringify(snapshot),
      ],
    );
  }
}

/** Build the production backup service over the self-managed Postgres store, data source, and restore sink. */
export function createDefaultBackupService(log: FastifyBaseLogger): WorkspaceBackupService {
  return new WorkspaceBackupService({
    store: new PgBackupStore(),
    dataSource: new PgBackupDataSource(log),
    restoreSink: new PgRestoreSink(),
  });
}
