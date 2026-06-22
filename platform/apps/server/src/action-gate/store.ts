/**
 * Persistence seam for the action-gate's recorded approval queue (issue #670). The narrow interface the service
 * consumes — append a gated action as a `pending` request, read it back, list a workspace's queue, and record a
 * terminal decision (approved / rejected / executed / expired). The production binding is the self-managed
 * Postgres store in `action-gate/default.ts`; unit tests inject {@link InMemoryGateRequestStore}, so the service
 * is tested with no database (the #17 pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's queue — the #3 IDOR boundary.
 */

import type { GateClass } from "./classify.js";

/**
 * Lifecycle of a gated action:
 *   pending  → the action is parked; it MUST NOT execute yet.
 *   approved → a human recorded a yes; the actuator may now consume it ONCE to execute.
 *   executed → the approval was consumed (the action ran). Terminal — cannot be replayed.
 *   rejected → a human recorded a no. Terminal.
 *   expired  → the TTL passed before anyone acted. Terminal.
 */
export type GateRequestStatus = "pending" | "approved" | "executed" | "rejected" | "expired";

/** Terminal states: a request here never changes again (no re-decide, no re-execute). */
export const TERMINAL_GATE_STATUSES: readonly GateRequestStatus[] = ["executed", "rejected", "expired"];

/** A recorded gated action awaiting (or having received) a human decision. */
export interface GateRequest {
  id: string;
  workspaceId: string;
  /** The raw action verb/operation, e.g. `email.send`. */
  actionType: string;
  /** Where the effect lands (a URL, channel, recipient). Snapshot for the review queue. */
  surface: string | null;
  /** A short human summary shown in the review queue. */
  summary: string | null;
  /** The classifier's queue label (public / irreversible / …) at request time. */
  klass: GateClass;
  /** The action fingerprint — an approval can only ever be consumed for an action that hashes to this. */
  fingerprint: string;
  status: GateRequestStatus;
  requestedByMemberId: string;
  requestedAt: Date;
  decidedByMemberId: string | null;
  decidedAt: Date | null;
  reason: string | null;
  /** When this request/approval lazily expires. */
  expiresAt: Date;
}

export interface CreateGateRequestInput {
  workspaceId: string;
  actionType: string;
  surface: string | null;
  summary: string | null;
  klass: GateClass;
  fingerprint: string;
  requestedByMemberId: string;
  requestedAt: Date;
  expiresAt: Date;
}

/** A decision patch applied to a still-`pending` request (approve / reject). */
export interface DecideGatePatch {
  status: Extract<GateRequestStatus, "approved" | "rejected">;
  decidedByMemberId: string;
  decidedAt: Date;
  reason: string | null;
}

export interface GateRequestStore {
  /** Append a new `pending` request. */
  create(input: CreateGateRequestInput): Promise<GateRequest>;
  /** Load one request within a workspace (#3 IDOR scoping). */
  get(workspaceId: string, id: string): Promise<GateRequest | null>;
  /** A workspace's requests, newest first, optionally filtered by status. */
  list(workspaceId: string, status?: GateRequestStatus): Promise<GateRequest[]>;
  /**
   * Record a decision on a still-`pending` request. The store enforces the `pending` precondition atomically
   * (the transition is a no-op returning `null` if the row is missing or already decided).
   */
  decide(workspaceId: string, id: string, patch: DecideGatePatch): Promise<GateRequest | null>;
  /**
   * Atomically move an `approved` request to `executed` (consume the approval exactly once). Returns the updated
   * row, or `null` if it is missing or not currently `approved` — the single-use guarantee that prevents an
   * approval from authorizing two executions.
   */
  markExecuted(workspaceId: string, id: string, executedAt: Date): Promise<GateRequest | null>;
  /** Atomically move a non-terminal request to `expired`. Returns null if missing/already terminal. */
  markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<GateRequest | null>;
}

/**
 * In-memory {@link GateRequestStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injected through the service, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryGateRequestStore implements GateRequestStore {
  private readonly rows = new Map<string, GateRequest>();
  private seq = 0;

  async create(input: CreateGateRequestInput): Promise<GateRequest> {
    const id = `gate-${++this.seq}`;
    const row: GateRequest = {
      id,
      workspaceId: input.workspaceId,
      actionType: input.actionType,
      surface: input.surface,
      summary: input.summary,
      klass: input.klass,
      fingerprint: input.fingerprint,
      status: "pending",
      requestedByMemberId: input.requestedByMemberId,
      requestedAt: input.requestedAt,
      decidedByMemberId: null,
      decidedAt: null,
      reason: null,
      expiresAt: input.expiresAt,
    };
    this.rows.set(id, row);
    return { ...row };
  }

  async get(workspaceId: string, id: string): Promise<GateRequest | null> {
    const row = this.rows.get(id);
    return row && row.workspaceId === workspaceId ? { ...row } : null;
  }

  async list(workspaceId: string, status?: GateRequestStatus): Promise<GateRequest[]> {
    return [...this.rows.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => ({ ...r }));
  }

  async decide(workspaceId: string, id: string, patch: DecideGatePatch): Promise<GateRequest | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "pending") return null;
    const next: GateRequest = { ...row, ...patch };
    this.rows.set(id, next);
    return { ...next };
  }

  async markExecuted(workspaceId: string, id: string, executedAt: Date): Promise<GateRequest | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || row.status !== "approved") return null;
    const next: GateRequest = { ...row, status: "executed", decidedAt: row.decidedAt ?? executedAt };
    this.rows.set(id, next);
    return { ...next };
  }

  async markExpired(workspaceId: string, id: string, expiredAt: Date): Promise<GateRequest | null> {
    const row = this.rows.get(id);
    if (!row || row.workspaceId !== workspaceId || TERMINAL_GATE_STATUSES.includes(row.status)) return null;
    const next: GateRequest = { ...row, status: "expired", decidedAt: row.decidedAt ?? expiredAt };
    this.rows.set(id, next);
    return { ...next };
  }
}
