import { describe, it, expect } from "vitest";
import { scoreCandidate, rankCandidates } from "../../src/venture-factory/scanner.js";
import type { CandidateEvidence } from "../../src/venture-factory/types.js";

const NOW = new Date("2026-06-13T00:00:00Z");

function evidence(over: Partial<CandidateEvidence> = {}): CandidateEvidence {
  return {
    painIntensity: 10,
    competitionAbsence: 10,
    observedAt: NOW,
    citations: ["forum-thread-1"],
    ...over,
  };
}

describe("scoreCandidate (multiplicative, like #100)", () => {
  it("scores a fresh, painful, uncontested owner candidate near 100", () => {
    expect(scoreCandidate({ source: "owner", evidence: evidence() }, NOW, 30)).toBe(100);
  });

  it("ranks scout above lens for the same evidence (closer to a real gap)", () => {
    const ev = evidence();
    expect(scoreCandidate({ source: "scout", evidence: ev }, NOW, 30)).toBeGreaterThan(
      scoreCandidate({ source: "lens", evidence: ev }, NOW, 30),
    );
  });

  it("zeroes the candidate when any axis is zero (multiplicative)", () => {
    expect(scoreCandidate({ source: "owner", evidence: evidence({ painIntensity: 0 }) }, NOW, 30)).toBe(0);
    expect(scoreCandidate({ source: "owner", evidence: evidence({ competitionAbsence: 0 }) }, NOW, 30)).toBe(0);
  });

  it("decays a stale signal", () => {
    const stale = evidence({ observedAt: new Date("2026-04-13T00:00:00Z") }); // ~2 months
    expect(scoreCandidate({ source: "owner", evidence: stale }, NOW, 30)).toBeLessThan(
      scoreCandidate({ source: "owner", evidence: evidence() }, NOW, 30),
    );
  });

  it("clamps out-of-range axes", () => {
    expect(scoreCandidate({ source: "owner", evidence: evidence({ painIntensity: 99 }) }, NOW, 30)).toBe(100);
  });
});

describe("rankCandidates", () => {
  it("orders by score desc, newest-first on ties", () => {
    const a = { id: "a", score: 50, createdAt: new Date("2026-01-01") };
    const b = { id: "b", score: 80, createdAt: new Date("2026-01-01") };
    const c = { id: "c", score: 80, createdAt: new Date("2026-02-01") };
    expect(rankCandidates([a, b, c]).map((x) => x.id)).toEqual(["c", "b", "a"]);
  });
});
