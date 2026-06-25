import type { ScaleConfig } from "../config/schema.js";

/** The active-plan fields scale needs; kept structural so scale does not depend on billing internals. */
export interface ScalePlanBudget {
  status: string;
  expiresAt?: Date;
  monthlySessionBudgetCents: number;
}

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

/** Apply hard defaults to a tenant's `[scale]` config (or its absence), then overlay paid-plan budget. Pure. */
export function resolveScaleCaps(scale: ScaleConfig | undefined, activePlan?: ScalePlanBudget): ScaleCaps {
  const planBudget =
    activePlan?.status === "active" &&
    Number.isFinite(activePlan.monthlySessionBudgetCents) &&
    activePlan.monthlySessionBudgetCents > 0
      ? Math.trunc(activePlan.monthlySessionBudgetCents)
      : undefined;
  return {
    warmPoolSize: scale?.warmPoolSize ?? 0,
    regions: scale?.regions ? [...scale.regions] : [],
    preferredRegion: scale?.preferredRegion,
    tenantConcurrency: scale?.tenantConcurrency ?? 0,
    budgetCents: planBudget ?? scale?.budgetCents ?? 0,
    computeRateCentsPerMinute: scale?.computeRateCentsPerMinute ?? 0,
    infraBudgetCeilingCents: scale?.infraBudgetCeilingCents ?? 0,
  };
}
