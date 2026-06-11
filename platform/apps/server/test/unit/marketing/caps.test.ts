import { describe, it, expect } from "vitest";
import { resolveMarketingCaps, MARKETING_DEFAULTS } from "../../../src/marketing/caps.js";

/**
 * #123 marketing caps — mirrors the venture/watchdog default-OFF pattern (#58). A deployment that sets
 * no `marketing` section keeps today's signup behavior (no auto-seed); ipop.ai opts in via the managed
 * layer.
 */
describe("#123 marketing caps", () => {
  it("defaults OFF for seed-on-signup, with welcome tasks on", () => {
    expect(MARKETING_DEFAULTS.enabled).toBe(false);
    expect(resolveMarketingCaps(undefined)).toEqual({ enabled: false, seedWelcomeTasks: true });
    expect(resolveMarketingCaps({})).toEqual({ enabled: false, seedWelcomeTasks: true });
  });

  it("honours an explicit opt-in and lets welcome tasks be turned off", () => {
    expect(resolveMarketingCaps({ enabled: true })).toEqual({ enabled: true, seedWelcomeTasks: true });
    expect(resolveMarketingCaps({ enabled: true, seedWelcomeTasks: false })).toEqual({
      enabled: true,
      seedWelcomeTasks: false,
    });
  });
});
