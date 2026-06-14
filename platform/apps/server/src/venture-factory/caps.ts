import type { VentureFactoryConfig } from "../config/schema.js";

/**
 * Resolve the Venture Factory policy from the layered config (#58), applying hard defaults — mirrors
 * `venture/caps.ts resolveVentureCaps`. The factory is **default OFF** (`enabled: false`) and **owner
 * workspace first** (`ownerWorkspaceOnly: true`): a deployment that sets no `ventureFactory` section
 * runs no scanner, ships no smoke test, bootstraps nothing. Every threshold parameterizes a pure
 * decision module so the gates stay config-lockable per tenant.
 */
export interface VentureFactoryCaps {
  /** The factory flag — OFF by default. Gates the proactive scanner/validation/bootstrap tick. */
  enabled: boolean;
  /**
   * When true (default), the autonomous factory only runs in the OWNER's own workspace — the safest
   * first blast radius (premortem FM#4). Other tenants keep recording/reading but no autonomous step runs.
   */
  ownerWorkspaceOnly: boolean;
  /** Half-life (days) for the freshness decay in `scoreCandidate`. */
  freshnessHalfLifeDays: number;
  /** Minimum opportunity score for a candidate to earn a validation experiment. */
  minScoreToValidate: number;
  /** The HARD validation budget cap (cents) per experiment — spend may never exceed this. */
  validationBudgetCapCents: number;
  /** Points awarded per external signup when scoring a validation scorecard. */
  pointsPerSignup: number;
  /** Minimum EXTERNAL signups to PROMOTE a validated candidate. */
  minSignupsToPromote: number;
  /** Maximum acceptable CAC (cents) to PROMOTE. */
  maxCacCents: number;
  /** Signups at/below which validation is a clear KILL. */
  killSignups: number;
  /** Hard cap on concurrently-active ventures (the scaling gate). */
  maxConcurrentVentures: number;
  /** Bar a new bootstrap until at least one venture is externally profitable (FM#1). */
  requireProfitableBeforeScale: boolean;
  /** Estimated cost (cents) charged to tenant usage per scan pass (only bites against a configured budget). */
  scanCostCents: number;
}

export const VENTURE_FACTORY_DEFAULTS: VentureFactoryCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  freshnessHalfLifeDays: 30,
  minScoreToValidate: 50,
  validationBudgetCapCents: 50_000, // $500 hard cap per smoke test
  pointsPerSignup: 1,
  minSignupsToPromote: 50,
  maxCacCents: 1_000, // $10
  killSignups: 5,
  maxConcurrentVentures: 3,
  requireProfitableBeforeScale: true,
  scanCostCents: 50,
};

export function resolveVentureFactoryCaps(
  cfg: VentureFactoryConfig | undefined,
): VentureFactoryCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_FACTORY_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? VENTURE_FACTORY_DEFAULTS.ownerWorkspaceOnly,
    freshnessHalfLifeDays: cfg?.freshnessHalfLifeDays ?? VENTURE_FACTORY_DEFAULTS.freshnessHalfLifeDays,
    minScoreToValidate: cfg?.minScoreToValidate ?? VENTURE_FACTORY_DEFAULTS.minScoreToValidate,
    validationBudgetCapCents: cfg?.validationBudgetCapCents ?? VENTURE_FACTORY_DEFAULTS.validationBudgetCapCents,
    pointsPerSignup: cfg?.pointsPerSignup ?? VENTURE_FACTORY_DEFAULTS.pointsPerSignup,
    minSignupsToPromote: cfg?.minSignupsToPromote ?? VENTURE_FACTORY_DEFAULTS.minSignupsToPromote,
    maxCacCents: cfg?.maxCacCents ?? VENTURE_FACTORY_DEFAULTS.maxCacCents,
    killSignups: cfg?.killSignups ?? VENTURE_FACTORY_DEFAULTS.killSignups,
    maxConcurrentVentures: cfg?.maxConcurrentVentures ?? VENTURE_FACTORY_DEFAULTS.maxConcurrentVentures,
    requireProfitableBeforeScale:
      cfg?.requireProfitableBeforeScale ?? VENTURE_FACTORY_DEFAULTS.requireProfitableBeforeScale,
    scanCostCents: cfg?.scanCostCents ?? VENTURE_FACTORY_DEFAULTS.scanCostCents,
  };
}
