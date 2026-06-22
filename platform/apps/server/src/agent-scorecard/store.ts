/**
 * Persistence seam for the per-agent scorecard (issue #593). The service consumes a narrow interface: append
 * conversion events (idempotently — "updated as conversions land" implies the same event may arrive twice), upsert
 * the latest activity snapshot, and read both back for a workspace so the pure core can recompute the scorecard.
 *
 * The production binding is the self-managed Postgres store in `default.ts`; unit tests inject
 * {@link InMemoryScorecardStore}, so the service is tested with no database (the proven pure-core + injected-seam
 * pattern). Everything is workspace-scoped (the `workspaceId` is a column on every row and the first argument of
 * every read) so a caller can only ever touch its own tenant's data — the #3 IDOR boundary.
 */

import type { AgentActivity, ConversionEvent } from "./types.js";

export interface ScorecardStore {
  /**
   * Append conversion events, idempotent on (`workspaceId`, `eventId`): an event whose id already exists is
   * IGNORED (the ledger only grows, re-ingesting a feed is safe). Returns how many rows were newly inserted.
   */
  appendEvents(workspaceId: string, events: readonly ConversionEvent[]): Promise<number>;
  /**
   * Replace the activity snapshot for a workspace with `activities` (keyed per agent+channel). Activity is a
   * CURRENT-STATE figure, not an accumulating ledger, so the latest snapshot wins. Returns how many rows were written.
   */
  replaceActivity(workspaceId: string, activities: readonly AgentActivity[]): Promise<number>;
  /** All stored conversion events for a workspace (#3 IDOR scoping). */
  listEvents(workspaceId: string): Promise<ConversionEvent[]>;
  /** The current activity snapshot for a workspace. */
  listActivity(workspaceId: string): Promise<AgentActivity[]>;
}

/**
 * In-memory {@link ScorecardStore} for unit tests. Deterministic and self-contained: enforces the same
 * append-idempotency (on eventId) and activity replace-semantics as the Postgres binding.
 */
export class InMemoryScorecardStore implements ScorecardStore {
  /** workspaceId → (eventId → event). */
  private readonly events = new Map<string, Map<string, ConversionEvent>>();
  /** workspaceId → (agentId::channel → activity). */
  private readonly activity = new Map<string, Map<string, AgentActivity>>();

  async appendEvents(workspaceId: string, events: readonly ConversionEvent[]): Promise<number> {
    let bucket = this.events.get(workspaceId);
    if (!bucket) {
      bucket = new Map<string, ConversionEvent>();
      this.events.set(workspaceId, bucket);
    }
    let inserted = 0;
    for (const event of events) {
      if (bucket.has(event.eventId)) continue;
      bucket.set(event.eventId, { ...event });
      inserted += 1;
    }
    return inserted;
  }

  async replaceActivity(workspaceId: string, activities: readonly AgentActivity[]): Promise<number> {
    const bucket = new Map<string, AgentActivity>();
    for (const a of activities) {
      bucket.set(`${a.agentId}::${a.channel}`, { ...a });
    }
    this.activity.set(workspaceId, bucket);
    return bucket.size;
  }

  async listEvents(workspaceId: string): Promise<ConversionEvent[]> {
    return [...(this.events.get(workspaceId)?.values() ?? [])].map((e) => ({ ...e }));
  }

  async listActivity(workspaceId: string): Promise<AgentActivity[]> {
    return [...(this.activity.get(workspaceId)?.values() ?? [])].map((a) => ({ ...a }));
  }
}
