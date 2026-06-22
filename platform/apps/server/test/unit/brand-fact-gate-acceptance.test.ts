/**
 * Acceptance test for issue #627. The literal acceptance criterion:
 *
 *   "content failing brand or fact checks is blocked from publishing and routed back for revision."
 *
 * These tests drive the public barrel exactly as a publisher would — gating a draft against the campaign
 * brief (#588) before any outbound/public action — and assert that off-brand or unsourced content is NEVER
 * `allowed`, always carries revision notes, and that only clean, sourced, on-brand content clears the gate.
 */

import { describe, it, expect } from "vitest";
import {
  gatePublishForBrief,
  profileFromBrief,
  MAX_DERIVED_BANNED_PHRASES,
  type BrandContext,
} from "../../src/brand-fact-gate/index.js";

/** A representative campaign brief (#588 shape) the gate reads as brand context. */
const BRIEF: BrandContext = {
  voice: "Calm, precise, no hype. Speak like an engineer, not a billboard.",
  constraints: ['never say "guaranteed results"', "no competitor names"],
  brandClaims: ["the only SOC 2 Type II compliant helpdesk for startups"],
};

/** Drafts that must be blocked and routed back for revision. */
const FAILING_DRAFTS: Array<{ name: string; content: string }> = [
  {
    name: "off-brand hype + shouting",
    content: "Our REVOLUTIONARY, MIND-BLOWING platform is a total game-changer!!!",
  },
  {
    name: "clickbait",
    content: "You won't believe the secret to closing more deals.",
  },
  {
    name: "unsourced statistic",
    content: "Teams using us resolve tickets 3x faster and cut costs by 45%.",
  },
  {
    name: "unsourced research appeal",
    content: "Studies show our customers are happier than everyone else's.",
  },
  {
    name: "brief-banned phrase",
    content: "Switch today and get guaranteed results within a week.",
  },
];

describe("issue #627 acceptance — failing content is blocked and routed back for revision", () => {
  for (const { name, content } of FAILING_DRAFTS) {
    it(`[${name}] is blocked, never allowed, and carries revision notes`, () => {
      const d = gatePublishForBrief(content, BRIEF, {});
      expect(d.allowed).toBe(false);
      expect(d.outcome).toBe("revise");
      expect(d.failed.length).toBeGreaterThan(0);
      expect(d.revisionNotes.length).toBeGreaterThan(0);
      expect(d.summary.toLowerCase()).toContain("revision");
    });
  }

  it("a clean, on-brand, sourced draft clears the gate", () => {
    const content =
      "Acme is the only SOC 2 Type II compliant helpdesk for startups. " +
      "Teams cut first-response time by 30% in their first quarter, per our 2025 benchmark [1].";
    const d = gatePublishForBrief(content, BRIEF, {});
    expect(d.allowed).toBe(true);
    expect(d.outcome).toBe("pass");
    expect(d.revisionNotes).toEqual([]);
  });

  it("a brand-approved claim needs no external citation; the same claim unapproved would be blocked", () => {
    const content = "We are the only SOC 2 Type II compliant helpdesk for startups.";
    expect(gatePublishForBrief(content, BRIEF, {}).allowed).toBe(true);
    // With no brief (the runaway-session scenario) the very same superlative is an unsourced claim → blocked.
    expect(gatePublishForBrief(content, null, {}).allowed).toBe(false);
  });

  it("an unconfigured workspace (null brief) still enforces the built-in off-brand + source guards", () => {
    const d = gatePublishForBrief("This game-changer delivers 10x ROI, guaranteed!!!", null, {});
    expect(d.allowed).toBe(false);
    expect(d.failed).toContain("voice");
  });
});

describe("profileFromBrief — derives enforceable banned phrases from brief constraints (#588 linkage)", () => {
  it("extracts quoted phrases and negative-constraint tails", () => {
    const profile = profileFromBrief(BRIEF);
    expect(profile.bannedPhrases).toContain("guaranteed results");
    expect(profile.bannedPhrases).toContain("competitor names");
  });

  it("returns an empty profile for a null/undefined brief", () => {
    expect(profileFromBrief(null).bannedPhrases).toEqual([]);
    expect(profileFromBrief(undefined).bannedPhrases).toEqual([]);
  });

  it("caps the number of derived banned phrases", () => {
    const many: BrandContext = {
      constraints: Array.from({ length: 100 }, (_, i) => `no banned phrase number ${i}`),
    };
    expect(profileFromBrief(many).bannedPhrases.length).toBeLessThanOrEqual(MAX_DERIVED_BANNED_PHRASES);
  });
});
