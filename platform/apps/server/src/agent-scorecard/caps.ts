/**
 * Configuration for the per-agent performance scorecard (issue #593). Deliberately **self-contained**: every
 * tunable is read straight from the process environment, so this feature adds NO edit to the shared
 * `config/schema.ts` barrel and stays free of parallel-merge conflicts with sibling branches (the proven
 * #611/#670/#741 pattern).
 *
 * Default-OFF, owner-workspace-first rollout, defense in depth:
 *   - `enabled` (default false) + `ownerWorkspaceOnly` (default true): the scorecard rolls out owner-workspace-
 *     first, exactly like `avatar-studio`/`ads`. A deployment that sets nothing offers no scorecard at all.
 *   - The data SOURCE seam itself defaults to the deterministic FAKE source (see `source.ts`): even when enabled,
 *     NO external system is queried until a deployment also wires a live source. "No external calls until
 *     enabled" holds end to end.
 *
 * The model weights / ranking math are NOT env-tunable — they are governed constants in `score.ts` (a retune is a
 * code review, not a deploy knob). What IS tunable here is enablement and the pipeline blend weight used when
 * ranking by influence.
 *
 * Pure given its `env` argument ⇒ unit-testable; the IO (Postgres) lives in `default.ts`.
 */

import { DEFAULT_PIPELINE_WEIGHT } from "./score.js";

export interface ScorecardCaps {
  /** Master flag for the scorecard. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, the scorecard is offered ONLY for `ownerWorkspaceId`;
   * set false to broaden to all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the scorecard dogfoods here first, or null. */
  ownerWorkspaceId: string | null;
  /** Weight applied to pipeline USD when blending into the influence score (0–1). */
  pipelineWeight: number;
}

export const SCORECARD_DEFAULTS: ScorecardCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: null,
  pipelineWeight: DEFAULT_PIPELINE_WEIGHT,
};

/** Parse a boolean env flag: only an explicit truthy token enables it; anything else (incl. missing) ⇒ fallback. */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return fallback;
}

/** Trim an optional env string to a non-empty value, or null. */
function parseOptional(raw: string | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Parse a 0–1 weight; out-of-range / invalid falls back to the default. */
function parseWeight(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat((raw ?? "").trim());
  if (!Number.isFinite(n) || n < 0 || n > 1) return fallback;
  return n;
}

/** Resolve the caps from the environment (defaults applied). Pure given its `env` argument. */
export function resolveScorecardCaps(env: NodeJS.ProcessEnv = process.env): ScorecardCaps {
  return {
    enabled: parseBool(env.AGENT_SCORECARD_ENABLED, SCORECARD_DEFAULTS.enabled),
    ownerWorkspaceOnly: parseBool(
      env.AGENT_SCORECARD_OWNER_WORKSPACE_ONLY,
      SCORECARD_DEFAULTS.ownerWorkspaceOnly,
    ),
    ownerWorkspaceId: parseOptional(env.AGENT_SCORECARD_OWNER_WORKSPACE_ID),
    pipelineWeight: parseWeight(env.AGENT_SCORECARD_PIPELINE_WEIGHT, SCORECARD_DEFAULTS.pipelineWeight),
  };
}

/**
 * Pure + total + fail-closed: is the scorecard in scope for this workspace? Disabled ⇒ never; owner-first ⇒ ONLY
 * the configured owner workspace (so an unset `ownerWorkspaceId` lets nobody in, never everybody — the safest
 * default, matching `avatar-studio`/`ads`).
 */
export function isScorecardEnabledForWorkspace(caps: ScorecardCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== null && caps.ownerWorkspaceId === workspaceId;
}
