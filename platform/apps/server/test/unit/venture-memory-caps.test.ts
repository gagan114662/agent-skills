import { describe, it, expect } from "vitest";
import {
  resolveVentureMemoryCaps,
  VENTURE_MEMORY_DEFAULTS,
} from "../../src/venture-memory/caps.js";

describe("resolveVentureMemoryCaps: default-OFF with hard defaults", () => {
  it("an absent config block resolves to the defaults (weekly tick OFF)", () => {
    expect(resolveVentureMemoryCaps(undefined)).toEqual(VENTURE_MEMORY_DEFAULTS);
    expect(VENTURE_MEMORY_DEFAULTS.enabled).toBe(false);
  });

  it("an empty config block stays OFF", () => {
    expect(resolveVentureMemoryCaps({}).enabled).toBe(false);
  });

  it("explicit knobs override the defaults", () => {
    const caps = resolveVentureMemoryCaps({
      enabled: true,
      maxPlanItems: 9,
      staleAfterDays: 10,
      maxBriefPerKind: 2,
      maxPlaybookCandidates: 1,
      dispatchOnApprove: false,
    });
    expect(caps).toEqual({
      enabled: true,
      maxPlanItems: 9,
      staleAfterDays: 10,
      maxBriefPerKind: 2,
      maxPlaybookCandidates: 1,
      dispatchOnApprove: false,
    });
  });
});
