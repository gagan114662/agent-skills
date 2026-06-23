/**
 * Persistence seam for the dependency-aware scheduler (issue #590). The narrow interface the service consumes:
 * append a task, read one back, list a workspace's graph (for planning), and atomically transition a task's
 * status with a CAS precondition (the `from` status). The production binding is the self-managed Postgres store
 * in `default.ts`; unit tests inject {@link InMemoryDependencySchedulerStore}, so the service — and the whole
 * "outbound never runs before its gate" guarantee — is tested with no database and no real clock.
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument and a column on every row) so a caller
 * can only read or mutate its own tenant's graph — the #3 IDOR boundary.
 */

import type { ScheduledTask, TaskKind, TaskStatus } from "./types.js";

/** What the caller supplies to create a task; the store stamps id/timestamps and defaults the status to pending. */
export interface CreateTaskInput {
  workspaceId: string;
  kind: TaskKind;
  dependsOn: string[];
  status?: TaskStatus;
  objectiveId?: string | null;
  label?: string | null;
  priority?: number | null;
  createdAt: Date;
}

/** A persisted task plus its bookkeeping timestamps. */
export interface TaskRecord extends ScheduledTask {
  createdAt: Date;
  updatedAt: Date;
}

export interface DependencySchedulerStore {
  /** Append a new task (defaults to `pending`). */
  create(input: CreateTaskInput): Promise<TaskRecord>;
  /** Load one task within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<TaskRecord | null>;
  /** Every task in a workspace — the full graph the planner needs. Optionally filtered to one objective. */
  list(workspaceId: string, objectiveId?: string): Promise<TaskRecord[]>;
  /**
   * Atomically move a task from `from` to `to`. The `from` precondition makes claiming/advancing race-safe: it
   * is a no-op returning `null` if the row is missing or no longer in `from`. Stamps `updatedAt = at`.
   */
  transition(
    workspaceId: string,
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    at: Date,
  ): Promise<TaskRecord | null>;
}

/**
 * In-memory {@link DependencySchedulerStore} for unit tests. Deterministic: ids are a monotonic counter and the
 * clock is injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryDependencySchedulerStore implements DependencySchedulerStore {
  private readonly rows = new Map<string, TaskRecord>();
  private seq = 0;

  async create(input: CreateTaskInput): Promise<TaskRecord> {
    const id = `task-${++this.seq}`;
    const row: TaskRecord = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      status: input.status ?? "pending",
      dependsOn: [...input.dependsOn],
      objectiveId: input.objectiveId ?? null,
      label: input.label ?? null,
      priority: input.priority ?? 0,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.rows.set(id, row);
    return this.clone(row);
  }

  async get(workspaceId: string, id: string): Promise<TaskRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? this.clone(row) : null;
  }

  async list(workspaceId: string, objectiveId?: string): Promise<TaskRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.workspaceId === workspaceId &&
          (objectiveId === undefined || r.objectiveId === objectiveId),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((r) => this.clone(r));
  }

  async transition(
    workspaceId: string,
    id: string,
    from: TaskStatus,
    to: TaskStatus,
    at: Date,
  ): Promise<TaskRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== from) return null;
    const next: TaskRecord = { ...row, status: to, updatedAt: at };
    this.rows.set(id, next);
    return this.clone(next);
  }

  private clone(row: TaskRecord): TaskRecord {
    return { ...row, dependsOn: [...row.dependsOn] };
  }
}
