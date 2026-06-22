/**
 * Run-recovery config (issue #643). Deliberately **self-contained**: every knob is read straight from the
 * process environment so this feature adds NO edit to the shared `config/schema.ts` barrel — keeping the
 * #643 change set free of parallel-merge conflicts with sibling branches (the #635/#670 convention).
 *
 * Default **OFF**, owner-workspace-first (the universal convention): a deployment that sets nothing runs
 * an inert recovery pass that reconciles nothing. Turning it on (`RUN_RECOVERY_ENABLED=1`) is all it takes
 * to start resuming/failing orphaned runs on boot.
 */

import { randomUUID } from "node:crypto";

/** Default resume-attempt budget: a run may be resumed across at most 3 restarts before it is failed. */
export const DEFAULT_MAX_RESUME_ATTEMPTS = 3;

export interface RunRecoveryCaps {
  /** Master switch for the recovery pass. OFF by default. */
  enabled: boolean;
  /**
   * How many times a single run may be resumed across restarts before the pass fails it instead — the
   * crash-loop guard (a run that crashes the app every boot must not resume forever).
   */
  maxResumeAttempts: number;
}

export const RUN_RECOVERY_DEFAULTS: RunRecoveryCaps = {
  enabled: false,
  maxResumeAttempts: DEFAULT_MAX_RESUME_ATTEMPTS,
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a non-negative-integer env value; a missing/invalid/negative value keeps the supplied default. */
function envNonNegativeInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.trunc(n);
}

/** Resolve the run-recovery caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveRunRecoveryCaps(env: NodeJS.ProcessEnv = process.env): RunRecoveryCaps {
  return {
    enabled: envFlag(env.RUN_RECOVERY_ENABLED),
    maxResumeAttempts: envNonNegativeInt(env.RUN_RECOVERY_MAX_RESUME_ATTEMPTS, RUN_RECOVERY_DEFAULTS.maxResumeAttempts),
  };
}

/**
 * The instance id for this process. A fresh uuid per boot: each restart is a new owner, so any run still
 * stamped with a prior boot's id is, by definition, orphaned. Overridable via `RUN_RECOVERY_INSTANCE_ID`
 * for deployments that already mint a stable per-process id (e.g. a pod name). Pure given its `env`
 * argument (modulo the random fallback), and free of any DB import so it can be resolved anywhere.
 */
export function resolveInstanceId(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.RUN_RECOVERY_INSTANCE_ID?.trim();
  return raw && raw.length > 0 ? raw : randomUUID();
}
