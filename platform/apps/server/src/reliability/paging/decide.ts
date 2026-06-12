/**
 * Pure paging decision for the reliability surface (#148, ADR-0148). Given the incident's lifecycle
 * `kind`, severity, the owner's recent page volume, and the policy (quiet hours, rate limit, escalation
 * interval, ack state), decide whether a page is delivered — and why. No clock, no IO: the `now` and
 * all state are inputs, so every branch is a unit test. The IO `PagerService` (`reliability/pager`)
 * reads the page log + overlay to build this input and applies the verdict.
 *
 * Order (first match wins):
 *   1. disabled            — the master flag is off
 *   2. rate_limited        — the owner already got `maxPagesPerWindow` pages this window (caps noise,
 *                            even for critical — a sustained breach must not flood the inbox)
 *   3. resolved/recover    — closure pages: gated only by `pageOnResolve` (not by quiet hours)
 *   4. quiet_hours         — a non-critical page inside the quiet window is held (critical breaks through)
 *   5. repaged escalation  — acknowledged ⇒ stop; inside the escalation cooldown ⇒ hold; else re-page
 *   6. opened/down         — a fresh breach pages
 */

export type PageKind =
  | "opened"
  | "repaged"
  | "resolved"
  | "uptime_down"
  | "uptime_recover"
  | "selfqa_critical"; // #171: a critical self-QA finding — a fresh breach (falls through to "opened")
export type PageSeverity = "warning" | "critical";

/** A quiet-hours window in whole UTC hours. Wraps midnight when `start > end`; `start === end` ⇒ none. */
export interface QuietHours {
  startHourUtc: number;
  endHourUtc: number;
}

export interface PageInput {
  /** The reliability master flag (`reliability.enabled`). Off ⇒ never page. */
  enabled: boolean;
  /** The decision clock (injected; the page log's rate-limit window is computed against it upstream). */
  now: Date;
  kind: PageKind;
  severity: PageSeverity;
  /** Quiet-hours window, or null when none is configured. */
  quietHours: QuietHours | null;
  /** When the owner was last paged for this incident (the escalation cooldown reference); null = never. */
  lastPagedAt: Date | null;
  /** When the owner acknowledged this incident; non-null ⇒ the escalation re-page stops. */
  ackedAt: Date | null;
  /** Minimum ms between escalation re-pages for one unacked incident. */
  escalateAfterMs: number;
  /** Pages already delivered to the owner in the current rate-limit window. */
  recentPageCount: number;
  /** Hard cap on pages per window. */
  maxPagesPerWindow: number;
  /** Whether a `resolved`/`uptime_recover` closure page is sent. */
  pageOnResolve: boolean;
}

export interface PageDecision {
  deliver: boolean;
  reason: string;
}

/** True iff `hour` (0..23) falls inside the quiet window. `start === end` ⇒ empty window (never). */
export function inQuietHours(hour: number, window: QuietHours): boolean {
  const { startHourUtc: start, endHourUtc: end } = window;
  if (start === end) return false;
  if (start < end) return hour >= start && hour < end; // same-day window
  return hour >= start || hour < end; // wraps midnight
}

export function decidePage(input: PageInput): PageDecision {
  if (!input.enabled) return { deliver: false, reason: "disabled" };

  if (input.recentPageCount >= input.maxPagesPerWindow) {
    return { deliver: false, reason: "rate_limited" };
  }

  // Closure pages: good news the owner wants regardless of quiet hours; gated only by pageOnResolve.
  if (input.kind === "resolved" || input.kind === "uptime_recover") {
    return input.pageOnResolve
      ? { deliver: true, reason: "resolved" }
      : { deliver: false, reason: "resolve_suppressed" };
  }

  if (
    input.quietHours &&
    input.severity !== "critical" &&
    inQuietHours(input.now.getUTCHours(), input.quietHours)
  ) {
    return { deliver: false, reason: "quiet_hours" };
  }

  // A sustained-breach re-page: stop once acked, and only fire past the escalation interval.
  if (input.kind === "repaged") {
    if (input.ackedAt !== null) return { deliver: false, reason: "acknowledged" };
    if (
      input.lastPagedAt !== null &&
      input.now.getTime() - input.lastPagedAt.getTime() < input.escalateAfterMs
    ) {
      return { deliver: false, reason: "cooldown" };
    }
    return { deliver: true, reason: "escalation" };
  }

  // opened | uptime_down — a fresh breach.
  return { deliver: true, reason: "opened" };
}
