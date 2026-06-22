/**
 * Persistence seam for the social publishing connectors module (issue #742). Narrow interface the service writes
 * through: create a queued record, read it back, list a workspace's records, and apply a publish-outcome patch.
 * The production binding is the self-managed Postgres store in `default.ts`; unit tests inject
 * {@link InMemoryPublishStore}, so the service is tested with no database (the proven pure-core + injected-seam
 * pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's records — the #3 IDOR boundary.
 */

import type { PublishAsset, PublishRecord, PublishStatus, SocialPlatform } from "./types.js";

/** Fields captured when a publish is first queued (before any approval or provider call). */
export interface CreatePublishInput {
  workspaceId: string;
  platform: SocialPlatform;
  asset: PublishAsset;
  caption: string;
  scheduleAt: Date | null;
}

/** The outcome patch applied after an approved publish attempt (transition out of `queued`). */
export interface PublishOutcomePatch {
  status: PublishStatus;
  approvalRequestId: string;
  externalId: string | null;
  error: string | null;
  updatedAt: Date;
}

export interface PublishStore {
  /** Append a new `queued` publish record. */
  create(input: CreatePublishInput, now: Date): Promise<PublishRecord>;
  /** Load one record within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<PublishRecord | null>;
  /** A workspace's records, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: PublishStatus): Promise<PublishRecord[]>;
  /**
   * Apply a publish outcome to a still-`queued` record. The store enforces the `queued` precondition atomically —
   * a no-op returning `null` if the row is missing or already actioned (so a publish can never run twice).
   */
  applyOutcome(workspaceId: string, id: string, patch: PublishOutcomePatch): Promise<PublishRecord | null>;
}

/**
 * In-memory {@link PublishStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryPublishStore implements PublishStore {
  private readonly rows = new Map<string, PublishRecord>();
  private seq = 0;

  async create(input: CreatePublishInput, now: Date): Promise<PublishRecord> {
    const id = `pub-${++this.seq}`;
    const row: PublishRecord = {
      id,
      workspaceId: input.workspaceId,
      platform: input.platform,
      asset: { ...input.asset },
      caption: input.caption,
      scheduleAt: input.scheduleAt,
      status: "queued",
      approvalRequestId: null,
      externalId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return this.clone(row);
  }

  async get(workspaceId: string, id: string): Promise<PublishRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? this.clone(row) : null;
  }

  async list(workspaceId: string, status?: PublishStatus): Promise<PublishRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => this.clone(r));
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: PublishOutcomePatch,
  ): Promise<PublishRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "queued") return null;
    const next: PublishRecord = {
      ...row,
      status: patch.status,
      approvalRequestId: patch.approvalRequestId,
      externalId: patch.externalId,
      error: patch.error,
      updatedAt: patch.updatedAt,
    };
    this.rows.set(id, next);
    return this.clone(next);
  }

  private clone(row: PublishRecord): PublishRecord {
    return { ...row, asset: { ...row.asset } };
  }
}
