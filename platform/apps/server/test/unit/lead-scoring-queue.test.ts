/**
 * Unit tests for the OUTREACH QUEUE (issue #611): `buildOutreachQueue` and `compareByIntent`.
 *
 * The acceptance criterion: "the outreach queue is ordered by intent score." These pin that the queue is
 * sorted highest-intent-first, ranked 1..N, deterministic on ties, and honors the env-resolved policy
 * (min-score floor + top-N cap) without touching the process env (policy passed explicitly).
 */

import { describe, it, expect } from "vitest";
import {
  buildOutreachQueue,
  compareByIntent,
  scoreLead,
  type LeadInput,
  type QueuePolicy,
} from "../../src/lead-scoring/index.js";

const NO_FILTER: QueuePolicy = { minScore: 0, limit: 0 };

/** A spread of leads from hot to cold, deliberately supplied OUT of score order. */
const LEADS: LeadInput[] = [
  { leadId: "cold-tire-kicker", behavior: { emailOpens: 1 } },
  {
    leadId: "hot-buyer",
    behavior: { pricingVisits: 4, demoSessions: 2, demoMinutes: 20, daysSinceLastActivity: 1 },
    firmographics: { industryFit: "core", role: "decision_maker", employeeCount: 200 },
  },
  { leadId: "warm-engaged", behavior: { pricingVisits: 2, emailClicks: 2, daysSinceLastActivity: 5 } },
  {
    leadId: "cool-curious",
    behavior: { siteVisits: 3, emailOpens: 2, daysSinceLastActivity: 20 },
    firmographics: { industryFit: "adjacent" },
  },
];

describe("buildOutreachQueue — ordering", () => {
  it("orders the queue by intent score, highest first, with 1-based ranks", () => {
    const queue = buildOutreachQueue(LEADS, NO_FILTER);
    expect(queue).toHaveLength(LEADS.length);

    // Scores are monotonically non-increasing down the queue.
    for (let i = 1; i < queue.length; i++) {
      expect(queue[i - 1]!.score).toBeGreaterThanOrEqual(queue[i]!.score);
    }
    // Ranks are dense and 1-based.
    expect(queue.map((e) => e.rank)).toEqual([1, 2, 3, 4]);
    // The hand-raiser is worked first; the tire-kicker last.
    expect(queue[0]!.leadId).toBe("hot-buyer");
    expect(queue[queue.length - 1]!.leadId).toBe("cold-tire-kicker");
  });

  it("every queue entry carries its full explanation (rank sits next to the why)", () => {
    const top = buildOutreachQueue(LEADS, NO_FILTER)[0]!;
    expect(top.factors.length).toBeGreaterThan(0);
    expect(top.summary).toContain("/100");
    // The entry IS a LeadScore plus a rank — re-scoring the lead reproduces its score.
    const reconstructed = scoreLead(LEADS.find((l) => l.leadId === top.leadId)!);
    expect(top.score).toBe(reconstructed.score);
  });

  it("breaks ties deterministically by leadId ascending", () => {
    const sameSignal = { pricingVisits: 1 as const };
    const queue = buildOutreachQueue(
      [
        { leadId: "b-second", behavior: sameSignal },
        { leadId: "a-first", behavior: sameSignal },
        { leadId: "c-third", behavior: sameSignal },
      ],
      NO_FILTER,
    );
    expect(queue.map((e) => e.score)).toEqual([7, 7, 7]); // round(20/3) each — identical intent
    expect(queue.map((e) => e.leadId)).toEqual(["a-first", "b-second", "c-third"]);
  });

  it("compareByIntent is a valid total order (score desc, then leadId asc)", () => {
    const hi = scoreLead({ leadId: "z", behavior: { pricingVisits: 3, daysSinceLastActivity: 1 } });
    const lo = scoreLead({ leadId: "a", behavior: { emailOpens: 1 } });
    expect(compareByIntent(hi, lo)).toBeLessThan(0); // hi sorts before lo despite later leadId
    const tieA = scoreLead({ leadId: "a", behavior: { pricingVisits: 1 } });
    const tieB = scoreLead({ leadId: "b", behavior: { pricingVisits: 1 } });
    expect(compareByIntent(tieA, tieB)).toBeLessThan(0);
    expect(compareByIntent(tieB, tieA)).toBeGreaterThan(0);
  });
});

describe("buildOutreachQueue — policy", () => {
  it("drops leads below the min-score floor", () => {
    const queue = buildOutreachQueue(LEADS, { minScore: 30, limit: 0 });
    expect(queue.every((e) => e.score >= 30)).toBe(true);
    expect(queue.some((e) => e.leadId === "cold-tire-kicker")).toBe(false);
  });

  it("caps the queue to the top-N after ranking", () => {
    const queue = buildOutreachQueue(LEADS, { minScore: 0, limit: 2 });
    expect(queue).toHaveLength(2);
    expect(queue[0]!.leadId).toBe("hot-buyer");
    expect(queue.map((e) => e.rank)).toEqual([1, 2]);
  });

  it("an empty pipeline yields an empty queue", () => {
    expect(buildOutreachQueue([], NO_FILTER)).toEqual([]);
  });
});
