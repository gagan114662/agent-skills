import type { SupportDeskConfig } from "../config/schema.js";

/**
 * Resolve the Support Desk policy from the layered config (#58, #190) applying hard defaults — mirrors
 * `voice/caps.ts`. The desk is **default OFF** and, critically, **autonomous replies are default OFF**
 * (`autoSend: false`). With the defaults a deployment behaves exactly like #114: every reply is a #13
 * human gate. `autoSend` is the master switch, and even when ON the routing gate still requires a
 * category in `autoSendCategories`, the owner workspace (when `ownerWorkspaceOnly`), churn-risk below
 * `high`, no escalation signal, and the per-day cap — and an `AutoApprover` must be wired (the default
 * wiring leaves it unset). Refunds are NEVER autonomous regardless of this policy.
 */
export interface SupportDeskCaps {
  /** The support-desk feature flag (KB reads, SLA, receipts, recurring-issue filing). OFF by default. */
  enabled: boolean;
  /** The autonomous-reply master switch. OFF by default ⇒ every reply is a #13 human gate. */
  autoSend: boolean;
  /** The narrow allowlist of categories an autonomous reply may answer. */
  autoSendCategories: readonly string[];
  /** Restrict autonomous sends to the owner workspace first. ON by default. */
  ownerWorkspaceOnly: boolean;
  /** Bounded blast radius: the max autonomous sends per workspace per rolling day. */
  autoSendMaxPerDay: number;
  /** The first-response SLA window (minutes). */
  firstResponseSlaMinutes: number;
  /** Same-fingerprint complaints before one deduped backlog issue is filed. */
  recurringComplaintThreshold: number;
}

export const SUPPORT_DESK_DEFAULTS: SupportDeskCaps = {
  enabled: false,
  autoSend: false,
  // Only the generic "support" how-to class is auto-answerable out of the box; everything money/bug/churn
  // related stays a human gate. A deployment widens this explicitly.
  autoSendCategories: ["support"],
  ownerWorkspaceOnly: true,
  autoSendMaxPerDay: 20,
  firstResponseSlaMinutes: 240,
  recurringComplaintThreshold: 3,
};

export function resolveSupportDeskCaps(cfg: SupportDeskConfig | undefined): SupportDeskCaps {
  return {
    enabled: cfg?.enabled ?? SUPPORT_DESK_DEFAULTS.enabled,
    autoSend: cfg?.autoSend ?? SUPPORT_DESK_DEFAULTS.autoSend,
    autoSendCategories: cfg?.autoSendCategories ?? SUPPORT_DESK_DEFAULTS.autoSendCategories,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? SUPPORT_DESK_DEFAULTS.ownerWorkspaceOnly,
    autoSendMaxPerDay: cfg?.autoSendMaxPerDay ?? SUPPORT_DESK_DEFAULTS.autoSendMaxPerDay,
    firstResponseSlaMinutes: cfg?.firstResponseSlaMinutes ?? SUPPORT_DESK_DEFAULTS.firstResponseSlaMinutes,
    recurringComplaintThreshold:
      cfg?.recurringComplaintThreshold ?? SUPPORT_DESK_DEFAULTS.recurringComplaintThreshold,
  };
}
