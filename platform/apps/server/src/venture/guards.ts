/**
 * Pure termination/freshness guards for the Venture Loop (#96), mirroring `autonomy/guards.ts`. No
 * IO — `decide.ts` composes these, and `admission.ts` uses `scorecardExpired` for the gate.
 */

/** True once `now` has reached/passed the scorecard's expiry (an expired scorecard never gates). */
export function scorecardExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** True iff at least one proposed angle has NOT already been tried+failed (progress is possible). */
export function hasNovelAngle(proposed: readonly string[], failed: readonly string[]): boolean {
  const tried = new Set(failed);
  return proposed.some((a) => !tried.has(a));
}

/** True once the 1-based iteration count has reached the configured ceiling. */
export function maxIterationsReached(iteration: number, maxIterations: number): boolean {
  return iteration >= maxIterations;
}
