/**
 * Admission decision (#71). **Pure**: given the live counters + caps + the hard-stop flags, decide
 * whether a launch may proceed. No IO (the #17 `decide`/`guards` pattern) so the priority order is
 * unit-tested in isolation; the IO orchestrator that gathers the inputs is `scale/admission.ts`.
 *
 * Priority is deliberate: a **hard stop** (the #17 kill switch, then a cost-budget breach) precedes
 * the **soft caps** (per-tenant then global concurrency). A cap of `0` means *unlimited* — so the
 * default config (all caps 0, budget off) admits everything, preserving #25 behavior.
 */

/** Why a launch was denied. `kill_switch`/`budget_exceeded` are hard stops; the rest are capacity. */
export type AdmissionReason = "kill_switch" | "budget_exceeded" | "tenant_capacity" | "global_capacity";

export type AdmissionDecision = { ok: true } | { ok: false; reason: AdmissionReason };

export interface AdmissionState {
  /** #17 kill switch engaged for this tenant — halts all launches immediately. */
  killSwitch: boolean;
  /** The tenant's accrued cost has met/passed its budget cap this window. */
  budgetExceeded: boolean;
  /** Sessions currently in flight for this tenant. */
  tenantInFlight: number;
  /** Per-tenant concurrency cap; `0` = unlimited. */
  tenantMax: number;
  /** Sessions currently in flight across the whole fleet. */
  globalInFlight: number;
  /** Global concurrency ceiling; `0` = unlimited. */
  globalMax: number;
}

export function decideAdmission(s: AdmissionState): AdmissionDecision {
  if (s.killSwitch) return { ok: false, reason: "kill_switch" };
  if (s.budgetExceeded) return { ok: false, reason: "budget_exceeded" };
  if (s.tenantMax > 0 && s.tenantInFlight >= s.tenantMax) {
    return { ok: false, reason: "tenant_capacity" };
  }
  if (s.globalMax > 0 && s.globalInFlight >= s.globalMax) {
    return { ok: false, reason: "global_capacity" };
  }
  return { ok: true };
}
