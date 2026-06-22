/**
 * Pure capture-building for run-replay (issue #668). Given a run's deterministic inputs, produce the
 * {@link CapturedRun} record to persist: inputs are **redacted** (reusing the #560 trace redactor — secret
 * keys and known secret values masked) so a capture is never a secret-exfil channel (#25 / #200), then
 * fingerprinted so the stored record is integrity-checkable and reproducible.
 *
 * No IO, no `Date` — the caller supplies `capturedAtMs` and any known secret values. The byte cap is
 * enforced by the service (it owns the config); this module exposes {@link inputByteLength} so the service
 * can check before persisting.
 */

import { redactTracePayload } from "../trace/redact.js";
import { canonicalize, fingerprint } from "./fingerprint.js";
import type { CapturedRun, RunInputs } from "./types.js";

/**
 * Redact a run's inputs before they are stored. The numeric `seed` is not redactable; `prompt`, `config`,
 * and `env` are passed through the trace redactor (sensitive keys masked, known secret values scrubbed,
 * long strings capped). Returns a new object; the input is never mutated.
 */
export function redactInputs(inputs: RunInputs, secretValues: readonly string[] = []): RunInputs {
  const redacted = redactTracePayload(
    { prompt: inputs.prompt, config: inputs.config, env: inputs.env },
    secretValues,
  );
  return {
    prompt: typeof redacted.prompt === "string" ? redacted.prompt : inputs.prompt,
    seed: inputs.seed,
    config: (redacted.config as Record<string, unknown>) ?? {},
    env: (redacted.env as Record<string, string>) ?? {},
  };
}

/** Byte length of a capture's canonical (redacted) inputs — the value the service caps. */
export function inputByteLength(inputs: RunInputs): number {
  return Buffer.byteLength(canonicalize(inputs), "utf8");
}

export interface BuildCaptureInput {
  runId: string;
  workspaceId: string;
  /** Deterministic inputs with the seed already resolved. */
  inputs: RunInputs;
  /** When this capture is itself a replay, the original run's id. */
  replayOf?: string | null;
  /** Epoch-ms the capture was taken. */
  capturedAtMs: number;
}

/**
 * Build a `running` {@link CapturedRun} from resolved inputs. The fingerprint is computed over the
 * *redacted* inputs, so it is exactly reproducible from the stored record (re-fingerprinting `inputs`
 * yields `inputsFingerprint`).
 */
export function buildCapture(input: BuildCaptureInput, secretValues: readonly string[] = []): CapturedRun {
  const inputs = redactInputs(input.inputs, secretValues);
  return {
    runId: input.runId,
    workspaceId: input.workspaceId,
    status: "running",
    inputs,
    inputsFingerprint: fingerprint(inputs),
    replayOf: input.replayOf ?? null,
    capturedAtMs: input.capturedAtMs,
    endedAtMs: null,
    outcome: null,
  };
}
