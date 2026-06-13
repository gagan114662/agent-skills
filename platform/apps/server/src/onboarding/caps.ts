import type { OnboardingConfig } from "../config/schema.js";

/**
 * Resolve the external-account-onboarding policy from the layered config (#58), applying hard defaults —
 * mirrors `founder-briefings/caps.ts`. **Default OFF** (`enabled: false`): a deployment that sets no
 * `onboarding` block keeps today's behavior — the read routes still render the (empty) checklist, but the
 * `ExternalSecretsResolver` injects nothing and the risky write routes (connect / DNS configure) 409.
 * `enabled` is the master switch for credential injection + those writes; the owner workspace opts in
 * first via `RELOAD_ONBOARDING_ENABLED`.
 */
export interface OnboardingCaps {
  /** Master flag for credential injection + the connect/DNS writes. OFF by default. */
  enabled: boolean;
  /** Default rotation-reminder age (days) applied when a connect doesn't specify one. 0 = no reminder. */
  defaultRotationDays: number;
  /** The DNS provider kind the factory selects (`dryrun` default — no network). */
  dnsProvider: string;
}

export const ONBOARDING_DEFAULTS: OnboardingCaps = {
  enabled: false,
  defaultRotationDays: 0,
  dnsProvider: "dryrun",
};

export function resolveOnboardingCaps(cfg: OnboardingConfig | undefined): OnboardingCaps {
  return {
    enabled: cfg?.enabled ?? ONBOARDING_DEFAULTS.enabled,
    defaultRotationDays: cfg?.defaultRotationDays ?? ONBOARDING_DEFAULTS.defaultRotationDays,
    dnsProvider: cfg?.dnsProvider ?? ONBOARDING_DEFAULTS.dnsProvider,
  };
}
