/**
 * Acceptance test for issue #611 — "Lead scoring to prioritize high-intent prospects".
 *
 * The literal acceptance criteria from the issue:
 *   1. a scoring model from BEHAVIOR (pricing visits, demo use, email opens) + FIRMOGRAPHICS;
 *   2. the outreach queue is ordered by intent score (agents work the highest scores first);
 *   3. the score is EXPLAINABLE.
 *
 * These tests drive the public barrel exactly as the outreach engine would — feed a realistic pipeline of
 * leads, get back a ranked work list — and assert each criterion directly.
 */

import { describe, it, expect } from "vitest";
import {
  buildOutreachQueue,
  scoreLead,
  explainScore,
  resolveQueuePolicy,
  type LeadInput,
} from "../../src/lead-scoring/index.js";

/** A realistic mixed pipeline: a hot in-product buyer, a researching mid-funnel lead, and a cold contact. */
const PIPELINE: LeadInput[] = [
  {
    // Researching the product but not yet deeply engaged; decent fit.
    leadId: "mid-funnel",
    behavior: { pricingVisits: 1, emailOpens: 4, siteVisits: 5, daysSinceLastActivity: 6 },
    firmographics: { industryFit: "core", role: "champion", employeeCount: 90 },
  },
  {
    // High intent: repeat pricing visits + real demo usage, just now, decision-maker at an ICP company.
    leadId: "in-product-buyer",
    behavior: { pricingVisits: 5, demoSessions: 3, demoMinutes: 25, emailClicks: 3, daysSinceLastActivity: 1 },
    firmographics: { industryFit: "core", role: "decision_maker", employeeCount: 300, annualRevenueUsd: 40_000_000 },
  },
  {
    // Almost no signal, off-ICP industry — the kind of lead agents waste effort on today.
    leadId: "low-intent",
    behavior: { emailOpens: 1, daysSinceLastActivity: 120 },
    firmographics: { industryFit: "off", region: "unsupported" },
  },
];

describe("issue #611 acceptance — explainable lead scoring prioritizes high-intent prospects", () => {
  it("[criterion 1] the model scores from BOTH behavior and firmographics", () => {
    const s = scoreLead(PIPELINE[1]!);
    const categories = new Set(s.factors.map((f) => f.category));
    expect(categories.has("behavior")).toBe(true);
    expect(categories.has("firmographics")).toBe(true);
    // Behavior signals named in the issue are all represented as factors.
    const keys = s.factors.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["pricing_visits", "demo_sessions", "email_clicks"]));
  });

  it("[criterion 2] the outreach queue is ordered by intent score — highest first", () => {
    const queue = buildOutreachQueue(PIPELINE, { minScore: 0, limit: 0 });

    // The high-intent in-product buyer is rank 1; the off-ICP no-signal lead is last.
    expect(queue[0]!.leadId).toBe("in-product-buyer");
    expect(queue[0]!.rank).toBe(1);
    expect(queue[queue.length - 1]!.leadId).toBe("low-intent");

    // Strictly: scores never increase as rank increases.
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i - 1]!.score).toBeGreaterThanOrEqual(queue[i]!.score);
    }
    // The buyer genuinely outscores the mid-funnel lead (intent beats mere fit).
    expect(queue[0]!.score).toBeGreaterThan(queue[1]!.score);
  });

  it("[criterion 3] every score is explainable — factors sum to the score and render to plain text", () => {
    for (const lead of PIPELINE) {
      const s = scoreLead(lead);
      // The number is fully decomposed into its named reasons.
      const factorSum = s.factors.reduce((acc, f) => acc + f.points, 0);
      expect(factorSum).toBe(s.behaviorScore + s.firmographicScore);
      expect(s.score).toBe(Math.min(100, Math.max(0, factorSum)));

      // It renders to a human-readable explanation: a headline plus one line per factor.
      const lines = explainScore(s);
      expect(lines[0]).toBe(s.summary);
      expect(lines).toHaveLength(s.factors.length + 1);
      expect(lines[0]).toContain(`/100`);
    }
  });

  it("[criterion 3] the rank of any lead can be justified line by line", () => {
    const queue = buildOutreachQueue(PIPELINE, { minScore: 0, limit: 0 });
    const top = queue[0]!;
    // The #1 lead's explanation leads with a strong positive intent driver (pricing/demo), not fit.
    const topPositive = top.factors.filter((f) => f.points > 0);
    expect(topPositive[0]!.category).toBe("behavior");
    expect(topPositive[0]!.points).toBeGreaterThan(0);
  });

  it("env-resolved policy can thin the queue to only worthwhile leads without code changes", () => {
    // Production tunes the queue purely through env (no schema/registry edit) — here we resolve a min-score
    // floor from an explicit env object and confirm the cold lead is dropped.
    const policy = resolveQueuePolicy({ LEAD_SCORING_QUEUE_MIN_SCORE: "30" } as NodeJS.ProcessEnv);
    expect(policy.minScore).toBe(30);
    const queue = buildOutreachQueue(PIPELINE, policy);
    expect(queue.some((e) => e.leadId === "low-intent")).toBe(false);
    expect(queue.every((e) => e.score >= 30)).toBe(true);
  });
});
