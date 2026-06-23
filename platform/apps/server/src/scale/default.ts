import type { ResolvedConfig } from "../config/schema.js";
import { loadConfig } from "../config/loader.js";
import { getControls } from "../db/repositories/autonomy.js";
import { usageStore } from "../db/repositories/tenant-usage.js";
import { recordRegionPlacement } from "../observability/metrics.js";
import { Admission, type KillSwitchReader } from "./admission.js";
import { resolveScaleCaps } from "./caps.js";
import {
  estimateCostCents,
  windowKey,
  type UsageRecorder,
  type UsageStore,
} from "./usage.js";

/**
 * Production wiring for cloud-scale (#71). The admission counters live on the server that owns the
 * session lifecycle (alongside the #25 SessionManager). Caps/budget come from the layered config
 * (#58), the kill switch from the #17 controls, and usage from the `tenant_usage` repo.
 */

/** Resolve a tenant's config (caps/budget/regions live in its managed/per-tenant layer). */
const tenantConfig = (workspaceId: string): ResolvedConfig => loadConfig(workspaceId);

/** The #17 kill switch as an admission seam — engaged when the tenant's controls have it set. */
const killSwitch: KillSwitchReader = {
  async isEngaged(workspaceId: string): Promise<boolean> {
    return (await getControls(workspaceId)).killSwitch;
  },
};

/**
 * Build the production {@link Admission}. `globalMax` is the fleet ceiling: a managed-global
 * `scale.globalConcurrency` if set, else the supplied env default (derived from `TEAM_MAX_CONCURRENCY`),
 * else 0 (unlimited).
 */
export function createAdmission(globalDefault: number): Admission {
  const serverScale = resolveServerScale();
  return new Admission({
    usage: usageStore,
    killSwitch,
    config: tenantConfig,
    globalMax: resolveGlobalConcurrencyCap(serverScale.globalConcurrency, globalDefault),
    onPlace: recordRegionPlacement,
  });
}

/** Resolve the fleet-wide launch ceiling. A positive managed cap wins; otherwise use the env fallback. */
export function resolveGlobalConcurrencyCap(managedGlobal: number | undefined, envDefault: number): number {
  return managedGlobal || envDefault || 0;
}

/** The managed-global scale block (no tenant) — for the fleet-wide ceiling. */
function resolveServerScale(): { globalConcurrency: number } {
  const scale = loadConfig().scale;
  return { globalConcurrency: scale?.globalConcurrency ?? 0 };
}

/**
 * Wrap a {@link UsageStore} as the narrow {@link UsageRecorder} the SessionManager consumes: it
 * supplies the current window and turns compute-seconds into an estimated cost using the tenant's
 * configured rate. Injectable `config`/`now` keep it unit-testable without a DB or a real clock.
 */
export function createUsageRecorder(
  store: UsageStore,
  config: (workspaceId: string) => ResolvedConfig,
  now: () => Date = () => new Date(),
): UsageRecorder {
  return {
    recordStart(workspaceId: string): Promise<void> {
      return store.recordStart(workspaceId, windowKey(now()));
    },
    recordCompute(workspaceId: string, computeSeconds: number): Promise<void> {
      const rate = resolveScaleCaps(config(workspaceId).scale).computeRateCentsPerMinute;
      const cost = estimateCostCents(computeSeconds, rate);
      return store.recordCompute(workspaceId, windowKey(now()), computeSeconds, cost);
    },
  };
}

/** The production usage recorder (repo-backed store + layered config + real clock). */
export function createDefaultUsageRecorder(): UsageRecorder {
  return createUsageRecorder(usageStore, tenantConfig);
}

/**
 * The cloud-scale runtime bundle (#71): one {@link Admission} (whose in-memory counters the
 * SessionManager mutates and the usage route reads — they MUST be the same instance) + the usage
 * recorder. `globalDefault` is the fleet ceiling fallback when config sets none.
 */
export interface Scale {
  admission: Admission;
  usage: UsageRecorder;
  /** The tenant-config source — the SAME one admission enforces, so the usage route shows real caps. */
  config: (workspaceId: string) => ResolvedConfig;
}

export function createScale(globalDefault = 0): Scale {
  return {
    admission: createAdmission(globalDefault),
    usage: createDefaultUsageRecorder(),
    config: tenantConfig,
  };
}
