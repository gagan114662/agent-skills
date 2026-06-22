/**
 * Full-funnel event store seam (#604).
 *
 * The persistence boundary the {@link FunnelService} writes/reads through. Deliberately a small injected
 * interface (the #270 `AnalyticsInstallStore` pattern) so the funnel layer ships **without a new DB
 * migration or schema-barrel edit** — keeping it merge-safe alongside parallel work — while leaving a clean
 * seam for a future durable backing (a `funnel_events` table) to drop in behind the same contract.
 *
 * The default {@link InMemoryFunnelEventStore} is process-local and tenant-scoped: appends are O(1) and a
 * window read filters by `occurredAt`. Recording a funnel event is harmless and produces no egress, so —
 * exactly like the #102 growth loop — ingest is always available; no flag gates it.
 */

import type { FunnelEvent } from "./schema.js";

/** Persist + read funnel events, always scoped to one workspace (#3 tenant isolation). */
export interface FunnelEventStore {
  /** Append one normalized event. */
  append(event: FunnelEvent): Promise<void>;
  /**
   * Read a workspace's events occurring at/after `sinceMs` (epoch ms). `sinceMs <= 0` (or absent) reads the
   * full history. Returns a fresh array the caller may sort/aggregate freely.
   */
  list(workspaceId: string, sinceMs?: number): Promise<FunnelEvent[]>;
}

/** Process-local, tenant-partitioned store. Default backing for the funnel layer (no DB migration). */
export class InMemoryFunnelEventStore implements FunnelEventStore {
  private readonly byWorkspace = new Map<string, FunnelEvent[]>();

  async append(event: FunnelEvent): Promise<void> {
    const bucket = this.byWorkspace.get(event.workspaceId);
    if (bucket) bucket.push(event);
    else this.byWorkspace.set(event.workspaceId, [event]);
  }

  async list(workspaceId: string, sinceMs = 0): Promise<FunnelEvent[]> {
    const bucket = this.byWorkspace.get(workspaceId) ?? [];
    if (sinceMs <= 0) return [...bucket];
    return bucket.filter((e) => e.occurredAt.getTime() >= sinceMs);
  }
}
