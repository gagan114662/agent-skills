/**
 * Persistence seam for the short-form video agent (#740). The narrow interface the service consumes — save a
 * generation-attempt record and read it back. The production binding is the self-managed Postgres store in
 * `default.ts`; unit tests inject {@link InMemoryVideoJobStore}, so the service is tested with no database
 * (the #588/#670 pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` lives on every record and on every list query) so a
 * caller can only ever read its own tenant's jobs — the #3 IDOR boundary.
 */

import type { VideoJobRecord } from "./types.js";

export interface VideoJobStore {
  /** Persist a generation-attempt record. Returns the saved record. */
  save(record: VideoJobRecord): Promise<VideoJobRecord>;
  /** Read one record by id, scoped to its workspace. Null when absent or owned by another workspace. */
  get(workspaceId: string, id: string): Promise<VideoJobRecord | null>;
  /** List a workspace's records, newest first. */
  listByWorkspace(workspaceId: string, limit?: number): Promise<VideoJobRecord[]>;
}

/** Defensive deep-ish copy so a caller mutating a returned record never corrupts the in-memory store. */
function clone(record: VideoJobRecord): VideoJobRecord {
  return {
    ...record,
    script: record.script
      ? { ...record.script, scenes: record.script.scenes.map((s) => ({ ...s })), hashtags: [...record.script.hashtags] }
      : null,
    video: record.video ? { ...record.video } : null,
  };
}

/**
 * In-memory {@link VideoJobStore} for unit tests. Deterministic: no clock or id generation of its own — the
 * caller supplies the record (id + timestamp), so a test never depends on wall-clock time. Insertion order is
 * preserved so `listByWorkspace` can return newest-first without a sort on equal timestamps.
 */
export class InMemoryVideoJobStore implements VideoJobStore {
  private readonly records: VideoJobRecord[] = [];

  async save(record: VideoJobRecord): Promise<VideoJobRecord> {
    this.records.push(clone(record));
    return clone(record);
  }

  async get(workspaceId: string, id: string): Promise<VideoJobRecord | null> {
    const found = this.records.find((r) => r.id === id && r.workspaceId === workspaceId);
    return found ? clone(found) : null;
  }

  async listByWorkspace(workspaceId: string, limit = 50): Promise<VideoJobRecord[]> {
    return this.records
      .filter((r) => r.workspaceId === workspaceId)
      .slice()
      .reverse()
      .slice(0, limit)
      .map(clone);
  }
}
