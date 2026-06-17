/**
 * Central-provisioning usage metering (issue #267, ADR-0267) — how ipop "bills the cost into the plan".
 * Every time a department uses a centrally-provisioned API, the adapter records ONE usage row: who used it,
 * which capability/provider, how many units, the cost of goods, and — when the provider returned one — an
 * EXTERNAL receipt reference.
 *
 * Premortem #200 §2 (self-reported metrics are fiction): a usage row is `verified` ONLY when it carries a
 * non-empty `externalRef` (a provider receipt / request id proving the call really happened). Without one
 * it is an UNVERIFIED estimate and must never drive a hard billing number on its own — the billing read
 * sums only verified usage. This module is the PURE shaping + the verification predicate.
 */

/** A usage measurement an adapter hands the ledger. `costCents` is the cost of goods ipop bills into the plan. */
export interface UsageMeasurement {
  workspaceId: string;
  capabilityId: string;
  provider: string;
  /** How many billable units the call consumed (API calls, rows, posts). Non-negative. */
  units: number;
  /** Cost of goods in cents ipop incurred (>= 0). Billed into the plan, not charged to the customer per call. */
  costCents: number;
  /** The provider's receipt / request id proving the call happened. Empty/undefined ⇒ the row is UNVERIFIED. */
  externalRef?: string | null;
}

/** A shaped usage row ready to persist — `verified` is DERIVED from `externalRef`, never caller-asserted. */
export interface UsageRecord {
  workspaceId: string;
  capabilityId: string;
  provider: string;
  units: number;
  costCents: number;
  externalRef: string | null;
  /** True iff an external provider receipt grounds this row (premortem §2). */
  verified: boolean;
  occurredAtMs: number;
}

/** True iff `ref` is a non-empty external receipt reference (the grounding test). Pure + total. */
export function isExternalReceipt(ref: string | null | undefined): boolean {
  return typeof ref === "string" && ref.trim().length > 0;
}

/**
 * Shape a measurement into a persistable {@link UsageRecord}. Clamps negative units/cost to 0, derives
 * `verified` from the external receipt, normalizes a blank ref to `null`. Pure — `nowMs` is injected.
 */
export function buildUsageRecord(m: UsageMeasurement, nowMs: number): UsageRecord {
  const ref = isExternalReceipt(m.externalRef) ? (m.externalRef as string).trim() : null;
  return {
    workspaceId: m.workspaceId,
    capabilityId: m.capabilityId,
    provider: m.provider,
    units: Number.isFinite(m.units) && m.units > 0 ? Math.trunc(m.units) : 0,
    costCents: Number.isFinite(m.costCents) && m.costCents > 0 ? Math.trunc(m.costCents) : 0,
    externalRef: ref,
    verified: ref !== null,
    occurredAtMs: nowMs,
  };
}

/** Sum the cost of goods (cents) across only the VERIFIED rows — the billable total (premortem §2). */
export function verifiedCostCents(records: readonly UsageRecord[]): number {
  return records.reduce((sum, r) => (r.verified ? sum + r.costCents : sum), 0);
}
