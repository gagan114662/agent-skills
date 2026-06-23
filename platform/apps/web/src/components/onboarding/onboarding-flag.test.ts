import { describe, expect, it } from "vitest";
import { shouldShowOnboardingV2 } from "./onboarding-flag.js";

/**
 * #784 onboarding gate — PURE pass-through of the master flag. #784 go-live makes the flag DEFAULT-ON (the
 * env→boolean coercion in ONBOARDING_V2_ENABLED is on unless "false"/"0"); the decision logic here just
 * honours that flag: on ⇒ the new experience is the public landing, off ⇒ the marketing landing returns.
 */
describe("shouldShowOnboardingV2 (#784)", () => {
  it("hides only when the flag is explicitly off (the one reversal env)", () => {
    expect(shouldShowOnboardingV2({ flagOn: false })).toBe(false);
  });

  it("shows when the flag is on — the default-on production landing", () => {
    expect(shouldShowOnboardingV2({ flagOn: true })).toBe(true);
  });
});
