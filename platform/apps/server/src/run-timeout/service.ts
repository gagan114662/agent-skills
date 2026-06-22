/**
 * Run-timeout lifecycle service (issue #635). The IO shell around the pure {@link decideTimeout} core:
 * it records a run's start, the steps it enters, and its heartbeats; lets a run finish gracefully; and —
 * the heart of the fix — sweeps every still-`running` run, transitions any that breached a deadline to a
 * clear `timed_out` state with diagnostics, and frees the resources it held (worktree + lock) through the
 * injected {@link ResourceReleaser}.
 *
 * The sweep is designed to be driven on an interval by a **single leader** (the #559 durable scheduler's
 * DB-lease guarantees exactly one sweeper across replicas), so finalize is never racing itself; a run
 * already terminal is skipped by the pure core regardless. All time comes from the injected `now()` and
 * all persistence from the injected store, so the whole service is unit-tested with no clock and no DB.
 */

import { decideTimeout } from "./decide.js";
import { NOOP_RESOURCE_RELEASER, type ReleaseOutcome, type ResourceReleaser } from "./resources.js";
import type { RunTimeoutStore } from "./store.js";
import { RUN_TIMEOUT_DEFAULTS, resolveRunTimeoutCaps, type RunTimeoutCaps } from "./caps.js";
import {
  isTerminalRunStatus,
  type RunLifecycleStatus,
  type RunTimeoutRecord,
  type StartRunInput,
  type TimeoutDiagnostics,
} from "./types.js";

/** Error thrown for invalid lifecycle calls (e.g. completing a run that isn't tracked). */
export class RunTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunTimeoutError";
  }
}

/** One run the sweep transitioned to `timed_out`, with why and what was freed. */
export interface TimedOutRun {
  record: RunTimeoutRecord;
  diagnostics: TimeoutDiagnostics;
  release: ReleaseOutcome;
}

/** The result of one sweep pass. */
export interface SweepResult {
  /** How many `running` runs were examined. */
  scanned: number;
  /** The runs this pass timed out (newly transitioned), in store order. */
  timedOut: TimedOutRun[];
}

export interface RunTimeoutServiceOptions {
  store: RunTimeoutStore;
  /** Frees a timed-out run's resources. Defaults to {@link NOOP_RESOURCE_RELEASER} (state-only sweeper). */
  releaser?: ResourceReleaser;
  /** Config caps; resolved from the environment when omitted. */
  caps?: RunTimeoutCaps;
  /** Epoch-ms clock; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
}

export class RunTimeoutService {
  private readonly store: RunTimeoutStore;
  private readonly releaser: ResourceReleaser;
  private readonly caps: RunTimeoutCaps;
  private readonly now: () => number;

  constructor(options: RunTimeoutServiceOptions) {
    this.store = options.store;
    this.releaser = options.releaser ?? NOOP_RESOURCE_RELEASER;
    this.caps = options.caps ?? resolveRunTimeoutCaps();
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether the sweeper is enabled (master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /** The configured caps (read-only). */
  getCaps(): RunTimeoutCaps {
    return { ...this.caps };
  }

  /** Begin tracking a run. Budgets fall back to the configured caps. */
  async startRun(input: StartRunInput): Promise<RunTimeoutRecord> {
    const startedAtMs = this.now();
    const runTimeoutMs = positive(input.runTimeoutMs, this.caps.runTimeoutMs, RUN_TIMEOUT_DEFAULTS.runTimeoutMs);
    const stepTimeoutMs = positive(input.stepTimeoutMs, this.caps.stepTimeoutMs, RUN_TIMEOUT_DEFAULTS.stepTimeoutMs);
    const record: RunTimeoutRecord = {
      runId: input.runId,
      workspaceId: input.workspaceId,
      sessionId: input.sessionId ?? null,
      lockKey: input.lockKey ?? null,
      status: "running",
      startedAtMs,
      deadlineAtMs: startedAtMs + runTimeoutMs,
      runTimeoutMs,
      stepTimeoutMs,
      stepName: null,
      stepStartedAtMs: null,
      lastHeartbeatAtMs: startedAtMs,
      endedAtMs: null,
      timeoutKind: null,
      diagnostics: null,
    };
    return this.store.insert(record);
  }

  /** Mark a run as having entered a named step (resets the per-step clock + records progress). No-op if terminal. */
  async beginStep(runId: string, stepName: string): Promise<RunTimeoutRecord | null> {
    const record = await this.requireRunning(runId);
    if (!record) return null;
    const nowMs = this.now();
    return this.store.patch(runId, { stepName, stepStartedAtMs: nowMs, lastHeartbeatAtMs: nowMs });
  }

  /** Clear the in-flight step (between steps the per-step budget does not apply). No-op if terminal. */
  async endStep(runId: string): Promise<RunTimeoutRecord | null> {
    const record = await this.requireRunning(runId);
    if (!record) return null;
    return this.store.patch(runId, { stepName: null, stepStartedAtMs: null, lastHeartbeatAtMs: this.now() });
  }

  /** Record progress (bumps the heartbeat). No-op if the run is already terminal. */
  async heartbeat(runId: string): Promise<RunTimeoutRecord | null> {
    const record = await this.requireRunning(runId);
    if (!record) return null;
    return this.store.patch(runId, { lastHeartbeatAtMs: this.now() });
  }

  /** Finish a run gracefully. `status` must be a non-timeout terminal state. Returns null if not running. */
  async completeRun(runId: string, status: Extract<RunLifecycleStatus, "completed" | "failed">): Promise<RunTimeoutRecord | null> {
    const record = await this.store.getByRunId(runId);
    if (!record) throw new RunTimeoutError(`run ${runId} is not tracked`);
    if (isTerminalRunStatus(record.status)) return null;
    return this.store.patch(runId, {
      status,
      stepName: null,
      stepStartedAtMs: null,
      endedAtMs: this.now(),
    });
  }

  /** Load one run within a workspace (#3 IDOR scoping). */
  async getRun(workspaceId: string, runId: string): Promise<RunTimeoutRecord | null> {
    return this.store.get(workspaceId, runId);
  }

  /** A workspace's tracked runs, newest first. */
  async listRuns(workspaceId: string): Promise<RunTimeoutRecord[]> {
    return this.store.listByWorkspace(workspaceId);
  }

  /**
   * Examine every `running` run and time out any past a deadline: transition it to `timed_out` with
   * diagnostics, then free its worktree + lock (best-effort). A disabled sweeper does nothing. Intended
   * to be invoked on the configured `sweepIntervalMs` by a single leader.
   */
  async sweep(): Promise<SweepResult> {
    if (!this.caps.enabled) return { scanned: 0, timedOut: [] };

    const running = await this.store.listRunning();
    const nowMs = this.now();
    const timedOut: TimedOutRun[] = [];

    for (const record of running) {
      const decision = decideTimeout(record, nowMs);
      if (decision.kind === "ok") continue;

      const { diagnostics } = decision;
      // Conditional-on-running is enforced by the single-leader sweep; the pure core also no-ops on
      // any already-terminal record, so a second pass can never double-finalize.
      const patched = await this.store.patch(record.runId, {
        status: "timed_out",
        endedAtMs: nowMs,
        timeoutKind: diagnostics.kind,
        diagnostics,
      });
      if (!patched) continue;

      const release = await this.releaser.release({
        runId: patched.runId,
        workspaceId: patched.workspaceId,
        sessionId: patched.sessionId,
        lockKey: patched.lockKey,
        reason: diagnostics.kind,
      });
      timedOut.push({ record: patched, diagnostics, release });
    }

    return { scanned: running.length, timedOut };
  }

  /** Load a run by id, returning null when it's missing or already terminal (so lifecycle bumps no-op). */
  private async requireRunning(runId: string): Promise<RunTimeoutRecord | null> {
    const record = await this.store.getByRunId(runId);
    if (!record || isTerminalRunStatus(record.status)) return null;
    return record;
  }
}

/** First strictly-positive finite candidate, else the final fallback. */
function positive(...candidates: Array<number | undefined>): number {
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return Math.trunc(c);
  }
  return 0;
}
