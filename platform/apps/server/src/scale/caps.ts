import type { ScaleConfig } from "../config/schema.js";

/**
 * The resolved per-tenant scale policy (#71): a {@link ScaleConfig} partial with hard defaults
 * applied. Everything defaults to **off** (no pool, unlimited tenant concurrency, no budget, cost
 * rate 0) so a tenant with no `[scale]` block keeps today's #25 behavior. `globalConcurrency` is a
 * fleet ceiling resolved separately at the server level (env default), not part of per-tenant caps.
 */
export interface ScaleCaps {
  warmPoolSize: number;
  regions: string[];
  preferredRegion?: string;
  tenantConcurrency: number;
  budgetCents: number;
  computeRateCentsPerMinute: number;
  /** Infra budget ceiling in cents (#113); 0 = no ceiling (the forecast never warns). */
  infraBudgetCeilingCents: number;
}

/** Apply hard defaults to a tenant's `[scale]` config (or its absence). Pure. */
export function resolveScaleCaps(scale: ScaleConfig | undefined): ScaleCaps {
  return {
    warmPoolSize: scale?.warmPoolSize ?? 0,
    regions: scale?.regions ? [...scale.regions] : [],
    preferredRegion: scale?.preferredRegion,
    tenantConcurrency: scale?.tenantConcurrency ?? 0,
    budgetCents: scale?.budgetCents ?? 0,
    computeRateCentsPerMinute: scale?.computeRateCentsPerMinute ?? 0,
    infraBudgetCeilingCents: scale?.infraBudgetCeilingCents ?? 0,
  };
}
