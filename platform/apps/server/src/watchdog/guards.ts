/**
 * Pure bounded-restart guards for the Fleet Watchdog (#105), mirroring `autonomy/guards.ts` and
 * `venture/guards.ts`. No IO — `decide.ts` composes these and the `engine` reuses `windowExpired`
 * to reset a stale rolling window.
 */

/**
 * True once a session's no-progress age has reached the cutoff. A cutoff of `0` means "disabled" —
 * nothing is ever stale, keeping today's #25 behavior (the watchdog is also config default-OFF).
 */
export function isStale(staleForMs: number, staleCutoffMs: number): boolean {
  return staleCutoffMs > 0 && staleForMs >= staleCutoffMs;
}

/**
 * True once the revivals-in-window count has reached the hard cap. A cap of `0` therefore means
 * "never revive" (escalate on first detection) — the safe reading for a supervisor.
 */
export function revivalLimitReached(revivalsInWindow: number, maxRevivalsPerWindow: number): boolean {
  return revivalsInWindow >= maxRevivalsPerWindow;
}

/** True once enough time has elapsed since the last revival (Infinity for a never-revived lineage). */
export function backoffElapsed(msSinceLastRevival: number, backoffMs: number): boolean {
  return msSinceLastRevival >= backoffMs;
}

/** True once a rolling window has aged past its length (the count resets to 0 on the next revival). */
export function windowExpired(windowAgeMs: number, windowMs: number): boolean {
  return windowMs > 0 && windowAgeMs >= windowMs;
}
