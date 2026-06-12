import type { SelfqaConfig } from "../config/schema.js";

/**
 * Resolve the self-QA policy from the layered config (#58), applying hard defaults — mirrors
 * `flywheel/caps.ts` and `watchdog/caps.ts`. The loop is **default OFF** (`enabled: false`): a deployment
 * that sets no `selfqa` section runs no synthetic QA and files no issues, and the background tick is also
 * default-off (`SELFQA_INTERVAL_MS = 0`). The synthetic workspace slug is reserved + tenant-isolated.
 */
export interface SelfqaCaps {
  /** The self-QA flag. OFF by default. */
  enabled: boolean;
  /** Reserved slug of the dedicated synthetic QA workspace (never a real tenant). */
  workspaceSlug: string;
  /** Hard cap on findings turned into issues in a single run (a runaway-page bound). */
  maxFindingsPerRun: number;
  /** Whether a critical finding pages the workspace owner via the #148 seam. */
  pageCriticalOwner: boolean;
}

export const SELFQA_DEFAULTS: SelfqaCaps = {
  enabled: false,
  workspaceSlug: "selfqa-system",
  maxFindingsPerRun: 50,
  pageCriticalOwner: true,
};

export function resolveSelfqaCaps(cfg: SelfqaConfig | undefined): SelfqaCaps {
  return {
    enabled: cfg?.enabled ?? SELFQA_DEFAULTS.enabled,
    workspaceSlug: cfg?.workspaceSlug ?? SELFQA_DEFAULTS.workspaceSlug,
    maxFindingsPerRun: cfg?.maxFindingsPerRun ?? SELFQA_DEFAULTS.maxFindingsPerRun,
    pageCriticalOwner: cfg?.pageCriticalOwner ?? SELFQA_DEFAULTS.pageCriticalOwner,
  };
}
