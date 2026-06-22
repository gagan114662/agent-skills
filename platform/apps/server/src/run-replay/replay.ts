/**
 * Pure replay logic for run-replay (issue #668). Three pure functions, no IO, no `Date`:
 *
 *   - {@link isReplayable} — only a *failed*, outcome-recorded run can be reproduced; this is the guard.
 *   - {@link buildReplayPlan} — turn a captured failed run into the exact inputs/seed/config to re-execute.
 *   - {@link verifyReproduction} — compare the original outcome against the replay's and decide whether the
 *     failure was reproduced (same failure signature) or the run diverged.
 *
 * The service (`service.ts`) does the IO (load the capture, mint a replay run, persist outcomes) around
 * these, and raises the user-facing error; the guard here is the single source of truth for "can this run
 * be replayed?".
 */

import type {
  CapturedRun,
  ReplayPlan,
  ReproductionVerdict,
  RunOutcome,
} from "./types.js";

/** Whether a captured run can be replayed to reproduce a failure. Only a failed, outcome-stamped run can. */
export function isReplayable(capture: CapturedRun): { ok: true } | { ok: false; reason: string } {
  if (capture.status === "running" || !capture.outcome) {
    return { ok: false, reason: `run ${capture.runId} has not finished yet — nothing to reproduce` };
  }
  if (capture.outcome.status !== "failed") {
    return {
      ok: false,
      reason: `run ${capture.runId} did not fail (status: ${capture.outcome.status}); only failed runs are reproduced`,
    };
  }
  return { ok: true };
}

/**
 * Build the plan to re-execute a captured failed run: the same redacted inputs, the same seed, the same
 * config, the original run id it reproduces, and the outcome a faithful replay should reproduce. Throws if
 * the capture is not replayable — callers should gate on {@link isReplayable} first (the service does, and
 * surfaces a typed error).
 */
export function buildReplayPlan(capture: CapturedRun): ReplayPlan {
  const check = isReplayable(capture);
  if (!check.ok) throw new Error(check.reason);
  // isReplayable guarantees a non-null, failed outcome.
  const expectedOutcome = capture.outcome as RunOutcome;
  return {
    originalRunId: capture.runId,
    workspaceId: capture.workspaceId,
    inputs: capture.inputs,
    inputsFingerprint: capture.inputsFingerprint,
    expectedOutcome,
  };
}

/**
 * Compare an original run's outcome against a replay's outcome and decide whether the failure reproduced.
 * A reproduction means: the original failed, and the replay failed with the *same* failure signature. A
 * replay that succeeds, or fails with a different signature, has *diverged* — the bug did not reproduce
 * deterministically (a real, useful signal: it points at non-determinism or an environment difference).
 */
export function verifyReproduction(original: RunOutcome, replay: RunOutcome): ReproductionVerdict {
  if (original.status !== "failed") {
    return {
      kind: "not_a_failure",
      reproduced: false,
      message: "Original run did not fail, so there is no failure to reproduce.",
    };
  }
  if (replay.status === "failed" && replay.failureSignature === original.failureSignature) {
    return {
      kind: "reproduced",
      reproduced: true,
      message: `Replay reproduced the failure (signature: ${original.failureSignature ?? "unknown"}).`,
    };
  }
  const how =
    replay.status === "completed"
      ? "the replay completed successfully"
      : `the replay failed differently (expected "${original.failureSignature ?? "unknown"}", got "${replay.failureSignature ?? "unknown"}")`;
  return {
    kind: "diverged",
    reproduced: false,
    message: `Replay did not reproduce the failure: ${how} — suspect non-determinism or an environment difference.`,
  };
}
