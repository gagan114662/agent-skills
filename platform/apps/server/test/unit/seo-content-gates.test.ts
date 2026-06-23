/**
 * Unit tests for the pure, fail-closed stage gates (#598): keyword relevance + validation, brief completeness,
 * and the draft brand + fact check that catches junk drafts.
 */

import { describe, it, expect } from "vitest";
import { GATE_POLICY_DEFAULTS, type GatePolicy } from "../../src/seo-content/caps.js";
import {
  computeKeywordRelevance,
  evaluateKeywordGate,
  evaluateBriefGate,
  evaluateDraftGate,
  wordCount,
} from "../../src/seo-content/gates.js";
import type {
  ContentBrief,
  ContentDraft,
  KeywordMetrics,
} from "../../src/seo-content/types.js";

const POLICY: GatePolicy = GATE_POLICY_DEFAULTS;

function codes(d: { reasons: { code: string }[] }): string[] {
  return d.reasons.map((r) => r.code);
}

describe("computeKeywordRelevance (#598)", () => {
  it("is the fraction of keyword tokens present in the topic (keyword is the denominator)", () => {
    expect(computeKeywordRelevance("ai marketing", "best ai marketing automation tools")).toBe(1);
    expect(computeKeywordRelevance("ai cooking", "ai marketing automation")).toBe(0.5);
    expect(computeKeywordRelevance("", "anything")).toBe(0);
    expect(computeKeywordRelevance("ai", "AI MARKETING")).toBe(1); // case-insensitive
  });
});

describe("evaluateKeywordGate (#598)", () => {
  const metrics = (over: Partial<KeywordMetrics> = {}): KeywordMetrics => ({
    keyword: "ai marketing",
    monthlyVolume: 2000,
    difficulty: 30,
    intent: "commercial",
    ...over,
  });

  it("allows a relevant, high-volume, rankable, allowed-intent keyword", () => {
    const d = evaluateKeywordGate(metrics(), 1, POLICY);
    expect(d.decision).toBe("allow");
    expect(d.reasons).toEqual([]);
  });

  it("blocks an empty keyword", () => {
    expect(codes(evaluateKeywordGate(metrics({ keyword: "  " }), 1, POLICY))).toContain("keyword_empty");
  });

  it("blocks low relevance, low volume, high difficulty, and a disallowed intent (fail-closed, all reasons)", () => {
    const d = evaluateKeywordGate(metrics({ monthlyVolume: 5, difficulty: 95, intent: "navigational" }), 0.1, {
      ...POLICY,
      allowedIntents: ["commercial", "transactional"],
    });
    expect(d.decision).toBe("block");
    expect(codes(d)).toEqual(
      expect.arrayContaining(["keyword_irrelevant", "volume_too_low", "difficulty_too_high", "intent_not_allowed"]),
    );
  });
});

describe("evaluateBriefGate (#598)", () => {
  const brief = (over: Partial<ContentBrief> = {}): ContentBrief => ({
    title: "A Guide to AI Marketing",
    primaryKeyword: "ai marketing",
    audience: "growth teams",
    outline: [
      { heading: "What", summary: "define" },
      { heading: "When", summary: "fit" },
      { heading: "How", summary: "steps" },
    ],
    wordTarget: 900,
    ...over,
  });

  it("allows a complete brief whose primary keyword matches the validated keyword", () => {
    expect(evaluateBriefGate(brief(), "ai marketing", POLICY).decision).toBe("allow");
    expect(evaluateBriefGate(brief(), "AI Marketing", POLICY).decision).toBe("allow"); // case-insensitive match
  });

  it("blocks a keyword mismatch", () => {
    expect(codes(evaluateBriefGate(brief({ primaryKeyword: "seo" }), "ai marketing", POLICY))).toContain(
      "brief_keyword_mismatch",
    );
  });

  it("blocks a thin outline, missing title/audience, and a low word target", () => {
    const d = evaluateBriefGate(
      brief({ title: " ", audience: "", outline: [{ heading: "only", summary: "one" }], wordTarget: 100 }),
      "ai marketing",
      POLICY,
    );
    expect(codes(d)).toEqual(
      expect.arrayContaining([
        "brief_title_missing",
        "brief_audience_missing",
        "brief_outline_too_thin",
        "brief_word_target_too_low",
      ]),
    );
  });

  it("counts only sections that have BOTH a heading and a summary toward completeness", () => {
    const d = evaluateBriefGate(
      brief({ outline: [{ heading: "a", summary: "x" }, { heading: "b", summary: " " }, { heading: " ", summary: "y" }] }),
      "ai marketing",
      POLICY,
    );
    expect(codes(d)).toContain("brief_outline_too_thin");
  });
});

describe("evaluateDraftGate — the brand + fact check (#598)", () => {
  const longBody = (kw: string) => `${kw} ${"word ".repeat(400)}`.trim();
  const brief: ContentBrief = {
    title: "A Guide to AI Marketing",
    primaryKeyword: "ai marketing",
    audience: "growth teams",
    outline: [
      { heading: "What", summary: "define" },
      { heading: "When", summary: "fit" },
      { heading: "How", summary: "steps" },
    ],
    wordTarget: 600,
  };
  const draft = (over: Partial<ContentDraft> = {}): ContentDraft => {
    const body = over.body ?? longBody("ai marketing");
    return {
      title: "AI Marketing, the practical way",
      body,
      wordCount: wordCount(body),
      claims: [{ text: "claim", sourceUrl: "https://example.test/a" }],
      ...over,
    };
  };

  it("allows an on-brand, keyword-bearing, fully-sourced draft of sufficient length", () => {
    expect(evaluateDraftGate(draft(), brief, POLICY).decision).toBe("allow");
  });

  it("blocks a draft that is too short (max of the word floor and a fraction of the brief target)", () => {
    expect(codes(evaluateDraftGate(draft({ body: "ai marketing too short" }), brief, POLICY))).toContain(
      "draft_too_short",
    );
  });

  it("blocks a draft that never mentions the primary keyword (in title or body)", () => {
    const d = draft({ title: "An unrelated headline", body: longBody("something else") });
    expect(codes(evaluateDraftGate(d, brief, POLICY))).toContain("draft_keyword_missing");
  });

  it("blocks a draft containing a banned filler phrase (off-brand 'AI slop')", () => {
    const body = `${longBody("ai marketing")} In conclusion, buy now.`;
    expect(codes(evaluateDraftGate(draft({ body }), brief, POLICY))).toContain("draft_banned_phrase");
  });

  it("blocks a draft with an unsourced claim (the fact check)", () => {
    const d = evaluateDraftGate(
      draft({ claims: [{ text: "sourced", sourceUrl: "https://x.test" }, { text: "bare", sourceUrl: "  " }] }),
      brief,
      POLICY,
    );
    expect(codes(d)).toContain("draft_unsourced_claim");
  });

  it("blocks a draft that makes no claims at all (a publishable piece must cite something)", () => {
    expect(codes(evaluateDraftGate(draft({ claims: [] }), brief, POLICY))).toContain("draft_no_claims");
  });
});
