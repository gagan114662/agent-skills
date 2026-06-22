/**
 * Persistence seam for the spend-cap governor (issue #670). The narrow interface the service consumes —
 * a per-workspace governor record (the {@link SpendState} counters + an alert high-water mark) plus the
 * append-and-decide lifecycle of cap-raise requests. The production binding is the self-managed Postgres
 * store in `budget/default.ts`; unit tests inject {@link InMemoryBudgetStore}, so the service is tested
 * with no database (the #17 pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a
 * caller can only ever read or mutate its own tenant's governor — the #3 IDOR boundary.
 */

import type { SpendState } from "./governor.js";

/** A workspace with no recorded spend. */
export const ZERO_STATE: SpendState = { capCents: 0, committedCents: 0, projectedCents: 0 };

/** The persisted governor record: the spend counters plus the alert high-water mark (dedupes alerts). */
export interface GovernorRecord extends SpendState {
  /** Highest utilization (bps) already alerted at; an alert fires only when utilization rises past it. */
  alertedBps: number;
}

export const ZERO_RECORD: GovernorRecord = { ...ZERO_STATE, alertedBps: 0 };

export type CapRaiseStatus = "pending" | "approved" | "rejected";

/** A request to raise a workspace's cap — pending until a human explicitly approves or rejects it. */
export interface CapRaise {
  id: string;
  workspaceId: string;
  fromCents: number;
  toCents: number;
  status: CapRaiseStatus;
  requestedByMemberId: string;
  requestedAt: Date;
  decidedByMemberId: string | null;
  decidedAt: Date | null;
  reason: string | null;
}

export interface CreateRaiseInput {
  workspaceId: string;
  fromCents: number;
  toCents: number;
  requestedByMemberId: string;
}

export interface DecideRaisePatch {
  status: Extract<CapRaiseStatus, "approved" | "rejected">;
  decidedByMemberId: string;
  decidedAt: Date;
  reason: string | null;
}

export interface BudgetStore {
  /** Load a workspace's governor record ({@link ZERO_RECORD} if none yet). */
  getRecord(workspaceId: string): Promise<GovernorRecord>;
  /** Persist a workspace's governor record (upsert). */
  saveRecord(workspaceId: string, record: GovernorRecord): Promise<void>;
  /** Create a `pending` cap-raise request. */
  createRaise(input: CreateRaiseInput): Promise<CapRaise>;
  /** Load one cap-raise by id within a workspace (#3 IDOR scoping). */
  getRaise(workspaceId: string, id: string): Promise<CapRaise | null>;
  /** A workspace's cap-raises, newest first, optionally filtered by status. */
  listRaises(workspaceId: string, status?: CapRaiseStatus): Promise<CapRaise[]>;
  /** Record a decision on a `pending` cap-raise; returns null if it is missing or already decided. */
  updateRaise(workspaceId: string, id: string, patch: DecideRaisePatch): Promise<CapRaise | null>;
}

/**
 * In-memory {@link BudgetStore} for unit tests. Deterministic: ids are a monotonic counter and the clock is
 * injectable, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryBudgetStore implements BudgetStore {
  private readonly records = new Map<string, GovernorRecord>();
  private readonly raises = new Map<string, CapRaise>();
  private seq = 0;
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date(0));
  }

  async getRecord(workspaceId: string): Promise<GovernorRecord> {
    return { ...(this.records.get(workspaceId) ?? ZERO_RECORD) };
  }

  async saveRecord(workspaceId: string, record: GovernorRecord): Promise<void> {
    this.records.set(workspaceId, { ...record });
  }

  async createRaise(input: CreateRaiseInput): Promise<CapRaise> {
    const id = `raise-${++this.seq}`;
    const raise: CapRaise = {
      id,
      workspaceId: input.workspaceId,
      fromCents: input.fromCents,
      toCents: input.toCents,
      status: "pending",
      requestedByMemberId: input.requestedByMemberId,
      requestedAt: this.now(),
      decidedByMemberId: null,
      decidedAt: null,
      reason: null,
    };
    this.raises.set(id, raise);
    return { ...raise };
  }

  async getRaise(workspaceId: string, id: string): Promise<CapRaise | null> {
    const raise = this.raises.get(id);
    return raise && raise.workspaceId === workspaceId ? { ...raise } : null;
  }

  async listRaises(workspaceId: string, status?: CapRaiseStatus): Promise<CapRaise[]> {
    return [...this.raises.values()]
      .filter((r) => r.workspaceId === workspaceId && (status === undefined || r.status === status))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || b.id.localeCompare(a.id))
      .map((r) => ({ ...r }));
  }

  async updateRaise(workspaceId: string, id: string, patch: DecideRaisePatch): Promise<CapRaise | null> {
    const raise = this.raises.get(id);
    if (!raise || raise.workspaceId !== workspaceId || raise.status !== "pending") return null;
    const next: CapRaise = { ...raise, ...patch };
    this.raises.set(id, next);
    return { ...next };
  }
}
