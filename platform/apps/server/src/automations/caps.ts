import type { AutomationsConfig } from "../config/schema.js";

/**
 * Resolve the per-tenant automations policy from the layered config (#58), applying hard defaults —
 * mirrors `marketing/caps.ts` and `flywheel/caps.ts`. **Default OFF** (`enabled: false`): a deployment
 * that sets no `automations` section never fires a scheduled run (creating automations is still
 * allowed — they simply do not tick), and the background timer is also default-off
 * (`AUTOMATIONS_INTERVAL_MS = 0`).
 */
export interface AutomationCaps {
  /** The automations tick flag. OFF by default — a disabled workspace's tick is a no-op. */
  enabled: boolean;
  /** Hard cap on runs launched per workspace inside `windowMinutes` (the rate limit). */
  maxRunsPerWindow: number;
  /** The rate-limit window, in minutes. */
  windowMinutes: number;
  /** Hard cap on automation definitions a workspace may create. */
  maxPerWorkspace: number;
}

export const AUTOMATION_DEFAULTS: AutomationCaps = {
  enabled: false,
  maxRunsPerWindow: 10, // a generous default ceiling on scheduled launches per window
  windowMinutes: 60,
  maxPerWorkspace: 50,
};

export function resolveAutomationCaps(cfg: AutomationsConfig | undefined): AutomationCaps {
  return {
    enabled: cfg?.enabled ?? AUTOMATION_DEFAULTS.enabled,
    maxRunsPerWindow: cfg?.maxRunsPerWindow ?? AUTOMATION_DEFAULTS.maxRunsPerWindow,
    windowMinutes: cfg?.windowMinutes ?? AUTOMATION_DEFAULTS.windowMinutes,
    maxPerWorkspace: cfg?.maxPerWorkspace ?? AUTOMATION_DEFAULTS.maxPerWorkspace,
  };
}
