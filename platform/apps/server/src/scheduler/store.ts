import { isClaimable } from "./decide.js";
import type { SchedulerJobState, SchedulerStore } from "./types.js";

/**
 * In-memory {@link SchedulerStore} for unit tests + the no-DB fallback. JavaScript's single-threaded run-to-
 * completion semantics make each method body its own critical section: `claimDue` reads-then-writes with no
 * `await` in between, so two schedulers sharing ONE instance of this store still claim a due tick exactly
 * once (the same single-fire guarantee the Postgres store gets from an atomic UPDATE). Deep-clones on the
 * way in/out so a caller can never mutate persisted state by reference.
 */
export class InMemorySchedulerStore implements SchedulerStore {
  private readonly byKey = new Map<string, SchedulerJobState>();

  async ensureJob(input: {
    jobKey: string;
    intervalMs: number;
    nowMs: number;
  }): Promise<SchedulerJobState> {
    const existing = this.byKey.get(input.jobKey);
    if (existing) {
      // Keep the persisted cursor (restart-safe); refresh the cadence to the registered value.
      existing.intervalMs = input.intervalMs;
      existing.updatedAtMs = input.nowMs;
      return clone(existing);
    }
    const state: SchedulerJobState = {
      jobKey: input.jobKey,
      intervalMs: input.intervalMs,
      // First cursor is one interval out — a fresh job fires after one interval, like setInterval.
      nextRunAtMs: input.nowMs + Math.max(0, input.intervalMs),
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      consecutiveFailures: 0,
      lockedBy: null,
      lockedUntilMs: null,
      updatedAtMs: input.nowMs,
    };
    this.byKey.set(input.jobKey, state);
    return clone(state);
  }

  async claimDue(input: {
    jobKey: string;
    nowMs: number;
    leaseMs: number;
    instanceId: string;
  }): Promise<SchedulerJobState | null> {
    const state = this.byKey.get(input.jobKey);
    if (!state) return null;
    if (!isClaimable(state, input.nowMs)) return null;
    state.lockedBy = input.instanceId;
    state.lockedUntilMs = input.nowMs + input.leaseMs;
    state.updatedAtMs = input.nowMs;
    return clone(state);
  }

  async complete(input: {
    jobKey: string;
    instanceId: string;
    lastRunAtMs: number;
    nextRunAtMs: number;
    status: SchedulerJobState["lastStatus"];
    error: string | null;
    consecutiveFailures: number;
  }): Promise<void> {
    const state = this.byKey.get(input.jobKey);
    if (!state) return;
    // Only the lease holder may complete (a reclaimed lease means someone else owns the cursor now).
    if (state.lockedBy !== input.instanceId) return;
    state.lastRunAtMs = input.lastRunAtMs;
    state.nextRunAtMs = input.nextRunAtMs;
    state.lastStatus = input.status;
    state.lastError = input.error;
    state.consecutiveFailures = input.consecutiveFailures;
    state.lockedBy = null;
    state.lockedUntilMs = null;
    state.updatedAtMs = input.lastRunAtMs;
  }

  async get(jobKey: string): Promise<SchedulerJobState | null> {
    const state = this.byKey.get(jobKey);
    return state ? clone(state) : null;
  }

  async list(): Promise<SchedulerJobState[]> {
    return Array.from(this.byKey.values(), clone);
  }
}

function clone(value: SchedulerJobState): SchedulerJobState {
  return { ...value };
}
