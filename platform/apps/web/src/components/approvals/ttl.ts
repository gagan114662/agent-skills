/**
 * Pure relative-time helpers for the Approvals Panel. Time is injected (`nowMs`) so they are
 * deterministic and unit-testable. TTL display is presentation-only — expiry is enforced
 * server-side (#13 sweep + decision-time check), so a client clock can never approve an expired
 * request (the server returns 409 and the row reconciles). See ADR-0026.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Compact magnitude+unit for a duration in ms, e.g. `3m`, `2h`, `3d`. */
function compact(ms: number): string {
  if (ms < MIN) return "<1m";
  if (ms < HOUR) return `${Math.floor(ms / MIN)}m`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)}h`;
  return `${Math.floor(ms / DAY)}d`;
}

/** How long ago `createdAtISO` was, e.g. `just now`, `3m ago`, `2h ago`. */
export function formatAge(createdAtISO: string, nowMs: number): string {
  const elapsed = nowMs - Date.parse(createdAtISO);
  if (elapsed < MIN) return "just now";
  return `${compact(elapsed)} ago`;
}

/** True once `expiresAtISO` is in the past. No expiry ⇒ never expired. */
export function isExpired(expiresAtISO: string | null, nowMs: number): boolean {
  if (!expiresAtISO) return false;
  return Date.parse(expiresAtISO) <= nowMs;
}

/** Time left until expiry (`5m left`), `expired`, or null when there is no expiry. */
export function formatTtl(expiresAtISO: string | null, nowMs: number): string | null {
  if (!expiresAtISO) return null;
  const remaining = Date.parse(expiresAtISO) - nowMs;
  if (remaining <= 0) return "expired";
  return `${compact(remaining)} left`;
}
