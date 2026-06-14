import { loadConfig } from "../config/loader.js";
import { createDefaultGrowthService } from "../growth/default.js";
import type { GrowthService } from "../growth/service.js";
import {
  dbPipelineStore,
  dbPqlStore,
  dbSignalDefStore,
  dbSignalStore,
} from "../db/repositories/discovery.js";
import { resolveDiscoveryCaps } from "./caps.js";
import { DiscoveryService, type GrowthEmitter } from "./service.js";

/**
 * Production wiring for the Customer Discovery Engine (#222, ADR-0222). Binds the pure rank/qualify/
 * pipeline core to the real `discovery_*` repos and bridges the growth funnel (#102) so the founder-
 * console growth panel (#104) lights up with event-driven counts. The growth bridge reuses the SAME
 * `GrowthService.recordEvent` the routes use (the only writer of `growth_events`), so the console score
 * stays consistent. Read-only: this service never sends.
 */
export function createDefaultDiscoveryService(
  opts: { growth?: GrowthService } = {},
): DiscoveryService {
  const growth = opts.growth ?? createDefaultGrowthService();
  const emitter: GrowthEmitter = {
    record: async (workspaceId, input) => {
      await growth.recordEvent(workspaceId, {
        ideaId: input.ideaId,
        kind: input.kind,
        source: input.source,
        value: input.value,
        metadata: input.metadata,
      });
    },
  };
  return new DiscoveryService({
    signals: dbSignalStore,
    defs: dbSignalDefStore,
    pqls: dbPqlStore,
    pipeline: dbPipelineStore,
    growth: emitter,
    caps: (wid) => resolveDiscoveryCaps(loadConfig(wid).discovery),
  });
}
