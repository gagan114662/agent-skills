/**
 * Persistence seam for the community participation agent (issue #597). Narrow interface the service writes
 * through: create a queued record, read it back, list a workspace's records, read a community's recent records
 * (the history the gate weighs), and apply a post-outcome patch. The production binding is the self-managed
 * Postgres store in `default.ts`; unit tests inject {@link InMemoryParticipationStore}, so the service is tested
 * with no database (the proven pure-core + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's records — the #3 IDOR boundary.
 */

import type {
  CommunityPlatform,
  ParticipationRecord,
  ParticipationStatus,
} from "./types.js";

/** Fields captured when a reply is first queued (after it passed the gate, before any approval or post). */
export interface CreateParticipationInput {
  workspaceId: string;
  platform: CommunityPlatform;
  communityRef: string;
  threadId: string;
  threadTitle: string;
  body: string;
  mentionsProduct: boolean;
  relevance: number;
}

/** The outcome patch applied after an approved post attempt (transition out of `queued`). */
export interface ParticipationOutcomePatch {
  status: ParticipationStatus;
  approvalRequestId: string;
  externalId: string | null;
  error: string | null;
  updatedAt: Date;
}

export interface ParticipationStore {
  /** Append a new `queued` participation record. */
  create(input: CreateParticipationInput, now: Date): Promise<ParticipationRecord>;
  /** Load one record within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<ParticipationRecord | null>;
  /** A workspace's records, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: ParticipationStatus): Promise<ParticipationRecord[]>;
  /**
   * The most recent `posted` records in one community (for the gate's promo-ratio / rate-limit / cooldown math),
   * newest first, capped at `limit`.
   */
  recentPosted(
    workspaceId: string,
    platform: CommunityPlatform,
    communityRef: string,
    limit: number,
  ): Promise<ParticipationRecord[]>;
  /**
   * Apply a post outcome to a still-`queued` record. The store enforces the `queued` precondition atomically — a
   * no-op returning `null` if the row is missing or already actioned (so a post can never run twice).
   */
  applyOutcome(
    workspaceId: string,
    id: string,
    patch: ParticipationOutcomePatch,
  ): Promise<ParticipationRecord | null>;
}

/**
 * In-memory {@link ParticipationStore} for unit tests. Deterministic: ids are a monotonic counter and the clock
 * is injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryParticipationStore implements ParticipationStore {
  private readonly rows = new Map<string, ParticipationRecord>();
  private seq = 0;

  async create(input: CreateParticipationInput, now: Date): Promise<ParticipationRecord> {
    const id = `cp-${++this.seq}`;
    const row: ParticipationRecord = {
      id,
      workspaceId: input.workspaceId,
      platform: input.platform,
      communityRef: input.communityRef,
      threadId: input.threadId,
      threadTitle: input.threadTitle,
      body: input.body,
      mentionsProduct: input.mentionsProduct,
      relevance: input.relevance,
      status: "queued",
      approvalRequestId: null,
      externalId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async get(workspaceId: string, id: string): Promise<ParticipationRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? { ...row } : null;
  }

  async list(workspaceId: string, status?: ParticipationStatus): Promise<ParticipationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => ({ ...r }));
  }

  async recentPosted(
    workspaceId: string,
    platform: CommunityPlatform,
    communityRef: string,
    limit: number,
  ): Promise<ParticipationRecord[]> {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.workspaceId === workspaceId &&
          r.platform === platform &&
          r.communityRef === communityRef &&
          r.status === "posted",
      )
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime() || b.id.localeCompare(a.id))
      .slice(0, Math.max(0, limit))
      .map((r) => ({ ...r }));
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: ParticipationOutcomePatch,
  ): Promise<ParticipationRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "queued") return null;
    const next: ParticipationRecord = {
      ...row,
      status: patch.status,
      approvalRequestId: patch.approvalRequestId,
      externalId: patch.externalId,
      error: patch.error,
      updatedAt: patch.updatedAt,
    };
    this.rows.set(id, next);
    return { ...next };
  }
}
