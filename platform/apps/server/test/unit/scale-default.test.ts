import { describe, expect, it } from "vitest";
import { resolveGlobalConcurrencyCap } from "../../src/scale/default.js";

describe("scale/default global concurrency (#682)", () => {
  it("uses the existing TEAM_MAX_CONCURRENCY fallback when managed config has no global cap", () => {
    expect(resolveGlobalConcurrencyCap(undefined, 3)).toBe(3);
    expect(resolveGlobalConcurrencyCap(0, 3)).toBe(3);
  });

  it("lets a managed global cap override the env fallback", () => {
    expect(resolveGlobalConcurrencyCap(8, 3)).toBe(8);
  });

  it("still supports unlimited when both sources are unset", () => {
    expect(resolveGlobalConcurrencyCap(undefined, 0)).toBe(0);
  });
});
