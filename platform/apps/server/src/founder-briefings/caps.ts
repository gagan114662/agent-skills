import type { BriefingsConfig } from "../config/schema.js";
import type { EscalationThresholds } from "./aggregate.js";

/**
 * Resolve the Founder Briefings policy from the layered config (#58), applying hard defaults — mirrors
 * `portfolio/caps.ts` / `moat/caps.ts`. The feature is **default OFF** (`enabled: false`): a deployment
 * that sets no `briefings` block keeps today's behavior — the read routes still render a brief on demand
 * (harmless, tenant-scoped) but NOTHING is delivered and the scheduled tick never sends. `enabled` is the
 * master switch for *delivery* + the tick; `daily`/`weekly` independently toggle each digest.
 *
 * The escalation thresholds (hours) parameterize the pure `escalationLevel` — a decision's level rises as
 * it ages past each one — so a stale owner-decision re-notifies on a rising schedule (#173 criterion 3).
 */
export interface BriefingsCaps {
  /** Master flag for delivery + the scheduled tick. OFF by default. */
  enabled: boolean;
  /** Whether the daily brief is delivered (when `enabled`). */
  daily: boolean;
  /** Whether the weekly founder report is delivered (when `enabled`). */
  weekly: boolean;
  /** Decision age (hours) at/above which it is level-1 stale. */
  staleLevel1Hours: number;
  /** Decision age (hours) at/above which it is level-2 stale. */
  staleLevel2Hours: number;
  /** Decision age (hours) at/above which it is level-3 stale (critical — the owner is the blocker). */
  staleLevel3Hours: number;
  /** Hard word budget for the daily brief (the "< 200 words" acceptance). */
  maxBriefWords: number;
  /** Hard word budget for the weekly digest. */
  maxReportWords: number;
  /** Top customer-voice signals surfaced in the weekly report. */
  digestVoiceLimit: number;
  /** Backlog items surfaced in the weekly report. */
  backlogLimit: number;
}

export const BRIEFINGS_DEFAULTS: BriefingsCaps = {
  enabled: false,
  daily: true,
  weekly: true,
  staleLevel1Hours: 24,
  staleLevel2Hours: 72,
  staleLevel3Hours: 168,
  maxBriefWords: 200,
  maxReportWords: 400,
  digestVoiceLimit: 5,
  backlogLimit: 5,
};

export function resolveBriefingsCaps(cfg: BriefingsConfig | undefined): BriefingsCaps {
  return {
    enabled: cfg?.enabled ?? BRIEFINGS_DEFAULTS.enabled,
    daily: cfg?.daily ?? BRIEFINGS_DEFAULTS.daily,
    weekly: cfg?.weekly ?? BRIEFINGS_DEFAULTS.weekly,
    staleLevel1Hours: cfg?.staleLevel1Hours ?? BRIEFINGS_DEFAULTS.staleLevel1Hours,
    staleLevel2Hours: cfg?.staleLevel2Hours ?? BRIEFINGS_DEFAULTS.staleLevel2Hours,
    staleLevel3Hours: cfg?.staleLevel3Hours ?? BRIEFINGS_DEFAULTS.staleLevel3Hours,
    maxBriefWords: cfg?.maxBriefWords ?? BRIEFINGS_DEFAULTS.maxBriefWords,
    maxReportWords: cfg?.maxReportWords ?? BRIEFINGS_DEFAULTS.maxReportWords,
    digestVoiceLimit: cfg?.digestVoiceLimit ?? BRIEFINGS_DEFAULTS.digestVoiceLimit,
    backlogLimit: cfg?.backlogLimit ?? BRIEFINGS_DEFAULTS.backlogLimit,
  };
}

/** The escalation thresholds in seconds, derived from the caps (hours → seconds) for the pure core. */
export function escalationThresholds(caps: BriefingsCaps): EscalationThresholds {
  return {
    level1Seconds: caps.staleLevel1Hours * 3600,
    level2Seconds: caps.staleLevel2Hours * 3600,
    level3Seconds: caps.staleLevel3Hours * 3600,
  };
}
