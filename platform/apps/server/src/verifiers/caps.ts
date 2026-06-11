import type { VerifierConfig } from "../config/schema.js";

/**
 * Resolve the verifier policy from the layered config (#58), applying hard defaults — mirrors
 * `sre/caps.ts` / `flywheel/caps.ts`. Outcome Verifiers are **default OFF** (`enabled: false`): a
 * deployment that sets no `verifiers` section runs no verification and the background tick is also
 * default-off (`VERIFIERS_INTERVAL_MS = 0`).
 */
export interface VerifierCaps {
  /** The verifier loop flag. OFF by default. */
  enabled: boolean;
  /** Whether a measured FAILURE opens a #13 escalation (default true — the "no silent pass" rail). */
  escalateOnFailure: boolean;
  /** Hard cap on verifications performed in a single workspace tick (bounds work + escalations). */
  maxPerTick: number;
}

export const VERIFIER_DEFAULTS: VerifierCaps = {
  enabled: false,
  escalateOnFailure: true, // a failed outcome must surface — never silently pass
  maxPerTick: 25,
};

export function resolveVerifierCaps(cfg: VerifierConfig | undefined): VerifierCaps {
  return {
    enabled: cfg?.enabled ?? VERIFIER_DEFAULTS.enabled,
    escalateOnFailure: cfg?.escalateOnFailure ?? VERIFIER_DEFAULTS.escalateOnFailure,
    maxPerTick: cfg?.maxPerTick ?? VERIFIER_DEFAULTS.maxPerTick,
  };
}
