import { describe, expect, it } from "vitest";
import { experienceTokenStyle, ipopExperienceTokens } from "./ipop-experience-tokens.js";

describe("ipopExperienceTokens (#1068)", () => {
  it("defines the shared canvas / surface / accent roles and serif / sans families", () => {
    expect(ipopExperienceTokens.color.canvas).toBe("#0f0f12");
    expect(ipopExperienceTokens.color.surface).toBe("#17171c");
    expect(ipopExperienceTokens.color.accent).toBe("#ff5470");
    expect(ipopExperienceTokens.typography.serif).toContain("Instrument Serif");
    expect(ipopExperienceTokens.typography.sans).toContain("Inter");
  });

  it("maps onboarding and everyday shells to the same token values with surface-local variables", () => {
    const onboarding = experienceTokenStyle("onboarding");
    const everyday = experienceTokenStyle("everyday");

    expect(onboarding["--o-canvas" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.color.canvas,
    );
    expect(everyday["--ed-canvas" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.color.canvas,
    );
    expect(onboarding["--o-surface" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.color.surface,
    );
    expect(everyday["--ed-surface" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.color.surface,
    );
    expect(onboarding["--o-pop" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.color.accent,
    );
    expect(onboarding["--o-pop-ink" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.color.onAccent,
    );
    expect(everyday["--ed-pop" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.color.accent,
    );
    expect(everyday["--ed-on-pop" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.color.onAccent,
    );
    expect(onboarding["--o-serif" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.typography.serif,
    );
    expect(everyday["--ed-serif" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.typography.serif,
    );
    expect(onboarding["--o-sans" as keyof typeof onboarding]).toBe(
      ipopExperienceTokens.typography.sans,
    );
    expect(everyday["--ed-sans" as keyof typeof everyday]).toBe(
      ipopExperienceTokens.typography.sans,
    );
  });
});
