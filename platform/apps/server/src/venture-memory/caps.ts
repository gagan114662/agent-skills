import type { VentureMemoryConfig } from "../config/schema.js";

/**
 * Resolve the Venture Memory & Planning policy from the layered config (#58), applying hard defaults —
 * mirrors `planning/caps.ts`. The weekly planning tick is **default OFF** (`enabled: false`): a
 * deployment that sets no `ventureMemory` section drafts no plans and distills no playbooks.
 *
 * Recording venture memory + OKRs and reading beliefs/OKRs/plans/playbooks are ALWAYS available
 * (harmless, tenant-scoped) — `enabled` gates only the proactive weekly tick (the #115 discipline).
 */
export interface VentureMemoryCaps {
  /** The weekly planning-tick flag. OFF by default. */
  enabled: boolean;
  /** Hard cap on items a single weekly plan drafts. */
  maxPlanItems: number;
  /** Memories older than this (and not superseded) are surfaced for owner review. 0 ⇒ never. */
  staleAfterDays: number;
  /** Max memories rendered per kind in a session brief (bounds the injected text). */
  maxBriefPerKind: number;
  /** Max candidate playbooks offered into a plan draft. */
  maxPlaybookCandidates: number;
  /** When true, an APPROVED plan's items flow into the #115 backlog (which auto-dispatches). */
  dispatchOnApprove: boolean;
}

export const VENTURE_MEMORY_DEFAULTS: VentureMemoryCaps = {
  enabled: false,
  maxPlanItems: 5,
  staleAfterDays: 45,
  maxBriefPerKind: 5,
  maxPlaybookCandidates: 3,
  dispatchOnApprove: true,
};

export function resolveVentureMemoryCaps(
  cfg: VentureMemoryConfig | undefined,
): VentureMemoryCaps {
  return {
    enabled: cfg?.enabled ?? VENTURE_MEMORY_DEFAULTS.enabled,
    maxPlanItems: cfg?.maxPlanItems ?? VENTURE_MEMORY_DEFAULTS.maxPlanItems,
    staleAfterDays: cfg?.staleAfterDays ?? VENTURE_MEMORY_DEFAULTS.staleAfterDays,
    maxBriefPerKind: cfg?.maxBriefPerKind ?? VENTURE_MEMORY_DEFAULTS.maxBriefPerKind,
    maxPlaybookCandidates:
      cfg?.maxPlaybookCandidates ?? VENTURE_MEMORY_DEFAULTS.maxPlaybookCandidates,
    dispatchOnApprove: cfg?.dispatchOnApprove ?? VENTURE_MEMORY_DEFAULTS.dispatchOnApprove,
  };
}
