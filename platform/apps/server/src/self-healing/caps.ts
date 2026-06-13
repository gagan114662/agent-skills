import type { SelfHealingConfig } from "../config/schema.js";

/**
 * Resolve the Self-Healing Ops policy from the layered config (#58), applying hard defaults — mirrors
 * `sre/caps.ts` and `watchdog/caps.ts`. The loop is **default OFF** (`enabled: false`) AND
 * **auto-remediation is independently off** (`autoRemediate: false`): a deployment that sets no
 * `selfHealing` section keeps today's behavior (no per-venture probes, no remediation), and even an
 * opted-in workspace only ever *escalates* until it explicitly turns on `autoRemediate`. Destructive
 * actions (rollback / scale) stay off and approval-gated by default; the owner opts in per action and
 * may pre-commit a bounded action to skip the gate (#200 §4). The background timer is also default-off
 * (`SELF_HEALING_INTERVAL_MS = 0`).
 */

export interface SelfHealingThresholds {
  /** Max acceptable error ratio (0..1) before the `error_rate` signal breaches. */
  errorRate: number;
  /** Max acceptable queue depth/backlog before the `queue_depth` signal breaches. */
  queueDepth: number;
}

export interface SelfHealingCaps {
  /** The self-healing loop flag. OFF by default. */
  enabled: boolean;
  /**
   * Dispatch remediation ACTIONS automatically. OFF by default: when off, every breach is simply
   * escalated to a human (#13) — the monitoring + console-red + postmortem still run, nothing acts.
   */
  autoRemediate: boolean;
  /** Per-venture breach thresholds. */
  thresholds: SelfHealingThresholds;
  /** Allow the reversible restart action to auto-run (default true — it has no lasting effect). */
  allowRestart: boolean;
  /** Allow rollback-to-last-green (destructive: changes what's live). Default OFF. */
  allowRollback: boolean;
  /** Allow scale-within-caps (destructive: spends money). Default OFF. */
  allowScale: boolean;
  /** Gate rollback/scale through a #13 approval (default true — destructive ⇒ human by default). */
  requireApprovalForDestructive: boolean;
  /** Owner pre-committed rollback as a bounded action: it may auto-run without an approval (#200 §4). */
  preCommitRollback: boolean;
  /** Owner pre-committed scale-within-caps as a bounded action: it may auto-run without an approval. */
  preCommitScale: boolean;
  /** Auto-remediation attempts before escalating to a human (retry-once ⇒ 1). */
  maxAutoAttempts: number;
}

export const SELF_HEALING_DEFAULTS = {
  enabled: false,
  autoRemediate: false,
  errorRate: 0.1, // 10% 5xx ratio
  queueDepth: 100,
  allowRestart: true,
  allowRollback: false,
  allowScale: false,
  requireApprovalForDestructive: true,
  preCommitRollback: false,
  preCommitScale: false,
  maxAutoAttempts: 1, // retry an auto action ONCE, then escalate (#193 AC3)
} as const;

export function resolveSelfHealingCaps(cfg: SelfHealingConfig | undefined): SelfHealingCaps {
  return {
    enabled: cfg?.enabled ?? SELF_HEALING_DEFAULTS.enabled,
    autoRemediate: cfg?.autoRemediate ?? SELF_HEALING_DEFAULTS.autoRemediate,
    thresholds: {
      errorRate: cfg?.errorRateThreshold ?? SELF_HEALING_DEFAULTS.errorRate,
      queueDepth: cfg?.queueDepthThreshold ?? SELF_HEALING_DEFAULTS.queueDepth,
    },
    allowRestart: cfg?.allowRestart ?? SELF_HEALING_DEFAULTS.allowRestart,
    allowRollback: cfg?.allowRollback ?? SELF_HEALING_DEFAULTS.allowRollback,
    allowScale: cfg?.allowScale ?? SELF_HEALING_DEFAULTS.allowScale,
    requireApprovalForDestructive:
      cfg?.requireApprovalForDestructive ?? SELF_HEALING_DEFAULTS.requireApprovalForDestructive,
    preCommitRollback: cfg?.preCommitRollback ?? SELF_HEALING_DEFAULTS.preCommitRollback,
    preCommitScale: cfg?.preCommitScale ?? SELF_HEALING_DEFAULTS.preCommitScale,
    maxAutoAttempts: cfg?.maxAutoAttempts ?? SELF_HEALING_DEFAULTS.maxAutoAttempts,
  };
}
