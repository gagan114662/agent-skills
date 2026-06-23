import { describe, expect, it } from "vitest";
import { shouldShowOnboardingV2 } from "./onboarding-flag.js";

/**
 * #784 onboarding gate — PURE and fail-closed: only an explicitly-on flag reveals the new experience, so an
 * unset/false env can never expose it. (The env→boolean coercion is exercised by the env at import time; the
 * decision logic is what we unit-test here.)
 */
describe("shouldShowOnboardingV2 (#784)", () => {
  it("is OFF by default (flag off ⇒ surface hidden)", () => {
    expect(shouldShowOnboardingV2({ flagOn: false })).toBe(false);
  });

  it("shows only when the flag is explicitly on", () => {
    expect(shouldShowOnboardingV2({ flagOn: true })).toBe(true);
  });
});
