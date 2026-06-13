import type { VerificationConfig } from "../config/schema.js";

/**
 * Resolve the deliverable verification policy from the layered config (#58), applying hard defaults —
 * mirrors `verifiers/caps.ts` / `voice/caps.ts`. The layer is **default OFF** (`enabled: false`): a
 * deployment that sets no `verification` section verifies nothing and behaves exactly as today.
 *
 * The conservative rails are the point of the premortem (#200): a verified deliverable still waits for a
 * human (`autoSendReversible: false`), and the production-grounded final tier is required where it
 * applies (`requireProductionGrounding: true`). An operator opts into auto-send per workspace, owner
 * workspace first.
 */
export interface VerificationCaps {
  /** The verification layer flag. OFF by default — nothing is gated until a deployment opts in. */
  enabled: boolean;
  /** The confidence a passing verdict needs to clear without a human second look (0..1). */
  minConfidence: number;
  /** Bounded fail→fix retries before a repeated failure escalates to the decision queue (#191 AC #3). */
  maxRetries: number;
  /**
   * Whether a verified REVERSIBLE deliverable may auto-proceed without a human. OFF by default — a pass
   * still opens an approval card. Even ON, `cheap` and `irreversible` deliverables never auto-proceed.
   */
  autoSendReversible: boolean;
  /**
   * Whether the production-grounded tier (premortem #3 — real spawn / click-through / canary) is REQUIRED
   * for venture deploys / irreversible deliverables / production criteria. ON by default.
   */
  requireProductionGrounding: boolean;
}

export const VERIFICATION_DEFAULTS: VerificationCaps = {
  enabled: false,
  minConfidence: 0.8,
  maxRetries: 2,
  autoSendReversible: false, // a verified deliverable still waits for a human until opted in
  requireProductionGrounding: true, // the premortem #3 final tier is required where it applies
};

export function resolveVerificationCaps(cfg: VerificationConfig | undefined): VerificationCaps {
  return {
    enabled: cfg?.enabled ?? VERIFICATION_DEFAULTS.enabled,
    minConfidence: cfg?.minConfidence ?? VERIFICATION_DEFAULTS.minConfidence,
    maxRetries: cfg?.maxRetries ?? VERIFICATION_DEFAULTS.maxRetries,
    autoSendReversible: cfg?.autoSendReversible ?? VERIFICATION_DEFAULTS.autoSendReversible,
    requireProductionGrounding:
      cfg?.requireProductionGrounding ?? VERIFICATION_DEFAULTS.requireProductionGrounding,
  };
}
