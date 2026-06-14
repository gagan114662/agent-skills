import type { DecisionMakerConfig } from "../config/schema.js";
import { MAX_HOOKS } from "./brief.js";

/**
 * Resolve the decision-maker resolver policy from the layered config (#58), applying hard defaults —
 * mirrors `growth/caps.ts` / `venture/caps.ts`. The resolver is **default OFF** (`enabled: false`): the
 * flag gates the proactive, LIVE web-reading posture (the quarantined #174 browser fetching profiles).
 *
 * Producing a brief on demand from sources the discovery layer (#222) already fetched is harmless and
 * always available — the same way #102 keeps event ingest always-on while gating the proactive growth
 * posture. `maxHooks` is clamped into `[1, MAX_HOOKS]` so config can only narrow the video's "2–3 hooks".
 */
export interface DecisionMakerCaps {
  /** The proactive/live-reading flag. OFF by default. */
  enabled: boolean;
  /** Max angle hooks on a brief (clamped to `[1, MAX_HOOKS]`). */
  maxHooks: number;
}

export const DECISION_MAKER_DEFAULTS: DecisionMakerCaps = {
  enabled: false,
  maxHooks: MAX_HOOKS,
};

export function resolveDecisionMakerCaps(
  cfg: DecisionMakerConfig | undefined,
): DecisionMakerCaps {
  const requested = cfg?.maxHooks ?? DECISION_MAKER_DEFAULTS.maxHooks;
  return {
    enabled: cfg?.enabled ?? DECISION_MAKER_DEFAULTS.enabled,
    maxHooks: Math.max(1, Math.min(MAX_HOOKS, Math.trunc(requested))),
  };
}
