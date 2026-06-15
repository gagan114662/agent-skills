/**
 * Fleet model registry + launch-time model preflight (#246).
 *
 * THE root cause of every agent crash (live-confirmed 2026-06-15): the runtime was pinned to
 * `claude-fable-5` — a model id the account 403s on ("not available, please use Opus 4.8"). The
 * harness emits `--model "$ANTHROPIC_MODEL"`, so every `claude -p` session was rejected by the API and
 * exited 1 having produced nothing → the owner saw only "error · exit 1". #244 corrected the codebase
 * DEFAULT but the deployed prod workspace stayed pinned to Fable, so the crash persisted.
 *
 * Owner decision: the fleet model is **`claude-opus-4-8`**, run on the connected Claude SUBSCRIPTION
 * (never an API key). This module makes a bad model id impossible to silently ship again: it owns the
 * canonical default + the set of models known to resolve, and a pure, total preflight (`assertModelLaunchable`)
 * that the SessionManager runs BEFORE spawning a real `claude-code` session and that the model picker
 * runs on save — so an unservable model surfaces an actionable OWNER error ("model X is unavailable —
 * pick a valid model") instead of crashing every session mid-run.
 */

/** The project-canonical fleet model (owner decision, #246). New workspaces + the env default use this. */
export const DEFAULT_AGENT_MODEL = "claude-opus-4-8";

/**
 * Models known to resolve on a current Claude subscription — the allowlist the launch preflight + the
 * owner model picker validate against. Curated (not every historical id) so an obvious-garbage id like
 * `claude-fable-5` is rejected deterministically with no network call / no spend. A future valid model
 * the owner wants before this list is updated can be allowed without a code deploy via
 * `RELOAD_KNOWN_MODELS` (a comma-separated env escape hatch), so the guard can never become a hard
 * blocker for a legitimately-new model.
 */
export const KNOWN_AGENT_MODELS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
] as const;

/** A model id must be a plain identifier — no shell/path-hostile characters (defense in depth). */
const MODEL_ID_RE = /^[A-Za-z0-9._:\-/]+$/;

/** Parse the optional `RELOAD_KNOWN_MODELS` escape-hatch list (comma-separated, charset-validated). */
function extraKnownModels(env: NodeJS.ProcessEnv): string[] {
  return (env.RELOAD_KNOWN_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0 && MODEL_ID_RE.test(m));
}

/**
 * The full set of models considered launchable in this deployment: the curated {@link KNOWN_AGENT_MODELS}
 * plus any `RELOAD_KNOWN_MODELS` additions. Surfaced (sorted) to the owner model picker so it offers only
 * models that will actually resolve.
 */
export function knownModels(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...new Set([...KNOWN_AGENT_MODELS, ...extraKnownModels(env)])];
}

/** Whether a model id is known to resolve (curated list or the env escape hatch). */
export function isKnownModel(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return knownModels(env).includes(model.trim());
}

/**
 * Thrown when a configured model is not launchable (unknown / unservable). Owner-actionable and
 * content-free beyond the model id (which is the owner's own non-secret config value, not a credential),
 * so it is safe to surface in a channel message or map to an HTTP 400 — never a generic mid-run crash.
 */
export class ModelUnavailableError extends Error {
  constructor(readonly model: string) {
    super(`model "${model}" is unavailable on your plan — pick a valid model in Settings → Connect Claude`);
    this.name = "ModelUnavailableError";
  }
}

/**
 * Resolve the EFFECTIVE model for a launch, applying precedence: an explicit per-session pin (#52
 * `ANTHROPIC_MODEL` in `harnessEnv`) wins, else the workspace's owner-picked model, else the deployment
 * env default (`ANTHROPIC_MODEL`), else the canonical {@link DEFAULT_AGENT_MODEL}. Pure; trims/ignores
 * blank values so an empty picker/env never wins over a real default.
 */
export function effectiveModel(input: {
  sessionPinned?: string | null;
  workspacePicked?: string | null;
  envDefault?: string | null;
}): string {
  const pick = (v: string | null | undefined): string | null => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : null;
  };
  return pick(input.sessionPinned) ?? pick(input.workspacePicked) ?? pick(input.envDefault) ?? DEFAULT_AGENT_MODEL;
}

/**
 * Launch/config-save preflight: assert a model is launchable, else throw {@link ModelUnavailableError}.
 * Pure + total (no network, no spend) — the deterministic guard that makes `claude-fable-5` (and any
 * other unservable id) fail fast with an actionable owner error instead of a mid-run "error · exit 1".
 */
export function assertModelLaunchable(model: string, env: NodeJS.ProcessEnv = process.env): void {
  const m = (model ?? "").trim();
  if (!m || !MODEL_ID_RE.test(m) || !isKnownModel(m, env)) {
    throw new ModelUnavailableError(model);
  }
}
