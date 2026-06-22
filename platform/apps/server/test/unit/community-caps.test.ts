/**
 * Unit tests for the community agent's env-driven config (#597): default-OFF, credential parsing, and the
 * fail-closed clamping of the anti-spam policy knobs.
 */

import { describe, it, expect } from "vitest";
import {
  ANTI_SPAM_DEFAULTS,
  COMMUNITY_DEFAULTS,
  resolveAntiSpamPolicy,
  resolveCommunityCaps,
} from "../../src/community/caps.js";

describe("resolveCommunityCaps (#597)", () => {
  it("defaults to OFF with no credentials and the conservative policy", () => {
    const caps = resolveCommunityCaps({});
    expect(caps.enabled).toBe(false);
    expect(caps.credentials).toEqual({ reddit: null, slack: null, discord: null });
    expect(caps.policy).toEqual(ANTI_SPAM_DEFAULTS);
    expect(COMMUNITY_DEFAULTS.enabled).toBe(false);
  });

  it("parses the master switch case-insensitively", () => {
    for (const v of ["1", "true", "YES", "On"]) {
      expect(resolveCommunityCaps({ COMMUNITY_PARTICIPATION_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["0", "false", "", "nope"]) {
      expect(resolveCommunityCaps({ COMMUNITY_PARTICIPATION_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("treats a whitespace-only token as absent", () => {
    const caps = resolveCommunityCaps({ COMMUNITY_REDDIT_TOKEN: "   ", COMMUNITY_SLACK_TOKEN: "tok" });
    expect(caps.credentials.reddit).toBeNull();
    expect(caps.credentials.slack).toBe("tok");
  });
});

describe("resolveAntiSpamPolicy (#597)", () => {
  it("clamps out-of-range and garbage knobs to safe values (fail-closed)", () => {
    const p = resolveAntiSpamPolicy({
      COMMUNITY_MAX_PROMO_RATIO: "5", // > 1 ⇒ clamps to 1
      COMMUNITY_MIN_RELEVANCE: "-2", // < 0 ⇒ clamps to 0
      COMMUNITY_MAX_REPLIES_PER_WINDOW: "not-a-number", // ⇒ default
    });
    expect(p.maxPromoRatio).toBe(1);
    expect(p.minRelevance).toBe(0);
    expect(p.maxRepliesPerWindow).toBe(ANTI_SPAM_DEFAULTS.maxRepliesPerWindow);
  });

  it("reads valid overrides verbatim", () => {
    const p = resolveAntiSpamPolicy({
      COMMUNITY_MIN_RELEVANCE: "0.5",
      COMMUNITY_MAX_REPLIES_PER_WINDOW: "2",
      COMMUNITY_MIN_HOURS_BETWEEN_REPLIES: "12",
    });
    expect(p.minRelevance).toBe(0.5);
    expect(p.maxRepliesPerWindow).toBe(2);
    expect(p.minHoursBetweenReplies).toBe(12);
  });
});
