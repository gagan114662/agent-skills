import type { ScheduleSpec } from "./types.js";

/**
 * The pure scheduler (#147, ADR-0147 §3). `computeNextRun` is a function of a JSON cadence + a clock —
 * no wall-clock, no cron library — so it is fully unit-testable and #152 can widen the cadence enum
 * without touching the engine. All arithmetic is UTC (the platform has no per-tenant timezone yet).
 */

const MINUTE_MS = 60_000;

function clampInt(value: number | undefined, lo: number, hi: number, dflt: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : dflt;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * The next time this schedule should fire strictly after `from`. Returns `null` for an unknown cadence
 * (a guard — the schema validates the cadence, so this is defensive). The returned instant is always
 * `> from` so a tick that runs exactly at the boundary advances the cursor instead of re-firing.
 */
export function computeNextRun(schedule: ScheduleSpec, from: Date): Date | null {
  switch (schedule.cadence) {
    case "interval": {
      const everyMinutes = clampInt(schedule.everyMinutes, 1, 60 * 24 * 365, 60);
      return new Date(from.getTime() + everyMinutes * MINUTE_MS);
    }
    case "hourly": {
      const minute = clampInt(schedule.minute, 0, 59, 0);
      const next = new Date(from.getTime());
      next.setUTCMinutes(minute, 0, 0);
      if (next.getTime() <= from.getTime()) next.setUTCHours(next.getUTCHours() + 1);
      return next;
    }
    case "daily": {
      const hour = clampInt(schedule.hour, 0, 23, 0);
      const minute = clampInt(schedule.minute, 0, 59, 0);
      const next = new Date(from.getTime());
      next.setUTCHours(hour, minute, 0, 0);
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
      return next;
    }
    case "weekly": {
      const dayOfWeek = clampInt(schedule.dayOfWeek, 0, 6, 0);
      const hour = clampInt(schedule.hour, 0, 23, 0);
      const minute = clampInt(schedule.minute, 0, 59, 0);
      const next = new Date(from.getTime());
      next.setUTCHours(hour, minute, 0, 0);
      // Advance to the target weekday (0–6 days forward); if that lands at/before `from`, push a week.
      const dayDelta = (dayOfWeek - next.getUTCDay() + 7) % 7;
      next.setUTCDate(next.getUTCDate() + dayDelta);
      if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 7);
      return next;
    }
    default:
      return null;
  }
}

/** Whether a scheduled automation whose cursor is `nextRunAt` is due at `now`. Null cursor ⇒ not due. */
export function isDue(nextRunAt: Date | null, now: Date): boolean {
  return nextRunAt !== null && nextRunAt.getTime() <= now.getTime();
}
