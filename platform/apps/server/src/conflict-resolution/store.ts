/**
 * Persistence seam for the conflict-resolution arbiter (issue #587). Narrow interface the service consumes:
 * append a resolved conflict (auto-resolved terminal, or escalated awaiting a human), read it back, list a
 * workspace's queue, and record a human decision on an escalated conflict. The production binding is the
 * self-managed Postgres store in `default.ts`; unit tests inject {@link InMemoryConflictStore}, so the service is
 * tested with no database (the proven pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's queue — the #3 IDOR boundary.
 */

import type { Proposal, ResolutionOutcome } from "./types.js";

/**
 * Lifecycle of a recorded conflict:
 *   auto_resolved → the arbiter merged or auto-picked deterministically. Terminal — no human action needed.
 *   escalated     → the arbiter could not decide; ONE choice is parked for a human. Nothing ships yet.
 *   resolved      → a human chose the winning proposal on an escalated conflict. Terminal.
 *   expired       → the escalation TTL passed before a human chose. Terminal — nothing ships.
 */
export type ConflictStatus = "auto_resolved" | "escalated" | "resolved" | "expired";

/** Terminal states: a record here never changes again. */
export const TERMINAL_CONFLICT_STATUSES: readonly ConflictStatus[] = [
  "auto_resolved",
  "resolved",
  "expired",
];

/** A recorded conflict and its resolution (auto, or awaiting/having a human decision). */
export interface ConflictRecord {
  id: string;
  workspaceId: string;
  objectiveId: string;
  status: ConflictStatus;
  outcome: ResolutionOutcome;
  /**
   * The single proposal cleared to ship: the auto winner (`auto_resolved`) or the human's pick (`resolved`).
   * `null` while `escalated` (nothing ships) or `expired`.
   */
  winnerProposalId: string | null;
  /** The full candidate set that was arbitrated, snapshotted for the review queue. */
  candidates: Proposal[];
  /** The arbiter's explanation at record time. */
  reason: string;
  /** The member on whose behalf arbitration was requested. */
  requestedByMemberId: string | null;
  requestedAt: Date;
  /** Who resolved an escalation, and when. */
  decidedByMemberId: string | null;
  decidedAt: Date | null;
  /** When an escalated decision lazily expires (null for terminal auto-resolved records). */
  expiresAt: Date | null;
}

export interface CreateConflictInput {
  workspaceId: string;
  objectiveId: string;
  status: ConflictStatus;
  outcome: ResolutionOutcome;
  winnerProposalId: string | null;
  candidates: Proposal[];
  reason: string;
  requestedByMemberId: string | null;
  requestedAt: Date;
  expiresAt: Date | null;
}

/** A human decision patch applied to a still-`escalated` record. */
export interface DecideConflictPatch {
  winnerProposalId: string;
  decidedByMemberId: string;
  decidedAt: Date;
  reason: string | null;
}

export interface ConflictStore {
  /** Append a new conflict record. */
  create(input: CreateConflictInput): Promise<ConflictRecord>;
  /** Load one record within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<ConflictRecord | null>;
  /** A workspace's records, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: ConflictStatus): Promise<ConflictRecord[]>;
  /**
   * Record a human decision on a still-`escalated` record (move to `resolved`). The store enforces the
   * `escalated` precondition atomically — a no-op returning `null` if the row is missing or already terminal.
   */
  decide(workspaceId: string, id: string, patch: DecideConflictPatch): Promise<ConflictRecord | null>;
  /** Atomically move a still-`escalated` record to `expired`. Returns null if missing/already terminal. */
  markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<ConflictRecord | null>;
}

/**
 * In-memory {@link ConflictStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryConflictStore implements ConflictStore {
  private readonly rows = new Map<string, ConflictRecord>();
  private seq = 0;

  async create(input: CreateConflictInput): Promise<ConflictRecord> {
    const id = `conflict-${++this.seq}`;
    const row: ConflictRecord = {
      id,
      workspaceId: input.workspaceId,
      objectiveId: input.objectiveId,
      status: input.status,
      outcome: input.outcome,
      winnerProposalId: input.winnerProposalId,
      candidates: input.candidates.map((p) => ({ ...p })),
      reason: input.reason,
      requestedByMemberId: input.requestedByMemberId,
      requestedAt: input.requestedAt,
      decidedByMemberId: null,
      decidedAt: null,
      expiresAt: input.expiresAt,
    };
    this.rows.set(id, row);
    return this.clone(row);
  }

  async get(workspaceId: string, id: string): Promise<ConflictRecord | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? this.clone(row) : null;
  }

  async list(workspaceId: string, status?: ConflictStatus): Promise<ConflictRecord[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => this.clone(r));
  }

  async decide(
    workspaceId: string,
    id: string,
    patch: DecideConflictPatch,
  ): Promise<ConflictRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "escalated") return null;
    const next: ConflictRecord = {
      ...row,
      status: "resolved",
      winnerProposalId: patch.winnerProposalId,
      decidedByMemberId: patch.decidedByMemberId,
      decidedAt: patch.decidedAt,
      reason: patch.reason ?? row.reason,
    };
    this.rows.set(id, next);
    return this.clone(next);
  }

  async markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<ConflictRecord | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "escalated") return null;
    const next: ConflictRecord = { ...row, status: "expired", decidedAt: row.decidedAt ?? expiredAt };
    this.rows.set(id, next);
    return this.clone(next);
  }

  private clone(row: ConflictRecord): ConflictRecord {
    return { ...row, candidates: row.candidates.map((p) => ({ ...p })) };
  }
}
