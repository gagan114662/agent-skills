import { describe, it, expect } from "vitest";
import {
  resolveStandupDigestCaps,
  STANDUP_DIGEST_DEFAULTS,
} from "../../src/standup-digest/caps.js";

/**
 * Unit tests for the env-only, default-OFF config (#589). Pure given an injected `env` — no process.env reads.
 */

describe("resolveStandupDigestCaps", () => {
  it("defaults to OFF with the default per-section cap when nothing is set", () => {
    const caps = resolveStandupDigestCaps({});
    expect(caps.enabled).toBe(false);
    expect(caps.maxItemsPerSection).toBe(STANDUP_DIGEST_DEFAULTS.maxItemsPerSection);
  });

  it("parses truthy enable flags case-insensitively", () => {
    for (const v of ["1", "true", "TRUE", "yes", "On"]) {
      expect(resolveStandupDigestCaps({ STANDUP_DIGEST_ENABLED: v }).enabled).toBe(true);
    }
  });

  it("treats anything else as OFF", () => {
    for (const v of ["0", "false", "no", "off", "", "maybe"]) {
      expect(resolveStandupDigestCaps({ STANDUP_DIGEST_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("parses a positive item cap and floors it at 1", () => {
    expect(resolveStandupDigestCaps({ STANDUP_DIGEST_MAX_ITEMS_PER_SECTION: "10" }).maxItemsPerSection).toBe(10);
    expect(resolveStandupDigestCaps({ STANDUP_DIGEST_MAX_ITEMS_PER_SECTION: "0" }).maxItemsPerSection).toBe(1);
    expect(resolveStandupDigestCaps({ STANDUP_DIGEST_MAX_ITEMS_PER_SECTION: "-5" }).maxItemsPerSection).toBe(1);
  });

  it("keeps the default for invalid item caps", () => {
    expect(resolveStandupDigestCaps({ STANDUP_DIGEST_MAX_ITEMS_PER_SECTION: "abc" }).maxItemsPerSection).toBe(
      STANDUP_DIGEST_DEFAULTS.maxItemsPerSection,
    );
  });
});
