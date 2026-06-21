import type { SessionLogger } from "../runtime/manager.js";
import { loadEnv } from "../env.js";
import { dbSchedulerStore } from "../db/repositories/scheduler-jobs.js";
import { DurableScheduler } from "./scheduler.js";

/**
 * The production durable scheduler (#559): the Postgres-backed store + the deployment's lease/poll/backoff
 * knobs from {@link loadEnv}. `index.ts` registers each engine's `tickAll` as a job and calls `start()`;
 * `buildApp` decorates it and stops it on close. Default-inert: no job is enrolled until an engine's own
 * `*_INTERVAL_MS` opts it in, so wiring this changes nothing until a deployment turns a cadence on.
 */
export function createDefaultScheduler(logger: SessionLogger): DurableScheduler {
  const env = loadEnv();
  return new DurableScheduler({
    store: dbSchedulerStore,
    logger,
    instanceId: env.scheduler.instanceId,
    leaseMs: env.scheduler.leaseMs,
    pollIntervalMs: env.scheduler.pollIntervalMs,
    jobTimeoutMs: env.scheduler.jobTimeoutMs,
    backoff: {
      baseMs: env.scheduler.backoffBaseMs,
      factor: 2,
      capMs: env.scheduler.backoffCapMs,
      // A recurring tick never gives up; `maxAttempts` is unused by `decideNextRun` (kept for the shared shape).
      maxAttempts: Number.MAX_SAFE_INTEGER,
    },
  });
}
