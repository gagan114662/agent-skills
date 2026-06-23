/**
 * First-run onboarding experience flag (#784) — a PURE, default-OFF gate for the new "experience system"
 * onboarding surface (the warm Instrument-Serif door → fleet reads your site → guided Cowork-style connects,
 * each immediately paid off with a real result → one approved deliverable that ships).
 *
 * Why a flag: the redesign is a whole new visual + voice system (near-black canvas, one coral pop, lowercase
 * Innocent voice) that lives ALONGSIDE the existing light console while we iterate it against screenshots and
 * verify on ipop.ai. Default-OFF means the env-unset deployment renders nobody the new surface — the existing
 * `/start` onboarding (#260/#633) is untouched. This module flips nothing in production.
 *
 * #784 GO-LIVE: this is now the production default landing, so the gate is DEFAULT-ON:
 *   · DEFAULT-ON   — env unset ⇒ flag on ⇒ root `/` and `/welcome` open the new experience for everyone.
 *   · EXPLICIT-OFF — only the literal "false"/"0" turns it off (restoring the marketing landing); any other
 *                    value (including typos) leaves it on. Reversible with a single env var, no code change.
 */

const env = import.meta.env;

/** Read a string env value, coercing away non-strings/empties. */
function readEnv(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** Master switch — `VITE_RELOAD_ONBOARDING_V2`. Default ON; only "false"/"0" turns it off (#784 go-live). */
export const ONBOARDING_V2_ENABLED: boolean = (() => {
  const raw = readEnv(env.VITE_RELOAD_ONBOARDING_V2);
  return raw !== "false" && raw !== "0";
})();

export interface OnboardingGateInput {
  /** The master flag (default OFF). */
  readonly flagOn: boolean;
}

/**
 * Decide whether the new onboarding experience shows. PURE so every branch is unit-tested without a DOM.
 * Fail-closed: an off (or unset) flag never reveals the surface.
 */
export function shouldShowOnboardingV2(input: OnboardingGateInput): boolean {
  return input.flagOn === true;
}
