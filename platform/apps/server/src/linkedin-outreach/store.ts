/**
 * Persistence seam for the LinkedIn outreach agent module (issue #595). Narrow interface the service writes
 * through: create a drafted touch, read it back, list a workspace's touches, count today's sends (the daily-limit
 * gate), and apply a send-outcome patch. The production binding is the self-managed Postgres store in
 * `default.ts`; unit tests inject {@link InMemoryOutreachStore}, so the service is tested with no database (the
 * proven pure-core + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's touches — the #3 IDOR boundary.
 */

import type { OutreachKind, OutreachStatus, OutreachTouch, Prospect } from "./types.js";

/** Fields captured when a touch is first drafted (before any approval or provider call). */
export interface CreateTouchInput {
  workspaceId: string;
  prospectRef: string;
  prospect: Prospect;
  kind: OutreachKind;
  body: string;
}

/** The outcome patch applied after an approved send attempt (transition out of `drafted`). */
export interface OutreachOutcomePatch {
  status: OutreachStatus;
  approvalRequestId: string;
  externalId: string | null;
  error: string | null;
  updatedAt: Date;
}

export interface OutreachStore {
  /** Append a new `drafted` touch. */
  create(input: CreateTouchInput, now: Date): Promise<OutreachTouch>;
  /** Load one touch within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<OutreachTouch | null>;
  /** A workspace's touches, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: OutreachStatus): Promise<OutreachTouch[]>;
  /** Count touches a workspace has SENT at or after `since` — the daily-limit gate's denominator. */
  countSentSince(workspaceId: string, since: Date): Promise<number>;
  /**
   * Apply a send outcome to a still-`drafted` touch. The store enforces the `drafted` precondition atomically —
   * a no-op returning `null` if the row is missing or already actioned (so a touch can never send twice).
   */
  applyOutcome(workspaceId: string, id: string, patch: OutreachOutcomePatch): Promise<OutreachTouch | null>;
}

/**
 * In-memory {@link OutreachStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryOutreachStore implements OutreachStore {
  private readonly rows = new Map<string, OutreachTouch>();
  private seq = 0;

  async create(input: CreateTouchInput, now: Date): Promise<OutreachTouch> {
    const id = `touch-${++this.seq}`;
    const row: OutreachTouch = {
      id,
      workspaceId: input.workspaceId,
      prospectRef: input.prospectRef,
      prospect: { ...input.prospect },
      kind: input.kind,
      body: input.body,
      status: "drafted",
      approvalRequestId: null,
      externalId: null,
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return this.clone(row);
  }

  async get(workspaceId: string, id: string): Promise<OutreachTouch | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? this.clone(row) : null;
  }

  async list(workspaceId: string, status?: OutreachStatus): Promise<OutreachTouch[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => this.clone(r));
  }

  async countSentSince(workspaceId: string, since: Date): Promise<number> {
    return [...this.rows.values()].filter(
      (r) =>
        r.workspaceId === workspaceId &&
        r.status === "sent" &&
        r.updatedAt.getTime() >= since.getTime(),
    ).length;
  }

  async applyOutcome(
    workspaceId: string,
    id: string,
    patch: OutreachOutcomePatch,
  ): Promise<OutreachTouch | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "drafted") return null;
    const next: OutreachTouch = {
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

  private clone(row: OutreachTouch): OutreachTouch {
    return { ...row, prospect: { ...row.prospect } };
  }
}
