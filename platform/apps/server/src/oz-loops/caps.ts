/**
 * Oz-loops policy resolution (#356, ADR-0356) — mirrors `skillopt/caps.ts`. The four engineering loops are
 * a capability that ingests untrusted issue/PR content and stages owner-gated proposals, so they ship
 * **default OFF**, owner-workspace-first (premortem #200 §4): a deployment that sets no `ozLoops` block runs
 * nothing. Even when `enabled`, an `ownerWorkspaceOnly` deployment (the default) only runs for the named
 * owner workspace; turning `enabled` on WITHOUT naming the owner runs for nobody (the safest default). Pure
 * ⇒ unit-testable.
 */
import type { OzLoopsConfig } from "../config/schema.js";

export interface OzLoopsCaps {
  /** Master flag for the triage/spec/review/pr-comment loops. OFF by default. */
  enabled: boolean;
  /** Roll out owner-workspace-first (default true): when true, only `ownerWorkspaceId` runs even if enabled. */
  ownerWorkspaceOnly: boolean;
  /** The owner's own workspace id — the loops dogfood here first. */
  ownerWorkspaceId: string | undefined;
  /** Max chars of an ingested free-text field (issue/comment body) processed. */
  maxFieldChars: number;
  /** Max chars of a diff scanned by the review loop. */
  maxDiffChars: number;
  /** Max findings emitted by the review loop. */
  maxFindings: number;
}

export const OZ_LOOPS_DEFAULTS: OzLoopsCaps = {
  enabled: false,
  ownerWorkspaceOnly: true,
  ownerWorkspaceId: undefined,
  maxFieldChars: 4000,
  maxDiffChars: 200_000,
  maxFindings: 25,
};

export function resolveOzLoopsCaps(cfg: OzLoopsConfig | undefined): OzLoopsCaps {
  return {
    enabled: cfg?.enabled ?? OZ_LOOPS_DEFAULTS.enabled,
    ownerWorkspaceOnly: cfg?.ownerWorkspaceOnly ?? OZ_LOOPS_DEFAULTS.ownerWorkspaceOnly,
    ownerWorkspaceId: cfg?.ownerWorkspaceId ?? OZ_LOOPS_DEFAULTS.ownerWorkspaceId,
    maxFieldChars: cfg?.maxFieldChars ?? OZ_LOOPS_DEFAULTS.maxFieldChars,
    maxDiffChars: cfg?.maxDiffChars ?? OZ_LOOPS_DEFAULTS.maxDiffChars,
    maxFindings: cfg?.maxFindings ?? OZ_LOOPS_DEFAULTS.maxFindings,
  };
}

/**
 * Pure: are the loops ENABLED for this specific workspace? Default OFF, owner-workspace-first — even when
 * the master `enabled` flag is on, an `ownerWorkspaceOnly` deployment (the default) only runs for the named
 * owner workspace; turning `enabled` on WITHOUT naming the owner runs for nobody (matches `skillopt`).
 */
export function isOzLoopsEnabledForWorkspace(caps: OzLoopsCaps, workspaceId: string): boolean {
  if (!caps.enabled) return false;
  if (!caps.ownerWorkspaceOnly) return true;
  return caps.ownerWorkspaceId !== undefined && caps.ownerWorkspaceId === workspaceId;
}
