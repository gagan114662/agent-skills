/**
 * Daily agent standup digest — the **persistence seam** (issue #589).
 *
 * The narrow interface the service consumes to persist and read back generated digests. A digest is keyed by
 * `${workspaceId}:${day}`, so re-generating the same day upserts rather than duplicating — daily digests are
 * idempotent. Everything is workspace-scoped (the `workspaceId` is the first argument of every read) so a
 * caller can only ever see its own tenant's digests — the #3 IDOR boundary.
 *
 * The production binding is the self-managed Postgres store in `standup-digest/default.ts`; unit tests inject
 * {@link InMemoryStandupDigestStore}, so the service is tested with no database (the #17
 * pure-decision + injected-seam pattern).
 */

import type { DailyDigest, DigestPeriod } from "./types.js";

/** A persisted digest: the synthesized {@link DailyDigest} plus its identity and generation timestamp. */
export interface StandupDigestRecord {
  /** `${workspaceId}:${day}` — stable per workspace-day (upsert key). */
  id: string;
  workspaceId: string;
  period: DigestPeriod;
  digest: DailyDigest;
  /** When the digest was generated (caller-supplied; the service injects its clock). */
  generatedAt: Date;
}

export interface StandupDigestStore {
  /** Persist a digest (upsert by {@link StandupDigestRecord.id}). Returns the saved record. */
  save(record: StandupDigestRecord): Promise<StandupDigestRecord>;
  /** Load one digest by id (scoped to the workspace); null if absent. */
  get(workspaceId: string, id: string): Promise<StandupDigestRecord | null>;
  /** A workspace's digests, newest day first. */
  list(workspaceId: string): Promise<StandupDigestRecord[]>;
  /** The most recent digest for a workspace (by day), or null if none yet. */
  latest(workspaceId: string): Promise<StandupDigestRecord | null>;
}

/** Build the stable upsert id for a workspace-day. */
export function digestId(workspaceId: string, day: string): string {
  return `${workspaceId}:${day}`;
}

/** Newest-day-first comparator (descending by `day`; lexicographic on ISO dates = chronological). */
function byDayDesc(a: StandupDigestRecord, b: StandupDigestRecord): number {
  return a.period.day < b.period.day ? 1 : a.period.day > b.period.day ? -1 : 0;
}

/**
 * In-memory {@link StandupDigestStore} for unit tests. Deterministic: no clock or id generation of its own —
 * the caller supplies `id` and `generatedAt`, so a test never depends on wall-clock time.
 */
export class InMemoryStandupDigestStore implements StandupDigestStore {
  private readonly records = new Map<string, StandupDigestRecord>();

  async save(record: StandupDigestRecord): Promise<StandupDigestRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async get(workspaceId: string, id: string): Promise<StandupDigestRecord | null> {
    const rec = this.records.get(id);
    return rec && rec.workspaceId === workspaceId ? rec : null;
  }

  async list(workspaceId: string): Promise<StandupDigestRecord[]> {
    return [...this.records.values()].filter((r) => r.workspaceId === workspaceId).sort(byDayDesc);
  }

  async latest(workspaceId: string): Promise<StandupDigestRecord | null> {
    const all = await this.list(workspaceId);
    return all[0] ?? null;
  }
}
