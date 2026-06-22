import type { SessionLogger } from "../runtime/manager.js";
import type { BackoffPolicy } from "../durable-workflow/types.js";
import { decideNextRun } from "./decide.js";
import type {
  ScheduledJob,
  SchedulerJobState,
  SchedulerRegistry,
  SchedulerStore,
} from "./types.js";

/**
 * Durable, single-leader scheduler (#559). It owns ONE poll timer (not one per job): each poll it asks the
 * store to atomically claim each due job's lease for this instance, runs the claimed job's `tickAll`, then
 * persists the cursor + outcome. The store's atomic claim is what makes "exactly one instance fires this
 * interval" hold across N replicas; the persisted cursor is what makes a restart resume mid-cadence.
 *
 * No-hang at two axes:
 *  - cadence — a failing tick is rescheduled on a bounded backoff (`decideNextRun`), never abandoned.
 *  - runtime — each tick runs under a `jobTimeoutMs` race, so a wedged `tickAll` is abandoned, logged, and
 *    backed off instead of pinning the lease forever (the lease also expires so another instance reclaims).
 */

export interface DurableSchedulerDeps {
  store: SchedulerStore;
  logger: SessionLogger;
  /** Unique id for this process/replica — the lease holder written to `locked_by`. */
  instanceId: string;
  /** How long a claimed lease is held before it auto-expires (a crashed leader's lock frees). */
  leaseMs: number;
  /** How often the poll timer fires. Should be `<=` the smallest job interval for timely firing. */
  pollIntervalMs: number;
  /** Bounded backoff for a failing tick (reuses the durable-workflow policy shape). */
  backoff: BackoffPolicy;
  /** Per-run wall-clock bound — a tick that exceeds it is abandoned (no-hang at the runtime axis). */
  jobTimeoutMs: number;
  /** Clock seam — defaults to `Date.now()`; tests inject a fixed clock. */
  now?: () => number;
}

export class DurableScheduler implements SchedulerRegistry {
  private readonly jobs = new Map<string, ScheduledJob>();
  /** Job keys whose row has been materialized this process — `ensureJob` runs once, not every poll. */
  private readonly ensured = new Set<string>();
  private timer?: NodeJS.Timeout;
  private polling = false;

  constructor(private readonly deps: DurableSchedulerDeps) {}

  private nowMs(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /** Enroll a recurring job. `intervalMs <= 0` is a no-op (the job stays disabled — mirrors `start(0)`). */
  register(job: ScheduledJob): void {
    if (job.intervalMs <= 0) {
      this.deps.logger.info({ jobKey: job.key }, "scheduler: job disabled (interval <= 0), not enrolled");
      return;
    }
    this.jobs.set(job.key, job);
    this.deps.logger.info({ jobKey: job.key, intervalMs: job.intervalMs }, "scheduler: job registered");
  }

  deregister(key: string): void {
    this.jobs.delete(key);
    this.ensured.delete(key);
  }

  /** Start the single poll loop (idempotent). Unref'd so it never keeps the process alive on its own. */
  start(): void {
    if (this.timer || this.jobs.size === 0) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollIntervalMs);
    this.timer.unref?.();
  }

  /** Stop the poll loop (idempotent) — called on server shutdown. In-flight ticks finish on their own. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * One poll pass: ensure each job's row exists, then try to claim + run each. Re-entrancy guarded so a
   * slow pass never overlaps itself. Each job is isolated — one job's failure never skips the others.
   */
  async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const jobs = Array.from(this.jobs.values());
      await Promise.all(jobs.map((job) => this.runJob(job)));
    } finally {
      this.polling = false;
    }
  }

  /** Claim + run a single job if it is due for this instance. Public so tests can drive one job directly. */
  async runJob(job: ScheduledJob): Promise<SchedulerJobState | null> {
    const nowMs = this.nowMs();
    try {
      // Materialize the row ONCE per process (the cursor is restart-safe; re-writing it every poll would
      // pointlessly write-lock the shared row on each instance and serialize the whole fleet). Steady-state
      // ticks are then just the cheap atomic claim below.
      if (!this.ensured.has(job.key)) {
        await this.deps.store.ensureJob({ jobKey: job.key, intervalMs: job.intervalMs, nowMs });
        this.ensured.add(job.key);
      }
      const claimed = await this.deps.store.claimDue({
        jobKey: job.key,
        nowMs,
        leaseMs: this.deps.leaseMs,
        instanceId: this.deps.instanceId,
      });
      if (!claimed) return null; // another instance owns this tick, or it isn't due yet.

      const runStartMs = this.nowMs();
      let status: "ok" | "error" = "ok";
      let error: string | null = null;
      try {
        await this.withTimeout(job.run(), job.key);
      } catch (err) {
        status = "error";
        error = redact(err);
        this.deps.logger.error({ err, jobKey: job.key }, `scheduler: job ${job.label ?? job.key} tick failed`);
      }

      const completeMs = this.nowMs();
      const decision = decideNextRun({
        status,
        nowMs: completeMs,
        intervalMs: job.intervalMs,
        priorConsecutiveFailures: claimed.consecutiveFailures,
        policy: this.deps.backoff,
      });
      await this.deps.store.complete({
        jobKey: job.key,
        instanceId: this.deps.instanceId,
        lastRunAtMs: runStartMs,
        nextRunAtMs: decision.nextRunAtMs,
        status,
        error,
        consecutiveFailures: decision.consecutiveFailures,
      });
      return this.deps.store.get(job.key);
    } catch (err) {
      // A store error (e.g. Redis/Postgres blip) must never crash the poll loop; the next poll retries.
      this.deps.logger.error({ err, jobKey: job.key }, "scheduler: job scheduling failed (store error)");
      return null;
    }
  }

  /** Observability snapshot — every job's persisted last-run / next-run / lease state. */
  async snapshot(): Promise<SchedulerJobState[]> {
    return this.deps.store.list();
  }

  private async withTimeout(work: Promise<void>, jobKey: string): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`scheduler job ${jobKey} exceeded ${this.deps.jobTimeoutMs}ms timeout`)),
        this.deps.jobTimeoutMs,
      );
      timer.unref?.();
    });
    try {
      await Promise.race([work, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Redact an error to a short reason — never leak a stack/secret into the persisted `last_error` column. */
function redact(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 500);
}
