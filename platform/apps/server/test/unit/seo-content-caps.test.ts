/**
 * Unit tests for the SEO content pipeline caps (#598): default OFF, env-driven master switch + credentials, and
 * fail-closed clamping of every gate threshold.
 */

import { describe, it, expect } from "vitest";
import {
  resolveSeoContentCaps,
  resolveGatePolicy,
  GATE_POLICY_DEFAULTS,
  SEO_CONTENT_DEFAULTS,
} from "../../src/seo-content/caps.js";
import { SEARCH_INTENTS } from "../../src/seo-content/types.js";

describe("resolveSeoContentCaps (#598)", () => {
  it("defaults OFF with no credentials and the conservative policy", () => {
    const caps = resolveSeoContentCaps({});
    expect(caps.enabled).toBe(false);
    expect(caps.credentials).toEqual({ publish: null, index: null });
    expect(caps.policy).toEqual(GATE_POLICY_DEFAULTS);
    expect(SEO_CONTENT_DEFAULTS.enabled).toBe(false);
  });

  it("reads the master switch case-insensitively from a small truthy set", () => {
    for (const v of ["1", "true", "YES", "On"]) {
      expect(resolveSeoContentCaps({ SEO_CONTENT_PIPELINE_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ["0", "false", "no", "", "maybe"]) {
      expect(resolveSeoContentCaps({ SEO_CONTENT_PIPELINE_ENABLED: v }).enabled).toBe(false);
    }
  });

  it("treats whitespace-only credentials as absent", () => {
    const caps = resolveSeoContentCaps({ SEO_PUBLISH_TOKEN: "  ", SEO_INDEX_TOKEN: " tok " });
    expect(caps.credentials.publish).toBeNull();
    expect(caps.credentials.index).toBe("tok");
  });

  it("clamps numeric knobs into range and falls back on garbage (fail-closed)", () => {
    const p = resolveGatePolicy({
      SEO_MIN_KEYWORD_RELEVANCE: "5", // clamps to 1
      SEO_MAX_DIFFICULTY: "-9", // clamps to 0
      SEO_MIN_MONTHLY_VOLUME: "not-a-number", // falls back to default
      SEO_MIN_BRIEF_SECTIONS: "4",
      SEO_MIN_DRAFT_WORD_RATIO: "0.8",
    });
    expect(p.minKeywordRelevance).toBe(1);
    expect(p.maxDifficulty).toBe(0);
    expect(p.minMonthlyVolume).toBe(GATE_POLICY_DEFAULTS.minMonthlyVolume);
    expect(p.minBriefSections).toBe(4);
    expect(p.minDraftWordRatio).toBe(0.8);
  });

  it("parses the allowed-intent list, dropping unknowns and falling back when empty", () => {
    expect(resolveGatePolicy({ SEO_ALLOWED_INTENTS: "transactional, commercial" }).allowedIntents).toEqual([
      "transactional",
      "commercial",
    ]);
    // All-garbage ⇒ safe default (every intent), never an empty (deny-all-then-pass) set.
    expect(resolveGatePolicy({ SEO_ALLOWED_INTENTS: "bogus,??" }).allowedIntents).toEqual(SEARCH_INTENTS);
  });

  it("parses a pipe-separated banned-phrase override, else keeps the defaults", () => {
    expect(resolveGatePolicy({ SEO_BANNED_PHRASES: "foo | bar baz | " }).bannedPhrases).toEqual([
      "foo",
      "bar baz",
    ]);
    expect(resolveGatePolicy({}).bannedPhrases).toEqual(GATE_POLICY_DEFAULTS.bannedPhrases);
  });
});
