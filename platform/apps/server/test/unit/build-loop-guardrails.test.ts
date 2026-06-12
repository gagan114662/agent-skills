import { describe, it, expect } from "vitest";
import {
  DEFAULT_PROTECTED_PATHS,
  matchesGlob,
  isProtectedPath,
  protectedPathsTouched,
  diffWithinSizeCap,
  buildCapacityAvailable,
  reviewRoundsExhausted,
} from "../../src/build-loop/guardrails.js";
import { resolveBuildLoopCaps, BUILDLOOP_DEFAULTS } from "../../src/build-loop/caps.js";

describe("matchesGlob (#172 protected-path matcher)", () => {
  it("matches a leading double-star (suffix) pattern", () => {
    expect(matchesGlob("apps/server/src/billing/stripe.ts", "**/billing/**")).toBe(true);
    expect(matchesGlob("apps/server/src/run/preview.ts", "**/billing/**")).toBe(false);
  });

  it("matches a single-star wildcard within a segment only (not across slashes)", () => {
    expect(matchesGlob("a/secret-key.ts", "**/*secret*")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "a/*/c.ts")).toBe(true);
    expect(matchesGlob("a/b/d/c.ts", "a/*/c.ts")).toBe(false);
  });

  it("matches an exact path pattern", () => {
    expect(matchesGlob("apps/server/src/config/layers.ts", "**/config/layers.ts")).toBe(true);
    expect(matchesGlob("apps/server/src/config/loader.ts", "**/config/layers.ts")).toBe(false);
  });

  it("never throws on a hostile pattern — just fails to match", () => {
    expect(matchesGlob("a/b.ts", "[unclosed")).toBe(false);
  });
});

describe("isProtectedPath / protectedPathsTouched (the gates-intact trigger)", () => {
  it("flags approval, billing, auth, crypto, secret, and config-layer paths by default", () => {
    for (const p of [
      "apps/server/src/approvals/policy.ts",
      "apps/server/src/billing/provider.ts",
      "apps/server/src/auth/guard.ts",
      "apps/server/src/crypto/secretbox.ts",
      "apps/server/src/config/layers.ts",
      "apps/server/src/db/repositories/agent-credentials.ts",
    ]) {
      expect(isProtectedPath(p, DEFAULT_PROTECTED_PATHS)).toBe(true);
    }
  });

  it("does not flag ordinary feature paths", () => {
    expect(isProtectedPath("apps/server/src/build-loop/engine.ts", DEFAULT_PROTECTED_PATHS)).toBe(false);
  });

  it("returns exactly the touched protected files for the escalation evidence", () => {
    const files = [
      "apps/server/src/build-loop/engine.ts",
      "apps/server/src/billing/provider.ts",
      "apps/server/README.md",
    ];
    expect(protectedPathsTouched(files, DEFAULT_PROTECTED_PATHS)).toEqual([
      "apps/server/src/billing/provider.ts",
    ]);
  });
});

describe("diffWithinSizeCap", () => {
  it("respects both axes, with 0 meaning no cap on that axis", () => {
    expect(diffWithinSizeCap(10, 100, 50, 1500)).toBe(true);
    expect(diffWithinSizeCap(60, 100, 50, 1500)).toBe(false); // too many files
    expect(diffWithinSizeCap(10, 2000, 50, 1500)).toBe(false); // too many lines
    expect(diffWithinSizeCap(999, 99999, 0, 0)).toBe(true); // no caps
  });
});

describe("buildCapacityAvailable / reviewRoundsExhausted", () => {
  it("0 concurrency never dispatches; otherwise headroom is in-flight < cap", () => {
    expect(buildCapacityAvailable(0, 0)).toBe(false);
    expect(buildCapacityAvailable(0, 1)).toBe(true);
    expect(buildCapacityAvailable(1, 1)).toBe(false);
  });

  it("rounds are exhausted once they reach the cap", () => {
    expect(reviewRoundsExhausted(2, 3)).toBe(false);
    expect(reviewRoundsExhausted(3, 3)).toBe(true);
    expect(reviewRoundsExhausted(4, 3)).toBe(true);
  });
});

describe("resolveBuildLoopCaps (#172 default OFF)", () => {
  it("defaults to OFF with the built-in guardrail bounds + protected paths", () => {
    const caps = resolveBuildLoopCaps(undefined);
    expect(caps.enabled).toBe(false);
    expect(caps.maxConcurrentBuilds).toBe(BUILDLOOP_DEFAULTS.maxConcurrentBuilds);
    expect(caps.protectedPaths).toEqual(DEFAULT_PROTECTED_PATHS);
  });

  it("a config layer overrides individual knobs and replaces the protected-path list when set", () => {
    const caps = resolveBuildLoopCaps({
      enabled: true,
      maxConcurrentBuilds: 3,
      maxReviewRounds: 5,
      maxDiffFiles: 10,
      maxDiffLines: 200,
      protectedPaths: ["**/danger/**"],
    });
    expect(caps.enabled).toBe(true);
    expect(caps.maxConcurrentBuilds).toBe(3);
    expect(caps.maxReviewRounds).toBe(5);
    expect(caps.protectedPaths).toEqual(["**/danger/**"]);
  });
});
