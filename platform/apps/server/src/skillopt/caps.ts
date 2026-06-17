/**
 * SkillOpt-Sleep policy resolution (#283, ADR-0283) — mirrors `venture/caps.ts`. The loop is a capability
 * that can change how an agent behaves in a workspace, so it ships **default OFF**, owner-workspace-first
 * (premortem #200 §4 + the issue's "default OFF behind a flag, owner workspace first"): a deployment that
 * sets no `skillopt` block runs no cycle and stages nothing. Even when `enabled`, an `ownerWorkspaceOnly`
 * deployment (the default) only runs for the named owner workspace. Pure ⇒ unit-testable.
 */
import type { SkillOptConfig } from "../config/schema.js";

export interface SkillOptCaps {
  /** Master flag for the offline self-improvement cycle. OFF by default. */
  enabled: boolean;
  /**
   * Roll out owner-workspace-first (the default): when true, the loop only runs for `ownerWorkspaceId` even
   * if `enabled`; every other tenant is untouched. Set false to run for all tenants.
   */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the loop dogfoods here first. */
  ownerWorkspaceId: string | undefined;
  /** Minimum occurrences for a task to count as recurring (mining). */
  minRecurrence: number;
  /** Minimum held-out replay size for a validation reading to count (gate). */
  minSampleSize: number;
  /** Minimum relative improvement over baseline to stage a proposal (gate). */
  minImprovementRatio: number;
  /** Max chars for a single bounded skill-doc append (proposal). */
  maxAppendChars: number;
}

export const SKILLOPT_DEFAULTS: SkillOptCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  minRecurrence: 3,
  minSampleSize: 5,
  minImprovementRatio: 0.05,
  maxAppendChars: 600,
};

export function resolveSkillOptCaps(cfg: SkillOptConfig | undefined): SkillOptCaps {
  return {
    enabled: cfg?.enabled ?? SKILLOPT_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? SKILLOPT_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? SKILLOPT_DEFAULTS.ownerWorkspaceId,
    minRecurrence: cfg?.minRecurrence ?? SKILLOPT_DEFAULTS.minRecurrence,
    minSampleSize: cfg?.minSampleSize ?? SKILLOPT_DEFAULTS.minSampleSize,
    minImprovementRatio: cfg?.minImprovementRatio ?? SKILLOPT_DEFAULTS.minImprovementRatio,
    maxAppendChars: cfg?.maxAppendChars ?? SKILLOPT_DEFAULTS.maxAppendChars,
  };
}

/**
 * Pure: is the loop ENABLED for this specific workspace? Default OFF, owner-workspace-first — even when the
 * master `enabled` flag is on, an `ownerWorkspaceOnly` deployment (the default) only runs for the named
 * owner workspace; turning `enabled` on WITHOUT naming the owner runs for nobody (the safest default,
 * matching `venture`/`delivery`). Set `ownerWorkspaceOnly` false to run for all tenants.
 */
export function isSkillOptEnabledForWorkspace(caps: SkillOptCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
