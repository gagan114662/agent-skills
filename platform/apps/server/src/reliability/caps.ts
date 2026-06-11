import type { ReliabilityConfig } from "../config/schema.js";
import type { QuietHours } from "./paging/decide.js";

/**
 * Resolve the reliability-surface policy from the layered config (#58), applying hard defaults —
 * mirrors `sre/caps.ts`. The surface is **default OFF** (`enabled: false`, `statusPageEnabled: false`):
 * a deployment that sets no `reliability` section keeps today's #112 behavior (one ops-channel post, no
 * owner pages, no public status page).
 */
export interface ReliabilityCaps {
  /** Master flag: owner paging + chat-native incidents + AI investigation. OFF by default. */
  enabled: boolean;
  /** The public `/status/:slug` page opt-in. OFF by default. */
  statusPageEnabled: boolean;
  /** Quiet-hours window, or null when not (fully) configured. */
  quietHours: QuietHours | null;
  /** Hard cap on owner pages per rolling hour. */
  maxPagesPerHour: number;
  /** Minimum ms between escalation re-pages for one unacked incident. */
  escalateAfterMs: number;
  /** Whether a resolved incident sends a closure page. */
  pageOnResolve: boolean;
  /** How far before an incident a deploy still counts as a likely cause (investigation window). */
  deployWindowMs: number;
  /** Sender address for email pages (display only). */
  emailFrom: string | null;
  /** The env-var NAME holding the SMTP URL the email transport reads (never a value). */
  smtpUrlVar: string | null;
}

export const RELIABILITY_DEFAULTS = {
  enabled: false,
  statusPageEnabled: false,
  maxPagesPerHour: 6,
  escalateAfterMs: 15 * 60_000,
  pageOnResolve: true,
  deployWindowMs: 30 * 60_000,
} as const;

export function resolveReliabilityCaps(cfg: ReliabilityConfig | undefined): ReliabilityCaps {
  const start = cfg?.quietHoursStartHourUtc;
  const end = cfg?.quietHoursEndHourUtc;
  // A quiet window needs both bounds AND a non-empty span (start === end ⇒ no window).
  const quietHours: QuietHours | null =
    start !== undefined && end !== undefined && start !== end
      ? { startHourUtc: start, endHourUtc: end }
      : null;

  return {
    enabled: cfg?.enabled ?? RELIABILITY_DEFAULTS.enabled,
    statusPageEnabled: cfg?.statusPageEnabled ?? RELIABILITY_DEFAULTS.statusPageEnabled,
    quietHours,
    maxPagesPerHour: cfg?.maxPagesPerHour ?? RELIABILITY_DEFAULTS.maxPagesPerHour,
    escalateAfterMs: cfg?.escalateAfterMs ?? RELIABILITY_DEFAULTS.escalateAfterMs,
    pageOnResolve: cfg?.pageOnResolve ?? RELIABILITY_DEFAULTS.pageOnResolve,
    deployWindowMs: cfg?.deployWindowMs ?? RELIABILITY_DEFAULTS.deployWindowMs,
    emailFrom: cfg?.emailFrom ?? null,
    smtpUrlVar: cfg?.smtpUrlVar ?? null,
  };
}
