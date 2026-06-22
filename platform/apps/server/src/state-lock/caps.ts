/**
 * State-lock config (issue #639). Deliberately **self-contained**: every knob is read straight from the
 * process environment so this feature adds NO edit to the shared `config/schema.ts` barrel — keeping the
 * #639 change set free of parallel-merge conflicts with sibling branches (the #635/#670 convention).
 *
 * Unlike the gated features, serialized writes are **ON by default**: a correctness fix you have to opt
 * into is one most deployments will forget, so the safe path is the default and `STATE_LOCK_ENABLED=0`
 * exists only as an escape hatch. The one real tunable is the CAS retry budget — how many times a writer
 * re-reads and re-attempts after losing a race before giving up with a {@link StateConflictError}.
 */

/** Default CAS retry budget: a writer re-attempts up to 8 times under contention before surfacing a conflict. */
export const DEFAULT_MAX_RETRIES = 8;

export interface StateLockCaps {
  /** Master switch for serialized writes. ON by default; set `STATE_LOCK_ENABLED=0` to bypass (unsafe). */
  enabled: boolean;
  /**
   * How many times an update re-reads and re-runs its mutator after losing the optimistic CAS to a
   * concurrent writer, before failing with {@link StateConflictError}. Bounds the work spent on contention.
   */
  maxRetries: number;
}

export const STATE_LOCK_DEFAULTS: StateLockCaps = {
  enabled: true,
  maxRetries: DEFAULT_MAX_RETRIES,
};

/** Parse a boolean-ish env flag. Absent ⇒ the supplied default; otherwise `1/true/yes/on` ⇒ true, else false. */
function envFlag(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive-integer env value; a missing/invalid/non-positive value keeps the supplied default. */
function envPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.trunc(n);
}

/** Resolve the state-lock caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveStateLockCaps(env: NodeJS.ProcessEnv = process.env): StateLockCaps {
  return {
    enabled: envFlag(env.STATE_LOCK_ENABLED, STATE_LOCK_DEFAULTS.enabled),
    maxRetries: envPositiveInt(env.STATE_LOCK_MAX_RETRIES, STATE_LOCK_DEFAULTS.maxRetries),
  };
}
