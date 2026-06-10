import type { SreConfig } from "../config/schema.js";
import type { SloTarget } from "./types.js";

/**
 * Resolve the SRE-loop policy from the layered config (#58), applying hard defaults — mirrors
 * `watchdog/caps.ts` and `venture/caps.ts`. The loop is **default OFF** (`enabled: false`): a
 * deployment that sets no `sre` section keeps today's behavior (no SLO evaluation, no incidents), and
 * the background timer is also default-off (`SRE_INTERVAL_MS = 0`).
 */

/** One service's resolved SLO targets (the per-dimension targets built from its config). */
export interface ResolvedSloService {
  service: string;
  targets: SloTarget[];
}

export interface SreCaps {
  /** The on-call loop flag. OFF by default. */
  enabled: boolean;
  /** Minimum time (ms) between re-page notifications for one sustained breach (the cooldown). */
  cooldownMs: number;
  /** The per-service SLO targets to evaluate (empty ⇒ nothing to evaluate). */
  services: ResolvedSloService[];
}

export const SRE_DEFAULTS = {
  enabled: false,
  cooldownMs: 15 * 60_000, // re-page at most every 15 min on a sustained breach
} as const;

export function resolveSreCaps(cfg: SreConfig | undefined): SreCaps {
  const services: ResolvedSloService[] = [];
  for (const svc of cfg?.services ?? []) {
    const targets: SloTarget[] = [];
    if (svc.availabilityTarget !== undefined) {
      targets.push({ kind: "availability", target: svc.availabilityTarget });
    }
    if (svc.latencyP95Ms !== undefined) {
      targets.push({ kind: "latency_p95", target: svc.latencyP95Ms });
    }
    if (svc.queueLagSeconds !== undefined) {
      targets.push({ kind: "queue_lag", target: svc.queueLagSeconds });
    }
    // A service that declares no dimension is a no-op — drop it so the engine never iterates it.
    if (targets.length > 0) services.push({ service: svc.service, targets });
  }
  return {
    enabled: cfg?.enabled ?? SRE_DEFAULTS.enabled,
    cooldownMs: cfg?.cooldownMs ?? SRE_DEFAULTS.cooldownMs,
    services,
  };
}
