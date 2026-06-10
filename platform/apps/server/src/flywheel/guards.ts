/**
 * Pure predicates for the Self-Healing Flywheel (#117), mirroring `watchdog/guards.ts`. No IO —
 * `decide.ts` composes these and the engine reuses them to bound issue creation and fix concurrency.
 */

/** True once a fingerprint's occurrence count has reached the threshold to earn an issue. */
export function aboveThreshold(occurrenceCount: number, issueThreshold: number): boolean {
  return issueThreshold > 0 && occurrenceCount >= issueThreshold;
}

/** True when the fingerprint has accrued occurrences since the issue was last synced (worth a comment). */
export function hasNewOccurrences(occurrenceCount: number, syncedOccurrenceCount: number): boolean {
  return occurrenceCount > syncedOccurrenceCount;
}

/** True while there is headroom under the hard concurrent-fix cap (0 = never auto-dispatch). */
export function concurrencyAvailable(activeFixes: number, maxConcurrentFixes: number): boolean {
  return maxConcurrentFixes > 0 && activeFixes < maxConcurrentFixes;
}

/** True while this tick has not yet hit its issue-creation rate limit (0 = never draft). */
export function withinRateLimit(issuedThisTick: number, maxIssuesPerTick: number): boolean {
  return maxIssuesPerTick > 0 && issuedThisTick < maxIssuesPerTick;
}
