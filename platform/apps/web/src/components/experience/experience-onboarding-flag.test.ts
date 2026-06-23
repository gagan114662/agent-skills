import { describe, expect, it } from "vitest";
import { shouldShowExperienceOnboarding, type ExperienceOnboardingGateInput } from "./experience-onboarding-flag.js";

const owner = "ws_owner_784";
const on: ExperienceOnboardingGateInput = { flagOn: true, ownerWorkspaceId: owner, workspaceId: owner };

describe("shouldShowExperienceOnboarding (#784)", () => {
  it("shows only for the named owner workspace when the flag is on", () => {
    expect(shouldShowExperienceOnboarding(on)).toBe(true);
  });

  it("is default-off even for the named owner", () => {
    expect(shouldShowExperienceOnboarding({ ...on, flagOn: false })).toBe(false);
  });

  it("fails closed when the owner or current workspace is missing", () => {
    expect(shouldShowExperienceOnboarding({ flagOn: true, ownerWorkspaceId: "", workspaceId: owner })).toBe(false);
    expect(shouldShowExperienceOnboarding({ flagOn: true, ownerWorkspaceId: "  ", workspaceId: owner })).toBe(false);
    expect(shouldShowExperienceOnboarding({ flagOn: true, ownerWorkspaceId: owner, workspaceId: "" })).toBe(false);
    expect(shouldShowExperienceOnboarding({ flagOn: true, ownerWorkspaceId: owner, workspaceId: undefined })).toBe(false);
  });

  it("hides from non-owner workspaces and trims ids before matching", () => {
    expect(shouldShowExperienceOnboarding({ ...on, workspaceId: "ws_other" })).toBe(false);
    expect(shouldShowExperienceOnboarding({ flagOn: true, ownerWorkspaceId: ` ${owner} `, workspaceId: `${owner} ` })).toBe(
      true,
    );
  });
});
