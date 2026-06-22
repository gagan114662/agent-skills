/**
 * Persistence seam for the X agent (issue #596). Narrow interface the service writes through: create a draft
 * record, read it back, list a workspace's records, apply a publish outcome (draft → terminal), and apply a
 * reverse outcome (published → reversed). The production binding is the self-managed Postgres store in
 * `default.ts`; unit tests inject {@link InMemoryXActionStore}, so the service is tested with no database (the
 * proven pure-core + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's records — the #3 IDOR boundary.
 */

import type {
  XActionContent,
  XActionKind,
  XActionRecord,
  XActionStatus,
} from "./types.js";

/** Fields captured when an action is first drafted (before any approval or provider call). */
export interface CreateActionInput {
  workspaceId: string;
  kind: XActionKind;
  content: XActionContent;
  targetTweetId: string | null;
  scheduleAt: Date | null;
}

/** The outcome patch applied after an approved publish attempt (transition OUT of `draft`). */
export interface PublishOutcomePatch {
  status: XActionStatus;
  approvalRequestId: string;
  externalId: string | null;
  error: string | null;
  updatedAt: Date;
}

/** The outcome patch applied after an approved reverse attempt (transition `published` → `reversed`). */
export interface ReverseOutcomePatch {
  reverseApprovalRequestId: string;
  reversedAt: Date;
  updatedAt: Date;
}

export interface XActionStore {
  /** Append a new `draft` action record. */
  create(input: CreateActionInput, now: Date): Promise<XActionRecord>;
  /** Load one record within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<XActionRecord | null>;
  /** A workspace's records, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: XActionStatus): Promise<XActionRecord[]>;
  /**
   * Apply a publish outcome to a still-`draft` record. The store enforces the `draft` precondition atomically —
   * a no-op returning `null` if the row is missing or already actioned (so a publish can never run twice).
   */
  applyPublishOutcome(
    workspaceId: string,
    id: string,
    patch: PublishOutcomePatch,
  ): Promise<XActionRecord | null>;
  /**
   * Apply a reverse outcome to a still-`published` record. Atomic: a no-op returning `null` if the row is
   * missing or not currently `published` (so an action can never be reversed twice).
   */
  applyReverseOutcome(
    workspaceId: string,
    id: string,
    patch: ReverseOutcomePatch,
  ): Promise<XActionRecord | null>;
}

/**
 * In-memory {@link XActionStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryXActionStore implements XActionStore {
  private readonly rows = new Map<string, XActionRecord>();
  private seq = 0;

  async create(input: CreateActionInput, now: Date): Promise<XActionRecord> {
    const id = `xa-${++this.seq}`;
    const row: XActionRecord = {
      id,
      workspaceId: input.workspaceId,
      kind: input.kind,
      content: cloneContent(input.content),
      targetTweetId: input.targetTweetId,
      scheduleAt: input.scheduleAt,
      status: "draft",
      approvalRequestId: null,
      externalId: null,
      error: null,
      reverseApprovalRequestId: null,
      reversedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return clone(row);
  }

  async get(workspaceId: string, id: string): Promise<XActionRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? clone(row) : null;
  }

  async list(workspaceId: string, status?: XActionStatus): Promise<XActionRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id))
      .map(clone);
  }

  async applyPublishOutcome(
    workspaceId: string,
    id: string,
    patch: PublishOutcomePatch,
  ): Promise<XActionRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "draft") return null;
    const next: XActionRecord = {
      ...row,
      status: patch.status,
      approvalRequestId: patch.approvalRequestId,
      externalId: patch.externalId,
      error: patch.error,
      updatedAt: patch.updatedAt,
    };
    this.rows.set(id, next);
    return clone(next);
  }

  async applyReverseOutcome(
    workspaceId: string,
    id: string,
    patch: ReverseOutcomePatch,
  ): Promise<XActionRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "published") return null;
    const next: XActionRecord = {
      ...row,
      status: "reversed",
      reverseApprovalRequestId: patch.reverseApprovalRequestId,
      reversedAt: patch.reversedAt,
      updatedAt: patch.updatedAt,
    };
    this.rows.set(id, next);
    return clone(next);
  }
}

function cloneContent(content: XActionContent): XActionContent {
  return {
    ...(content.text !== undefined ? { text: content.text } : {}),
    ...(content.tweets !== undefined ? { tweets: [...content.tweets] } : {}),
  };
}

function clone(row: XActionRecord): XActionRecord {
  return { ...row, content: cloneContent(row.content) };
}
