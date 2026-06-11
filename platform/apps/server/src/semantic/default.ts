/**
 * Production wiring for the semantic layer (#155, ADR-0155 §2). The default {@link MetricResolver} reads the
 * governed summaries that expose a clean workspace-level number — growth (score + venture signal) and usage
 * (current-window cost) — and returns a flagged `raw_data` answer for metrics that are venture-scoped at the
 * workspace level (demand/venture/moat), so the answer honestly says "no governed workspace number — scope
 * to a venture" rather than inventing one. As more governed workspace-level reads land, they slot in here
 * behind the same seam with no change to the service or route.
 */

import { SemanticLayerService, type MetricResolver } from "./service.js";
import { resolveFleetCaps } from "./caps.js";
import { loadConfig } from "../config/loader.js";
import { createDefaultGrowthService } from "../growth/default.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { windowKey } from "../scale/usage.js";
import type { ResolvedMetric } from "./answer.js";
import type { MetricDefinition } from "./catalog.js";

/** A flagged "no governed workspace-level number" result — the documented raw-data fallback. */
const RAW_FALLBACK: ResolvedMetric = { value: null, asOfMs: null, path: "raw_data" };

/**
 * The shared default resolver — reused by BOTH the semantic layer service and the eval service (so an eval
 * metric question is answered through the exact same governed path lens uses). One source of truth.
 */
export function createDefaultMetricResolver(): MetricResolver {
  const growth = createDefaultGrowthService();

  return {
    async resolve(workspaceId: string, def: MetricDefinition): Promise<ResolvedMetric> {
      const nowMs = Date.now();
      switch (def.id) {
        case "growth.score": {
          const s = await growth.summary(workspaceId);
          return { value: s.score, asOfMs: nowMs, path: "semantic_layer" };
        }
        case "growth.venture_signal": {
          const s = await growth.summary(workspaceId);
          return { value: s.ventureSignal, asOfMs: nowMs, path: "semantic_layer" };
        }
        case "usage.cost_cents": {
          const u = await getUsage(workspaceId, windowKey(new Date(nowMs)));
          return { value: u.estimatedCostCents, asOfMs: nowMs, path: "semantic_layer" };
        }
        // demand/venture/moat are venture-scoped — there is no single governed workspace-level number yet.
        // Flag it as a raw fallback so the answer says so out loud instead of fabricating one.
        default:
          return RAW_FALLBACK;
      }
    },
  };
}

export function createDefaultSemanticLayerService(): SemanticLayerService {
  return new SemanticLayerService({
    resolver: createDefaultMetricResolver(),
    caps: (workspaceId) => resolveFleetCaps(loadConfig(workspaceId).fleet),
  });
}
