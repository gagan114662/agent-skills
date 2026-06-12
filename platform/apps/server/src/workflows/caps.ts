import type { WorkflowsConfig } from "../config/schema.js";

/**
 * Resolve the per-tenant workflows policy from the layered config (#58), applying hard defaults —
 * mirrors `automations/caps.ts`. **Default OFF** (`enabled: false`): a deployment that sets no
 * `workflows` section never fires a workflow (creating one is still allowed — it simply never ticks),
 * and the background timer is also default-off (`WORKFLOWS_INTERVAL_MS = 0`).
 *
 * `windowMinutes` defaults to **1440 (a day)** so `maxRunsPerWindow` is literally the "caps on firings
 * per day" the issue requires. `maxActionsPerRun` bounds a single firing's fan-out.
 */
export interface WorkflowCaps {
  /** The workflows-tick flag. OFF by default. */
  enabled: boolean;
  /** Hard cap on firings per workspace inside `windowMinutes` (the per-day rate limit). */
  maxRunsPerWindow: number;
  /** The rate-limit window, in minutes (default 1440 = one day). */
  windowMinutes: number;
  /** Hard cap on workflow definitions a workspace may create. */
  maxPerWorkspace: number;
  /** Hard cap on actions executed in a single firing (bounds fan-out). */
  maxActionsPerRun: number;
}

export const WORKFLOW_DEFAULTS: WorkflowCaps = {
  enabled: false,
  maxRunsPerWindow: 50, // a generous default ceiling on firings per day
  windowMinutes: 1440, // one day — the "firings per day" cap
  maxPerWorkspace: 50,
  maxActionsPerRun: 10,
};

export function resolveWorkflowCaps(cfg: WorkflowsConfig | undefined): WorkflowCaps {
  return {
    enabled: cfg?.enabled ?? WORKFLOW_DEFAULTS.enabled,
    maxRunsPerWindow: cfg?.maxRunsPerWindow ?? WORKFLOW_DEFAULTS.maxRunsPerWindow,
    windowMinutes: cfg?.windowMinutes ?? WORKFLOW_DEFAULTS.windowMinutes,
    maxPerWorkspace: cfg?.maxPerWorkspace ?? WORKFLOW_DEFAULTS.maxPerWorkspace,
    maxActionsPerRun: cfg?.maxActionsPerRun ?? WORKFLOW_DEFAULTS.maxActionsPerRun,
  };
}
