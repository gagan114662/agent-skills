/**
 * Full-funnel instrumentation service (#604).
 *
 * The orchestrator the funnel layer runs through: it binds the pure schema/aggregator to the injected
 * {@link FunnelEventStore} so it is unit-testable with the in-memory store and no DB. Two jobs, matching the
 * acceptance criteria:
 *
 *  1. {@link track} — the ONE ingest door for both the marketing site and the product. A raw payload is
 *     validated + normalized by {@link normalizeFunnelEvent} (consistent schema, bad events rejected here),
 *     then appended. Recording is harmless + tenant-scoped, so — like the #102 growth loop — it is always
 *     available; no flag gates it.
 *  2. {@link view} — the ONE funnel view for a workspace over a trailing window: per-stage counts, the
 *     stage-to-stage conversion rates, and the same funnel broken down by channel and by agent.
 */

import { aggregateFunnel, type FunnelView } from "./aggregate.js";
import { normalizeFunnelEvent, type FunnelEvent, type RawFunnelEvent } from "./schema.js";
import type { FunnelEventStore } from "./store.js";

export interface FunnelServiceDeps {
  store: FunnelEventStore;
  /** Injectable clock for deterministic tests + window math. */
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export class FunnelService {
  private readonly store: FunnelEventStore;
  private readonly now: () => number;

  constructor(deps: FunnelServiceDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Validate, normalize, and record one funnel event for a workspace. Returns the normalized event so a
   * caller can echo back exactly what was stored. Throws (recording nothing) on an invalid stage/surface/
   * value — the consistent schema is enforced at the door.
   */
  async track(workspaceId: string, raw: RawFunnelEvent): Promise<FunnelEvent> {
    const event = normalizeFunnelEvent(workspaceId, raw, this.now);
    await this.store.append(event);
    return event;
  }

  /**
   * The one funnel view for a workspace. `windowDays` (when > 0) limits to events in the trailing window;
   * omitted ⇒ full history. Always returns a complete (possibly all-zero) view — never null.
   */
  async view(workspaceId: string, windowDays?: number): Promise<FunnelView> {
    const sinceMs = windowDays && windowDays > 0 ? this.now() - windowDays * DAY_MS : 0;
    const events = await this.store.list(workspaceId, sinceMs);
    return aggregateFunnel(events);
  }
}
