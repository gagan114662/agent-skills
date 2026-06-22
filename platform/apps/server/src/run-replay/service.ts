/**
 * Run-replay service (issue #668). The IO shell around the pure capture/replay core. Responsibilities:
 *
 *   1. **Capture** — at run start, record the run's deterministic inputs (prompt, seed, config, env),
 *      redacted and fingerprinted ({@link buildCapture}). The seed is minted here when the caller doesn't
 *      supply one, so even a run that never thought about determinism is captured with a reproducible seed.
 *   2. **Outcome** — when a run ends, stamp how it ended (completed / failed-with-signature + output
 *      fingerprint), turning the capture into a replay candidate.
 *   3. **Replay** — for a *failed* run, {@link prepareReplay} returns the exact inputs/seed/config to feed a
 *      fresh execution; after the integrator drives that replay and records its outcome,
 *      {@link verifyReplay} compares the two and reports whether the failure reproduced.
 *
 * All time comes from the injected `now()` and all persistence from the injected store, so the service is
 * unit-tested with no clock and no DB. A disabled service (the default) captures nothing — every `capture`
 * call is an inert no-op returning null — so turning the feature on is purely additive.
 */

import { randomInt } from "node:crypto";
import { buildCapture, inputByteLength } from "./capture.js";
import { buildReplayPlan, isReplayable, verifyReproduction } from "./replay.js";
import type { RunReplayStore } from "./store.js";
import { resolveRunReplayCaps, type RunReplayCaps } from "./caps.js";
import type {
  CapturedRun,
  CaptureRunInput,
  ReplayPlan,
  ReproductionVerdict,
  RunInputs,
  RunOutcome,
} from "./types.js";

/** Error thrown for invalid replay calls (e.g. preparing a replay of a run that didn't fail). */
export class RunReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunReplayError";
  }
}

/** Largest seed the default minter produces (a positive 32-bit-ish integer; fits any RNG). */
export const MAX_SEED = 2_147_483_647;

export interface RunReplayServiceOptions {
  store: RunReplayStore;
  /** Config caps; resolved from the environment when omitted. */
  caps?: RunReplayCaps;
  /** Epoch-ms clock; defaults to `Date.now`. Injected for deterministic tests. */
  now?: () => number;
  /** Mints a seed when a capture supplies none; defaults to a CSPRNG. Injected for deterministic tests. */
  genSeed?: () => number;
  /**
   * Known secret values to scrub from captured inputs (the run's injected env secrets), in addition to the
   * always-on sensitive-key masking. Defaults to none — the key-scrubber still runs.
   */
  secretValues?: readonly string[];
}

export class RunReplayService {
  private readonly store: RunReplayStore;
  private readonly caps: RunReplayCaps;
  private readonly now: () => number;
  private readonly genSeed: () => number;
  private readonly secretValues: readonly string[];

  constructor(options: RunReplayServiceOptions) {
    this.store = options.store;
    this.caps = options.caps ?? resolveRunReplayCaps();
    this.now = options.now ?? (() => Date.now());
    this.genSeed = options.genSeed ?? (() => randomInt(0, MAX_SEED + 1));
    this.secretValues = options.secretValues ?? [];
  }

  /** Whether capture is enabled (master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /** The configured caps (read-only). */
  getCaps(): RunReplayCaps {
    return { ...this.caps };
  }

  /**
   * Capture a run's inputs at start. Returns the stored {@link CapturedRun}, or `null` when the feature is
   * disabled (an inert no-op). The seed is minted when omitted; inputs are redacted + fingerprinted. Throws
   * {@link RunReplayError} if the redacted inputs exceed the configured byte cap (a partial capture can't
   * reproduce anything, so it is rejected rather than truncated).
   */
  async capture(input: CaptureRunInput): Promise<CapturedRun | null> {
    if (!this.caps.enabled) return null;

    const inputs: RunInputs = {
      prompt: input.prompt,
      seed: input.seed ?? this.genSeed(),
      config: input.config ?? {},
      env: input.env ?? {},
    };
    const capture = buildCapture(
      {
        runId: input.runId,
        workspaceId: input.workspaceId,
        inputs,
        replayOf: input.replayOf ?? null,
        capturedAtMs: this.now(),
      },
      this.secretValues,
    );

    const bytes = inputByteLength(capture.inputs);
    if (bytes > this.caps.maxInputBytes) {
      throw new RunReplayError(
        `run-replay: run ${input.runId} inputs are ${bytes} bytes, over the ${this.caps.maxInputBytes}-byte cap`,
      );
    }
    return this.store.insert(capture);
  }

  /** Stamp a run's terminal outcome. No-op (returns null) when disabled or the run was never captured. */
  async recordOutcome(runId: string, outcome: RunOutcome): Promise<CapturedRun | null> {
    if (!this.caps.enabled) return null;
    return this.store.recordOutcome(runId, outcome, this.now());
  }

  /** Load one capture within a workspace (#3 IDOR scoping). */
  async getCapture(workspaceId: string, runId: string): Promise<CapturedRun | null> {
    return this.store.get(workspaceId, runId);
  }

  /** A workspace's captures, newest first. */
  async listCaptures(workspaceId: string): Promise<CapturedRun[]> {
    return this.store.listByWorkspace(workspaceId);
  }

  /** The replays of a given original run, within a workspace, oldest first. */
  async listReplays(workspaceId: string, originalRunId: string): Promise<CapturedRun[]> {
    return this.store.listReplaysOf(workspaceId, originalRunId);
  }

  /**
   * Build the plan to reproduce a captured *failed* run: the exact inputs/seed/config to re-execute, the
   * original run id, and the outcome the replay should reproduce. Throws {@link RunReplayError} if the run
   * is unknown (in this workspace) or did not fail.
   */
  async prepareReplay(workspaceId: string, runId: string): Promise<ReplayPlan> {
    const capture = await this.store.get(workspaceId, runId);
    if (!capture) throw new RunReplayError(`run ${runId} has no capture in this workspace`);
    const check = isReplayable(capture);
    if (!check.ok) throw new RunReplayError(check.reason);
    return buildReplayPlan(capture);
  }

  /**
   * Compare a finished replay against the original failed run and report whether the failure reproduced.
   * Both runs must be captured (in this workspace) and have a recorded outcome. Throws
   * {@link RunReplayError} if either is missing or unfinished.
   */
  async verifyReplay(
    workspaceId: string,
    originalRunId: string,
    replayRunId: string,
  ): Promise<ReproductionVerdict> {
    const original = await this.store.get(workspaceId, originalRunId);
    if (!original?.outcome) {
      throw new RunReplayError(`original run ${originalRunId} has no recorded outcome in this workspace`);
    }
    const replay = await this.store.get(workspaceId, replayRunId);
    if (!replay?.outcome) {
      throw new RunReplayError(`replay run ${replayRunId} has no recorded outcome in this workspace`);
    }
    return verifyReproduction(original.outcome, replay.outcome);
  }
}
