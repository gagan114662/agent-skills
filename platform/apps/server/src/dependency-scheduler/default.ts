/**
 * Production binding for the dependency-aware scheduler (issue #590). The store here is deliberately
 * **self-managed**: it owns its one table via an idempotent `CREATE TABLE IF NOT EXISTS` run lazily on first use,
 * rather than a shared drizzle migration + an edit to `db/schema/index.ts`. That keeps the entire #590 change set
 * inside `dependency-scheduler/` so it never collides with a sibling branch's migration numbering or schema
 * barrel — the proven #670/#674/#676 parallel-merge-safe pattern. The DDL is additive and idempotent, so it
 * composes safely with the migration runner.
 *
 * Every workspace-scoped query carries `workspace_id` (#3 IDOR). The dependency id list is stored as jsonb so a
 * task's gate dependencies are self-contained on the row.
 */

import { getPool } from "../db/index.js";
import { newId } from "../db/id.js";
import { DependencySchedulerService } from "./service.js";
import type {
  CreateTaskInput,
  DependencySchedulerStore,
  TaskRecord,
} from "./store.js";
import type { TaskKind, TaskStatus } from "./types.js";

const TABLE = "dependency_scheduler_tasks";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ${TABLE} (
  id           text PRIMARY KEY,
  workspace_id text NOT NULL,
  kind         text NOT NULL,
  status       text NOT NULL DEFAULT 'pending',
  depends_on   jsonb NOT NULL DEFAULT '[]'::jsonb,
  objective_id text,
  label        text,
  priority     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_status_idx ON ${TABLE} (workspace_id, status, created_at);
CREATE INDEX IF NOT EXISTS ${TABLE}_ws_objective_idx ON ${TABLE} (workspace_id, objective_id, created_at);
`;

interface TaskRow {
  id: string;
  workspace_id: string;
  kind: TaskKind;
  status: TaskStatus;
  depends_on: string[] | string;
  objective_id: string | null;
  label: string | null;
  priority: number | string;
  created_at: Date;
  updated_at: Date;
}

function parseDependsOn(value: string[] | string): string[] {
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
}

function toRecord(r: TaskRow): TaskRecord {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    kind: r.kind,
    status: r.status,
    dependsOn: parseDependsOn(r.depends_on),
    objectiveId: r.objective_id,
    label: r.label,
    priority: typeof r.priority === "string" ? Number(r.priority) : r.priority,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** Postgres-backed {@link DependencySchedulerStore} that owns (and lazily creates) its own table. */
export class PgDependencySchedulerStore implements DependencySchedulerStore {
  private ready: Promise<void> | undefined;

  private ensureSchema(): Promise<void> {
    if (!this.ready) this.ready = getPool().query(SCHEMA_SQL).then(() => undefined);
    return this.ready;
  }

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    await this.ensureSchema();
    const res = await getPool().query<TaskRow>(
      `INSERT INTO ${TABLE}
         (id, workspace_id, kind, status, depends_on, objective_id, label, priority, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9) RETURNING *`,
      [
        newId(),
        input.workspaceId,
        input.kind,
        input.status ?? "pending",
        JSON.stringify(input.dependsOn),
        input.objectiveId ?? null,
        input.label ?? null,
        input.priority ?? 0,
        input.createdAt,
      ],
    );
    const row = res.rows[0];
    if (!row) throw new Error("dependency-scheduler: INSERT ... RETURNING produced no row");
    return toRecord(row);
  }

  async get(workspaceId: string, id: string): Promise<TaskRecord | null> {
    await this.ensureSchema();
    const res = await getPool().query<TaskRow>(
      `SELECT * FROM ${TABLE} WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }

  async list(workspaceId: string, objectiveId?: string): Promise<TaskRecord[]> {
    await this.ensureSchema();
    const res = objectiveId
      ? await getPool().query<TaskRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 AND objective_id = $2 ORDER BY created_at, id`,
          [workspaceId, objectiveId],
        )
      : await getPool().query<TaskRow>(
          `SELECT * FROM ${TABLE} WHERE workspace_id = $1 ORDER BY created_at, id`,
          [workspaceId],
        );
    return res.rows.map(toRecord);
  }

  async transition(
    workspaceId: string,
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    at: Date,
  ): Promise<TaskRecord | null> {
    await this.ensureSchema();
    // The `status = from` precondition makes the claim/advance atomic — a no-op when the row already moved.
    const res = await getPool().query<TaskRow>(
      `UPDATE ${TABLE}
         SET status = $4, updated_at = $5
       WHERE id = $1 AND workspace_id = $2 AND status = $3
       RETURNING *`,
      [id, workspaceId, from, to, at],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : null;
  }
}

/** Build the production dependency-scheduler service over the self-managed Postgres store. */
export function createDefaultDependencySchedulerService(): DependencySchedulerService {
  return new DependencySchedulerService({ store: new PgDependencySchedulerStore() });
}
