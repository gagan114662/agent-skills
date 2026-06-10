/**
 * Maintenance-mode policy (#99, ADR-0099). Pure and dependency-free so it runs in the no-DB/no-Redis
 * unit job and is the single source of truth for "does this request get rejected during maintenance?".
 * The Redis I/O lives in `./flag`, the HTTP enforcement in `./gate` — this only classifies.
 */

/** The maintenance flag's resolved state. `unavailable` means the backing store could not be read. */
export interface MaintenanceState {
  enabled: boolean;
  /** ISO timestamp maintenance was switched on. */
  since?: string;
  /** Operator-supplied reason (free text). */
  reason?: string;
  /** Member id (or label) that flipped the flag. */
  by?: string;
  /**
   * True when the flag could not be read from its backing store. The gate **fails open** on this —
   * an unreachable Redis must degrade to "no maintenance gate", never to a total write outage. See
   * ADR-0099 §1.
   */
  unavailable?: boolean;
}

/** A request is a "write" unless it is a safe, read-only HTTP method. */
export function isWriteRequest(method: string): boolean {
  const m = method.toUpperCase();
  return m !== "GET" && m !== "HEAD" && m !== "OPTIONS";
}

/**
 * Route prefixes always reachable during maintenance, even for writes:
 *  - `/maintenance` — the control route, or you could never turn maintenance back OFF;
 *  - `/livez` `/readyz` `/health` — health/readiness probes (operability under maintenance);
 *  - `/metrics` — Prometheus scrape;
 *  - `/auth` — sign-in, so an operator can authenticate to flip the flag.
 */
export const MAINTENANCE_ALLOW_PREFIXES: readonly string[] = [
  "/maintenance",
  "/livez",
  "/readyz",
  "/health",
  "/metrics",
  "/auth",
];

export function isAllowlisted(routePath: string): boolean {
  return MAINTENANCE_ALLOW_PREFIXES.some(
    (p) => routePath === p || routePath.startsWith(`${p}/`),
  );
}

/**
 * Decide whether to reject a request as a maintenance-blocked write. Total and pure:
 *   - maintenance off → never reject;
 *   - backing store unavailable → never reject (FAIL OPEN — deliberate, ADR-0099 §1);
 *   - a read (GET/HEAD/OPTIONS) → never reject;
 *   - an allow-listed route (control/probe/auth) → never reject;
 *   - otherwise → reject (it is a write while maintenance is on).
 */
export function shouldRejectWrite(
  state: MaintenanceState,
  method: string,
  routePath: string,
): boolean {
  if (state.unavailable) return false;
  if (!state.enabled) return false;
  if (!isWriteRequest(method)) return false;
  if (isAllowlisted(routePath)) return false;
  return true;
}
