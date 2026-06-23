/**
 * Persistence seam for the per-channel spend governor (issue #591). The narrow interface the service consumes
 * — a per-(workspace, channel) governor record (the {@link ChannelSpendState} counters + an alert high-water
 * mark) plus the append-and-decide lifecycle of cap-raise requests. The production binding is the
 * self-managed Postgres store in `spend-governor/default.ts`; unit tests inject {@link InMemoryChannelStore},
 * so the service is tested with no database (the #17 pure-decision + injected-seam pattern).
 *
 * Everything is workspace-scoped (the `workspaceId` is the first argument / a column on every row) so a caller
 * can only ever read or mutate its own tenant's governor — the #3 IDOR boundary. The `channel` is an opaque
 * identity key (e.g. "ads", "email") and is never interpreted as instruction text (#200 §6).
 */

import type { ChannelSpendState } from "./governor.js";

/** A channel with no recorded spend in period 0. */
export const ZERO_STATE: ChannelSpendState = { capCents: 0, committedCents: 0, projectedCents: 0, periodKey: 0 };

/** The persisted governor record: the spend counters plus the alert high-water mark (dedupes alerts). */
export interface ChannelRecord extends ChannelSpendState {
  /** Highest utilization (bps) already alerted at this period; an alert fires only when utilization rises past it. */
  alertedBps: number;
}

export const ZERO_RECORD: ChannelRecord = { ...ZERO_STATE, alertedBps: 0 };

/** A channel's record paired with its identity — used to surface "current spend" across all channels. */
export interface ChannelRecordRow extends ChannelRecord {
  channel: string;
}

export type CapRaiseStatus = "pending" | "approved" | "rejected";

/** A request to raise a channel's cap — pending until a human explicitly approves or rejects it. */
export interface CapRaise {
  id: string;
  workspaceId: string;
  channel: string;
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
  channel: string;
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

export interface ChannelSpendStore {
  /** Load a channel's governor record ({@link ZERO_RECORD} if none yet). */
  getRecord(workspaceId: string, channel: string): Promise<ChannelRecord>;
  /** Persist a channel's governor record (upsert). */
  saveRecord(workspaceId: string, channel: string, record: ChannelRecord): Promise<void>;
  /** Every channel record for a workspace (for the always-visible "current spend" view). */
  listRecords(workspaceId: string): Promise<ChannelRecordRow[]>;
  /** Create a `pending` cap-raise request. */
  createRaise(input: CreateRaiseInput): Promise<CapRaise>;
  /** Load one cap-raise by id within a workspace (#3 IDOR scoping). */
  getRaise(workspaceId: string, id: string): Promise<CapRaise | null>;
  /** A workspace's cap-raises, newest first, optionally filtered by status. */
  listRaises(workspaceId: string, status?: CapRaiseStatus): Promise<CapRaise[]>;
  /** Record a decision on a `pending` cap-raise; returns null if it is missing or already decided. */
  updateRaise(workspaceId: string, id: string, patch: DecideRaisePatch): Promise<CapRaise | null>;
}

interface StoredRecord {
  workspaceId: string;
  channel: string;
  record: ChannelRecord;
}

const recordKey = (workspaceId: string, channel: string): string => `${workspaceId} ${channel}`;

/**
 * In-memory {@link ChannelSpendStore} for unit tests. Deterministic: ids are a monotonic counter and the clock
 * is injectable, so a test never depends on wall-clock time or a uuid.
 */
export class InMemoryChannelStore implements ChannelSpendStore {
  private readonly records = new Map<string, StoredRecord>();
  private readonly raises = new Map<string, CapRaise>();
  private seq = 0;
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date(0));
  }

  async getRecord(workspaceId: string, channel: string): Promise<ChannelRecord> {
    const row = this.records.get(recordKey(workspaceId, channel));
    return row ? { ...row.record } : { ...ZERO_RECORD };
  }

  async saveRecord(workspaceId: string, channel: string, record: ChannelRecord): Promise<void> {
    this.records.set(recordKey(workspaceId, channel), { workspaceId, channel, record: { ...record } });
  }

  async listRecords(workspaceId: string): Promise<ChannelRecordRow[]> {
    return [...this.records.values()]
      .filter((r) => r.workspaceId === workspaceId)
      .map((r) => ({ ...r.record, channel: r.channel }))
      .sort((a, b) => a.channel.localeCompare(b.channel));
  }

  async createRaise(input: CreateRaiseInput): Promise<CapRaise> {
    const id = `craise-${++this.seq}`;
    const raise: CapRaise = {
      id,
      workspaceId: input.workspaceId,
      channel: input.channel,
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
