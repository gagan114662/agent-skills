import type { LegalConfig } from "../config/schema.js";

/**
 * Resolve the Legal & Compliance pack policy from the layered config (#58), applying hard defaults —
 * mirrors `voice/caps.ts`. The pack is **default OFF** (`enabled: false`): a deployment that sets no
 * `legal` section keeps today's behavior end-to-end — no send is blocked at the chokepoint (the
 * `ComplianceEnforcer` is a no-op), no document is auto-regenerated, no naming pre-check runs. The owner
 * workspace opts in first (the risky capability — blocking real sends + auto-regen — stays gated).
 *
 * Note: even with the pack on, every *publish* and every *reply/send* remains the #13 human gate
 * regardless; `enabled` gates the *additional* compliance enforcement, never loosens an existing gate.
 */
export interface LegalCaps {
  /** Master switch for the pack. OFF by default. When off the ComplianceEnforcer is a no-op. */
  enabled: boolean;
  /** When on, a material change (facts-hash drift) regenerates docs + opens an owner-review approval.
   * OFF by default (regeneration only runs on explicit request). */
  autoRegenerate: boolean;
  /** Require a recorded consent basis for a commercial `email.send` (CASL/GDPR). On by default — but it
   * only bites when the pack itself is `enabled`. */
  requireConsentForEmail: boolean;
}

export const LEGAL_DEFAULTS: LegalCaps = {
  enabled: false,
  autoRegenerate: false,
  requireConsentForEmail: true,
};

export function resolveLegalCaps(cfg: LegalConfig | undefined): LegalCaps {
  return {
    enabled: cfg?.enabled ?? LEGAL_DEFAULTS.enabled,
    autoRegenerate: cfg?.autoRegenerate ?? LEGAL_DEFAULTS.autoRegenerate,
    requireConsentForEmail: cfg?.requireConsentForEmail ?? LEGAL_DEFAULTS.requireConsentForEmail,
  };
}
