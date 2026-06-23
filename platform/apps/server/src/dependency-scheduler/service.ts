/**
 * The dependency-aware scheduler service (issue #590) — the step the orchestrator calls to decide WHAT may run
 * next. It runs the pure {@link planSchedule} verdict over the persisted {@link DependencySchedulerStore} and
 * guarantees the acceptance criteria:
 *
 *   1. "no outbound action executes while its upstream gate is unmet" — execution is funnelled through ONE method,
 *      {@link DependencySchedulerService.claimNext}, which only ever hands back a task the pure planner marked
 *      runnable, and atomically claims it (pending → running) so it is handed out once. An outbound task is
 *      planner-runnable only when its content gate is `approved`, so distribution structurally cannot precede
 *      approval. The guarantee is inductive: a task is only advanced after being claimed, and is only claimable
 *      when its dependencies are satisfied — so a multi-hop content → review → publish chain clears in order.
 *   2. "the dependency is visible on the task" — `dependsOn` is a first-class field returned on every record and
 *      surfaced in {@link DependencySchedulerService.plan}.
 *
 * Like the #670 action-gate it does no IO except through the injected store and `now` seams, touches no
 * migration / schema barrel / app-wiring registry, and ships **default OFF**: while disabled, `claimNext` returns
 * null so nothing executes through it (planning and listing stay available for visibility).
 */

import { resolveDependencySchedulerCaps, type DependencySchedulerCaps } from "./caps.js";
import { isRunnable, planSchedule } from "./plan.js";
import type {
  CreateTaskInput,
  DependencySchedulerStore,
  TaskRecord,
} from "./store.js";
import type { SchedulePlan, TaskKind, TaskStatus } from "./types.js";

export interface DependencySchedulerDeps {
  store: DependencySchedulerStore;
  /** Resolved caps (enabled flag, fail-closed outbound). Defaults to the env-resolved caps. */
  caps?: DependencySchedulerCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** What the orchestrator passes to schedule a task. */
export interface ScheduleTaskInput {
  workspaceId: string;
  kind: TaskKind;
  /** Upstream task ids this task waits on (the visible dependency). Defaults to none. */
  dependsOn?: string[];
  objectiveId?: string | null;
  label?: string | null;
  priority?: number | null;
}

export class DependencySchedulerService {
  private readonly store: DependencySchedulerStore;
  private readonly caps: DependencySchedulerCaps;
  private readonly now: () => Date;

  constructor(deps: DependencySchedulerDeps) {
    this.store = deps.store;
    this.caps = deps.caps ?? resolveDependencySchedulerCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** The resolved caps (read-only) — handy for a UI hint or dry-run. */
  get policy(): DependencySchedulerCaps {
    return this.caps;
  }

  /** Schedule a task. Recording is always allowed (harmless); only EXECUTION is gated by `enabled`. */
  async schedule(input: ScheduleTaskInput): Promise<TaskRecord> {
    const createInput: CreateTaskInput = {
      workspaceId: input.workspaceId,
      kind: input.kind,
      dependsOn: input.dependsOn ?? [],
      objectiveId: input.objectiveId ?? null,
      label: input.label ?? null,
      priority: input.priority ?? 0,
      createdAt: this.now(),
    };
    return this.store.create(createInput);
  }

  /** Load one task within a workspace. */
  async get(workspaceId: string, id: string): Promise<TaskRecord | null> {
    return this.store.get(workspaceId, id);
  }

  /** Every task in a workspace (optionally one objective), oldest first. */
  async list(workspaceId: string, objectiveId?: string): Promise<TaskRecord[]> {
    return this.store.list(workspaceId, objectiveId);
  }

  /**
   * Compute the current plan for a workspace (optionally scoped to one objective) WITHOUT mutating anything — a
   * dry-run the orchestrator can show: what is runnable, what is blocked and why, what is done. Available even
   * while the module is disabled.
   */
  async plan(workspaceId: string, objectiveId?: string): Promise<SchedulePlan> {
    const tasks = await this.store.list(workspaceId, objectiveId);
    return planSchedule(tasks, this.caps);
  }

  /**
   * Claim the single next runnable task and atomically mark it `running`. Returns null when nothing is runnable,
   * or when the module is disabled (default) — in which case nothing is ever handed out and so nothing executes.
   * Re-plans after each failed CAS so concurrent claimers converge without handing the same task out twice.
   */
  async claimNext(workspaceId: string, objectiveId?: string): Promise<TaskRecord | null> {
    if (!this.caps.enabled) return null;
    // Re-plan on each attempt: a lost CAS means another claimer advanced state, so the plan may have changed.
    for (let attempt = 0; attempt < 64; attempt++) {
      const tasks = await this.store.list(workspaceId, objectiveId);
      const plan = planSchedule(tasks, this.caps);
      const nextId = plan.runnable[0];
      if (nextId === undefined) return null;
      const claimed = await this.store.transition(workspaceId, nextId, "pending", "running", this.now());
      if (claimed) return claimed;
    }
    return null;
  }

  /**
   * Mark an ordinary (non-gate) running task `completed` — it now SATISFIES its dependents. Refuses a task that
   * is not currently `running`.
   */
  async complete(workspaceId: string, id: string): Promise<TaskRecord> {
    return this.advance(workspaceId, id, "running", "completed");
  }

  /** Approve a running gate task — it now SATISFIES its dependents (downstream outbound work may proceed). */
  async approve(workspaceId: string, id: string): Promise<TaskRecord> {
    return this.advance(workspaceId, id, "running", "approved");
  }

  /** Reject a running gate task — permanently blocks its dependents (content must not go out). */
  async reject(workspaceId: string, id: string): Promise<TaskRecord> {
    return this.advance(workspaceId, id, "running", "rejected");
  }

  /** Mark a running task failed — permanently blocks its dependents. */
  async fail(workspaceId: string, id: string): Promise<TaskRecord> {
    return this.advance(workspaceId, id, "running", "failed");
  }

  /** Cancel a task that has not yet completed (pending or running) — permanently blocks its dependents. */
  async cancel(workspaceId: string, id: string): Promise<TaskRecord> {
    const current = await this.store.get(workspaceId, id);
    if (!current) throw new DependencySchedulerError("no such task");
    if (current.status !== "pending" && current.status !== "running") {
      throw new DependencySchedulerError(`cannot cancel a ${current.status} task`);
    }
    const out = await this.store.transition(workspaceId, id, current.status, "cancelled", this.now());
    if (!out) throw new DependencySchedulerError("cancel could not be recorded (task changed concurrently)");
    return out;
  }

  /**
   * The structural guard the actuator path calls before performing an outbound action: assert that `id` is
   * cleared to execute (planner-runnable) right now. Throws otherwise — so an attempt to publish before the gate
   * is approved fails loudly instead of leaking. Returns the task record on success.
   */
  async assertRunnable(workspaceId: string, id: string, objectiveId?: string): Promise<TaskRecord> {
    const tasks = await this.store.list(workspaceId, objectiveId);
    const plan = planSchedule(tasks, this.caps);
    if (!isRunnable(plan, id)) {
      const reason = plan.blocked.find((b) => b.taskId === id)?.reason ?? "not runnable";
      throw new DependencySchedulerError(`task ${id} is not runnable (${reason})`);
    }
    const rec = await this.store.get(workspaceId, id);
    if (!rec) throw new DependencySchedulerError("no such task");
    return rec;
  }

  private async advance(
    workspaceId: string,
    id: string,
    from: TaskStatus,
    to: TaskStatus,
  ): Promise<TaskRecord> {
    const current = await this.store.get(workspaceId, id);
    if (!current) throw new DependencySchedulerError("no such task");
    if (current.status !== from) {
      throw new DependencySchedulerError(`task is ${current.status}, expected ${from}`);
    }
    const out = await this.store.transition(workspaceId, id, from, to, this.now());
    if (!out) throw new DependencySchedulerError("transition could not be recorded (task changed concurrently)");
    return out;
  }
}

/** A scheduler operation rejected for a stated reason (mapped to 4xx at any route layer). */
export class DependencySchedulerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencySchedulerError";
  }
}
