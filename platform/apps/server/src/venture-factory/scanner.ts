import { freshnessFactor } from "../insight/ranking.js";
import type { CandidateEvidence, CandidateSourceKind } from "./types.js";

/**
 * The opportunity scanner's pure scoring (#187 AC1). No IO — the single source of truth for how a
 * lens/scout-filed candidate is scored before it earns scarce validation budget. Reuses the #100
 * Insight-Miner idea verbatim: candidates rank **multiplicatively** — source authority × freshness ×
 * pain intensity × competition absence, each normalised to 0–1 and the product scaled to 0–100. A zero
 * on any axis zeroes the candidate, so a strong opportunity must win on every axis (a stale, painless,
 * or crowded idea cannot rank highly no matter how loud the trend).
 *
 * The edge gate (`edge-gate.ts`) is separate and downstream: scanning ranks *attention*, the edge gate
 * decides *launch*. A high score never bypasses the FM#1 edge requirement.
 */

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * How much to trust the source that surfaced a candidate. The owner's own observation outranks the
 * trend-watchers because it is closer to a real secret (the same intuition as #100 `owner_secret`).
 */
const SOURCE_AUTHORITY: Record<CandidateSourceKind, number> = {
  owner: 1.0,
  scout: 0.85, // niche/competition watcher — closer to a real gap
  lens: 0.7, // trend/why-now watcher — everyone sees the same trends
};

export interface ScoreCandidateInput {
  source: CandidateSourceKind;
  evidence: CandidateEvidence;
}

/**
 * Candidate opportunity score (0–100): authority × freshness × pain × competition-absence,
 * multiplicative. Pure and deterministic given `now`.
 */
export function scoreCandidate(input: ScoreCandidateInput, now: Date, halfLifeDays: number): number {
  const authority = SOURCE_AUTHORITY[input.source] ?? 0.5;
  const freshness = freshnessFactor(input.evidence.observedAt, now, halfLifeDays);
  const pain = clamp01(input.evidence.painIntensity / 10);
  const competition = clamp01(input.evidence.competitionAbsence / 10);
  return Math.round(authority * freshness * pain * competition * 100);
}

/** Order candidates by score (desc), newest-first on ties — the scanner's work-list ordering. */
export function rankCandidates<T extends { score: number; createdAt: Date }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
