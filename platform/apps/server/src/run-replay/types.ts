/**
 * Run-replay / reproduce-a-failed-run types (issue #668).
 *
 * A *run* is one agent execution. When a run fails today the debugger is left guessing: the inputs, the
 * random seed, and the config that produced the failure are gone the moment the process moves on, so the
 * failure can't be re-created. This module **captures** every run's deterministic inputs (the prompt/task,
 * the RNG seed, and a config snapshot) up front, stamps the run's **outcome** when it ends, and — for a run
 * that failed — hands the integrator a {@link ReplayPlan}: the exact same inputs + seed + config to feed a
 * fresh execution so the failure reproduces. After the replay runs, {@link verifyReproduction} compares the
 * two outcomes and reports whether the failure was reproduced.
 *
 * Everything here is plain data + pure functions (see `fingerprint.ts`, `capture.ts`, `replay.ts`); all IO
 * lives behind the {@link RunReplayStore} seam (the #17 pure-core + injected-seam pattern), so the whole
 * feature is unit-tested with no clock and no database.
 *
 * Self-contained on purpose (the #635/#670/#674 convention): this module owns its own table via an
 * idempotent `CREATE TABLE IF NOT EXISTS` (see `default.ts`) and reads config from the environment
 * (see `caps.ts`), so the #668 change set touches no migration, no schema barrel, and no app-wiring
 * registry — it never collides with a sibling branch.
 */

/** Lifecycle status of a tracked run. `running` is the only non-terminal state. */
export type RunStatus = "running" | "completed" | "failed";

/** The terminal states a run can end in. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed"];

/** True if `status` is a terminal (no longer running) state. */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

/**
 * The deterministic inputs that fully describe what a run *did*, captured so the run can be re-executed
 * identically. Two runs fed the same {@link RunInputs} should produce the same outcome to the extent the
 * underlying system is deterministic — which is exactly what makes a failure reproducible.
 */
export interface RunInputs {
  /** The task/instruction the run was given (the agent prompt or job payload). */
  prompt: string;
  /**
   * The RNG seed the run used. Captured so any randomness (sampling, jitter, ordering) is reproducible on
   * replay. The service mints one when the caller doesn't supply it, then stores it here verbatim.
   */
  seed: number;
  /**
   * A snapshot of the config that shaped the run — model id, temperature, tool allow-list, feature flags,
   * etc. Opaque JSON; this module never interprets it, it only round-trips and fingerprints it.
   */
  config: Record<string, unknown>;
  /**
   * Relevant environment/context the run read (non-secret config knobs). Redacted on capture (secret keys
   * and known secret values are masked) so a capture is never a secret-exfil channel (#25 / #200).
   */
  env: Record<string, string>;
}

/**
 * How a run ended. `failureSignature` is a normalized, stable description of *how* a failed run failed
 * (e.g. an error class + first message line) — it's what {@link verifyReproduction} compares, so a replay
 * that fails the *same way* counts as a reproduction. `outputFingerprint` is a checksum over the run's
 * output, used to confirm a *successful* replay is byte-identical.
 */
export interface RunOutcome {
  status: Extract<RunStatus, "completed" | "failed">;
  /** Normalized failure description for a failed run; `null` for a completed run. */
  failureSignature: string | null;
  /** SHA-256 (hex) over the canonical serialization of the run's output. */
  outputFingerprint: string;
}

/**
 * One captured run. Times are epoch-ms (the pure core never touches `Date`); `null` fields are "not yet
 * known" (outcome not yet recorded). `workspaceId` scopes every tenant read — a caller can only ever see
 * its own tenant's captures (the #3 IDOR boundary).
 */
export interface CapturedRun {
  /** Server-issued run id (the primary key). */
  runId: string;
  /** Owning workspace (IDOR scoping). */
  workspaceId: string;
  status: RunStatus;
  /** The deterministic inputs captured at run start (redacted). */
  inputs: RunInputs;
  /** SHA-256 (hex) over the canonical serialization of {@link inputs} — integrity + dedup key. */
  inputsFingerprint: string;
  /**
   * When this run is itself a *replay* of an earlier failed run, the original run's id; `null` for a
   * first-class run. Lets the system trace a reproduction back to the failure it was re-creating.
   */
  replayOf: string | null;
  /** When the inputs were captured. */
  capturedAtMs: number;
  /** When the run reached a terminal state, or `null` while running. */
  endedAtMs: number | null;
  /** The recorded outcome, present once the run ends; `null` while running. */
  outcome: RunOutcome | null;
}

/** Input to capture a run at start. `seed` is optional — the service mints one when omitted. */
export interface CaptureRunInput {
  runId: string;
  workspaceId: string;
  prompt: string;
  /** RNG seed; minted by the service when omitted. */
  seed?: number;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  /** When this capture is a replay of an earlier run, that run's id. */
  replayOf?: string | null;
}

/**
 * The plan for re-executing a captured run: exactly the inputs/seed/config the original run used, plus the
 * id it is reproducing and the outcome that replay is expected to reproduce. The integrator drives a fresh
 * run from `inputs`, captures it as a replay (`replayOf = originalRunId`), records its outcome, then calls
 * {@link verifyReproduction} against `expectedOutcome`.
 */
export interface ReplayPlan {
  /** The failed run this plan reproduces. */
  originalRunId: string;
  workspaceId: string;
  /** The exact inputs to feed the fresh execution. */
  inputs: RunInputs;
  /** Fingerprint of {@link inputs} (matches the original capture's). */
  inputsFingerprint: string;
  /** The outcome the original run ended with — what a faithful replay should reproduce. */
  expectedOutcome: RunOutcome;
}

/** Whether a replay reproduced the original failure, and why. */
export type ReproductionKind =
  /** The replay failed the same way the original did — the failure was reproduced. */
  | "reproduced"
  /** The replay did not reproduce the failure (it succeeded, or failed differently). */
  | "diverged"
  /** The original run did not fail, so there is no failure to reproduce. */
  | "not_a_failure";

/** The verdict of comparing an original outcome against a replay outcome. */
export interface ReproductionVerdict {
  kind: ReproductionKind;
  /** True only for `reproduced`. */
  reproduced: boolean;
  /** Stable, user-facing explanation. */
  message: string;
}

// Re-exported here so config types live in one import for callers.
export type { RunReplayCaps } from "./caps.js";
