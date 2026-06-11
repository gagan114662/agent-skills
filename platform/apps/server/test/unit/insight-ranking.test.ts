import { describe, it, expect } from "vitest";
import {
  freshnessFactor,
  rankSource,
  rankInsight,
  sortByScore,
} from "../../src/insight/ranking.js";

const now = new Date("2026-06-11T00:00:00Z");
const daysAgo = (n: number) => new Date(now.getTime() - n * 24 * 60 * 60 * 1000);

describe("freshnessFactor (exponential recency decay)", () => {
  it("is ~1 today, 0.5 at one half-life, and decays monotonically toward 0", () => {
    expect(freshnessFactor(now, now, 30)).toBeCloseTo(1, 5);
    expect(freshnessFactor(daysAgo(30), now, 30)).toBeCloseTo(0.5, 5);
    expect(freshnessFactor(daysAgo(60), now, 30)).toBeCloseTo(0.25, 5);
    expect(freshnessFactor(daysAgo(365), now, 30)).toBeLessThan(0.01);
  });

  it("clamps future timestamps to 1 (never exceeds 1)", () => {
    expect(freshnessFactor(daysAgo(-10), now, 30)).toBe(1);
  });

  it("treats a non-positive half-life as decay-disabled (always 1)", () => {
    expect(freshnessFactor(daysAgo(100), now, 0)).toBe(1);
  });
});

describe("rankSource (the list is the strategy: score sources before mining)", () => {
  it("ranks the owner secret highest among same-recency sources", () => {
    const secret = rankSource({ kind: "owner_secret", observedAt: now }, now, 30);
    const pricing = rankSource({ kind: "pricing", observedAt: now }, now, 30);
    expect(secret).toBeGreaterThan(pricing);
    expect(secret).toBe(100); // authority 1.0 × freshness 1.0 × 100
  });

  it("ranks a fresher source above a staler source of the same kind", () => {
    const fresh = rankSource({ kind: "support_forum", observedAt: now }, now, 30);
    const stale = rankSource({ kind: "support_forum", observedAt: daysAgo(60) }, now, 30);
    expect(fresh).toBeGreaterThan(stale);
  });

  it("ranks primary cited sources above secondary why-now signals at equal recency", () => {
    const forum = rankSource({ kind: "support_forum", observedAt: now }, now, 30);
    const changelog = rankSource({ kind: "api_changelog", observedAt: now }, now, 30);
    expect(forum).toBeGreaterThan(changelog);
  });
});

describe("rankInsight (freshness × pain intensity × competition absence)", () => {
  it("scores a fresh, acute, uncontested insight highly (all three axes win)", () => {
    const s = rankInsight(
      { painIntensity: 10, competitionAbsence: 10, freshnessAt: now },
      now,
      30,
    );
    expect(s).toBe(100);
  });

  it("zeroes the insight when any single axis is zero (multiplicative, not an average)", () => {
    expect(
      rankInsight({ painIntensity: 0, competitionAbsence: 10, freshnessAt: now }, now, 30),
    ).toBe(0);
    expect(
      rankInsight({ painIntensity: 10, competitionAbsence: 0, freshnessAt: now }, now, 30),
    ).toBe(0);
    // Stale evidence drives freshness ~0 → near-zero score even with max pain + competition.
    expect(
      rankInsight({ painIntensity: 10, competitionAbsence: 10, freshnessAt: daysAgo(365) }, now, 30),
    ).toBeLessThan(2);
  });

  it("ranks a more acute pain above a milder one, all else equal", () => {
    const acute = rankInsight({ painIntensity: 9, competitionAbsence: 8, freshnessAt: now }, now, 30);
    const mild = rankInsight({ painIntensity: 3, competitionAbsence: 8, freshnessAt: now }, now, 30);
    expect(acute).toBeGreaterThan(mild);
  });
});

describe("sortByScore", () => {
  it("orders by score desc, newest-first on ties", () => {
    const a = { score: 40, createdAt: daysAgo(1) };
    const b = { score: 90, createdAt: daysAgo(2) };
    const c = { score: 40, createdAt: now };
    expect(sortByScore([a, b, c])).toEqual([b, c, a]);
  });
});
