/**
 * Resilience config (issues #637/#638). Deliberately **self-contained**: every knob reads straight from
 * the process environment so this feature adds NO edit to the shared `config/schema.ts` barrel, keeping
 * the change set free of parallel-merge conflicts with sibling branches (the #635/#670/#643 convention).
 *
 * Default **OFF** for the retry master switch, the conservative choice for a parallel-merge world: a
 * deployment that sets nothing keeps today's behaviour exactly (one attempt, no retry) — turning retries
 * on is a single env flag (`RESILIENCE_RETRY_ENABLED=1`). The numeric defaults are sized so that once
 * enabled they are immediately sensible (4 attempts, 200ms base, ×2, 20s per-attempt cap, 60s total).
 *
 * Request pacing (#638) is governed separately by `minIntervalMs` — `0` (the default) means "don't pace
 * unless asked", so the rate-limit gate's *Retry-After cooldown* still works out of the box while
 * steady-state spacing stays opt-in.
 */

import type { RetryCaps } from "./decide.js";

/** The full resilience config: retry policy (+ master switch) and request pacing. */
export interface ResilienceCaps {
  readonly retry: RetryCaps & {
    /** Master switch. When false, {@link import("./execute.js").withRetry} runs the operation exactly once. */
    readonly enabled: boolean;
  };
  readonly pacing: {
    /** Minimum spacing between request *starts* through a shared gate, in ms. `0` ⇒ no steady-state pacing. */
    readonly minIntervalMs: number;
  };
}

export const RESILIENCE_DEFAULTS: ResilienceCaps = {
  retry: {
    enabled: false,
    maxAttempts: 4,
    baseMs: 200,
    factor: 2,
    maxDelayMs: 20_000,
    maxElapsedMs: 60_000,
    jitter: "full",
  },
  pacing: {
    minIntervalMs: 0,
  },
};

/** Parse a boolean-ish env flag: `1`/`true`/`yes`/`on` (case-insensitive) ⇒ true; everything else ⇒ false. */
function envFlag(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/** Parse a positive number; a missing/invalid/non-positive value keeps `fallback`. */
function envPositive(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Parse a non-negative number; a missing/invalid/negative value keeps `fallback`. */
function envNonNegative(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** Resolve the resilience caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveResilienceCaps(env: NodeJS.ProcessEnv = process.env): ResilienceCaps {
  const d = RESILIENCE_DEFAULTS;
  const jitterRaw = env.RESILIENCE_RETRY_JITTER?.trim().toLowerCase();
  return {
    retry: {
      enabled: envFlag(env.RESILIENCE_RETRY_ENABLED),
      maxAttempts: Math.trunc(envPositive(env.RESILIENCE_RETRY_MAX_ATTEMPTS, d.retry.maxAttempts)),
      baseMs: envPositive(env.RESILIENCE_RETRY_BASE_MS, d.retry.baseMs),
      factor: envPositive(env.RESILIENCE_RETRY_FACTOR, d.retry.factor),
      maxDelayMs: envPositive(env.RESILIENCE_RETRY_MAX_DELAY_MS, d.retry.maxDelayMs),
      maxElapsedMs: envPositive(env.RESILIENCE_RETRY_MAX_ELAPSED_MS, d.retry.maxElapsedMs),
      jitter: jitterRaw === "none" ? "none" : jitterRaw === "full" ? "full" : d.retry.jitter,
    },
    pacing: {
      minIntervalMs: envNonNegative(env.RESILIENCE_RATE_MIN_INTERVAL_MS, d.pacing.minIntervalMs),
    },
  };
}
