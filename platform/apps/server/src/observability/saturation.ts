import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Saturation signals + the pure verdict (#113, ADR-0113). The four signals that predict a melting box
 * — **queue depth** (admission in-flight), **event-loop lag**, **PG pool wait**, and **Redis ping
 * latency** — sampled at scrape time and classified into `ok | warn | critical`. `classifySaturation`
 * is pure (the testable gate that feeds the #112 alerts and is the seam the #105 watchdog can consult);
 * `collectSaturation` is the thin IO seam wired in `app.ts` over `getPool()` / `getRedis()` / admission.
 */

export interface PgPoolStats {
  total: number;
  idle: number;
  waiting: number;
}

/** One scrape-time saturation reading. `redisLatencySeconds` is null when Redis is absent/unreachable. */
export interface SaturationSample {
  /** Sessions the whole fleet currently has in flight (the admission "work queue"). */
  queueDepth: number;
  /** Mean event-loop delay (seconds) since boot — the headroom signal for a CPU-bound box. */
  eventLoopLagSeconds: number;
  pgPool: PgPoolStats;
  /** `PING` round-trip in seconds, or null when Redis could not be reached (degraded, not a breach). */
  redisLatencySeconds: number | null;
}

export interface SaturationThresholds {
  queueDepthWarn: number;
  queueDepthCritical: number;
  eventLoopLagWarnSeconds: number;
  eventLoopLagCriticalSeconds: number;
  pgPoolWaitingWarn: number;
  pgPoolWaitingCritical: number;
  redisLatencyWarnSeconds: number;
  redisLatencyCriticalSeconds: number;
}

/**
 * Defaults tuned for a fast single-box JSON API: any pool waiter is a warn (the pool is the scarcest
 * resource), 50ms event-loop lag is a warn, 200ms critical. These mirror the alert rules in
 * `observability/alerts.yml`.
 */
export const DEFAULT_SATURATION_THRESHOLDS: SaturationThresholds = {
  queueDepthWarn: 50,
  queueDepthCritical: 200,
  eventLoopLagWarnSeconds: 0.05,
  eventLoopLagCriticalSeconds: 0.2,
  pgPoolWaitingWarn: 1,
  pgPoolWaitingCritical: 5,
  redisLatencyWarnSeconds: 0.05,
  redisLatencyCriticalSeconds: 0.25,
};

export type SaturationLevel = "ok" | "warn" | "critical";

export interface SaturationStatus {
  /** The worst signal's level (the box's overall health). */
  level: SaturationLevel;
  /** One human-readable reason per signal that is warn/critical, in evaluation order. */
  reasons: string[];
}

const LEVEL_RANK: Record<SaturationLevel, number> = { ok: 0, warn: 1, critical: 2 };

/** Classify one signal against its warn/critical thresholds. */
function level(value: number, warn: number, critical: number): SaturationLevel {
  if (value >= critical) return "critical";
  if (value >= warn) return "warn";
  return "ok";
}

/**
 * Map a sample to a verdict. Pure + deterministic. The overall level is the **worst** signal; each
 * warn/critical signal contributes a reason. A null Redis latency is skipped entirely (degraded ≠
 * breach) so a missing Redis never manufactures a critical.
 */
export function classifySaturation(
  sample: SaturationSample,
  thresholds: SaturationThresholds,
): SaturationStatus {
  const reasons: string[] = [];
  let worst: SaturationLevel = "ok";

  const consider = (lvl: SaturationLevel, reason: string): void => {
    if (lvl === "ok") return;
    reasons.push(`${reason} (${lvl})`);
    if (LEVEL_RANK[lvl] > LEVEL_RANK[worst]) worst = lvl;
  };

  consider(
    level(sample.queueDepth, thresholds.queueDepthWarn, thresholds.queueDepthCritical),
    `queue depth ${sample.queueDepth}`,
  );
  consider(
    level(
      sample.eventLoopLagSeconds,
      thresholds.eventLoopLagWarnSeconds,
      thresholds.eventLoopLagCriticalSeconds,
    ),
    `event-loop lag ${(sample.eventLoopLagSeconds * 1000).toFixed(1)}ms`,
  );
  consider(
    level(sample.pgPool.waiting, thresholds.pgPoolWaitingWarn, thresholds.pgPoolWaitingCritical),
    `PG pool waiting ${sample.pgPool.waiting}`,
  );
  if (sample.redisLatencySeconds !== null) {
    consider(
      level(
        sample.redisLatencySeconds,
        thresholds.redisLatencyWarnSeconds,
        thresholds.redisLatencyCriticalSeconds,
      ),
      `Redis latency ${(sample.redisLatencySeconds * 1000).toFixed(1)}ms`,
    );
  }

  return { level: worst, reasons };
}

// --- event-loop monitor (process singleton) ---------------------------------------------------
// One histogram for the whole process, enabled lazily on first read. `.mean` is in nanoseconds.

let eldHistogram: IntervalHistogram | undefined;

/** Mean event-loop delay in seconds since the monitor was first read. Lazily enables the monitor. */
export function eventLoopLagSeconds(): number {
  if (!eldHistogram) {
    eldHistogram = monitorEventLoopDelay({ resolution: 20 });
    eldHistogram.enable();
  }
  const mean = eldHistogram.mean;
  // `mean` is NaN until the first sampling interval elapses — report 0 rather than NaN.
  return Number.isFinite(mean) ? mean / 1e9 : 0;
}

/** The IO seam the scrape handler drives; all sources injected so the assembly is unit-testable. */
export interface SaturationCollectorDeps {
  /** Admission global in-flight (the work queue depth). */
  queueDepth(): number;
  /** Live pg pool counters (`getPool().{totalCount,idleCount,waitingCount}`). */
  pgPoolStats(): PgPoolStats;
  /** Timed `PING` in seconds, or null when Redis is unreachable. */
  redisPing(): Promise<number | null>;
}

/** Assemble a {@link SaturationSample} from the injected sources + the process event-loop monitor. */
export async function collectSaturation(deps: SaturationCollectorDeps): Promise<SaturationSample> {
  const [queueDepth, pgPool, redisLatencySeconds] = [
    deps.queueDepth(),
    deps.pgPoolStats(),
    await deps.redisPing(),
  ];
  return {
    queueDepth,
    eventLoopLagSeconds: eventLoopLagSeconds(),
    pgPool,
    redisLatencySeconds,
  };
}
