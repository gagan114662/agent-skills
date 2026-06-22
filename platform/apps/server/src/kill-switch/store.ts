/**
 * Persistence seam for the fleet dead-man's switch (issue #592). There is ONE global switch (the fleet is one
 * thing to halt), so the state is a singleton record rather than a per-workspace row — the deliberate contrast
 * with the per-workspace #17 kill switch. Alongside it lives an append-only audit log of every engage /
 * disengage, so "who pulled the switch, when, and why" is always answerable.
 *
 * The production binding is the self-managed Postgres store in `kill-switch/default.ts`; unit tests inject
 * {@link InMemoryKillSwitchStore}, so the service is tested with no database (the #17 injected-seam pattern).
 */

import type { TripwireBreach } from "./tripwire.js";

/** Whether the fleet is running (`armed`) or halted (`engaged`). */
export type KillSwitchStatus = "armed" | "engaged";

/** What caused an engage: a human pulling it (`manual`) or a tripwire breach (`tripwire`). */
export type KillSwitchSource = "manual" | "tripwire";

/** The single global switch record. `armed` means the fleet runs normally; `engaged` means it is halted. */
export interface KillSwitchState {
  status: KillSwitchStatus;
  /** When the switch was last engaged (null while armed). */
  engagedAt: Date | null;
  /** Why it was engaged (null while armed). */
  engagedReason: string | null;
  /** What engaged it (null while armed). */
  source: KillSwitchSource | null;
  /** The member who manually engaged it (null while armed or when a tripwire engaged it). */
  engagedByMemberId: string | null;
  /** The tripwire breaches that engaged it (empty unless a tripwire engaged it). */
  breaches: TripwireBreach[];
}

/** The disarmed starting state — the fleet is running normally. */
export const ARMED_STATE: KillSwitchState = {
  status: "armed",
  engagedAt: null,
  engagedReason: null,
  source: null,
  engagedByMemberId: null,
  breaches: [],
};

/** One row in the append-only audit log. */
export interface KillSwitchEvent {
  id: string;
  at: Date;
  action: "engage" | "disengage";
  source: KillSwitchSource;
  reason: string | null;
  /** The acting member (a manual engage / any disengage); null for a tripwire-driven engage. */
  actorMemberId: string | null;
  /** The breaches recorded with a tripwire engage (empty otherwise). */
  breaches: TripwireBreach[];
}

export interface AppendEventInput {
  action: "engage" | "disengage";
  source: KillSwitchSource;
  reason: string | null;
  actorMemberId: string | null;
  breaches: TripwireBreach[];
  at: Date;
}

export interface KillSwitchStore {
  /** Load the global switch record ({@link ARMED_STATE} if never engaged). */
  getState(): Promise<KillSwitchState>;
  /** Persist the global switch record (upsert of the single row). */
  saveState(state: KillSwitchState): Promise<void>;
  /** Append an audit-log entry; returns the stored event. */
  appendEvent(input: AppendEventInput): Promise<KillSwitchEvent>;
  /** The audit log, newest first, optionally limited. */
  listEvents(limit?: number): Promise<KillSwitchEvent[]>;
}

/**
 * In-memory {@link KillSwitchStore} for unit tests. Deterministic: ids are a monotonic counter, so a test
 * never depends on a uuid; the clock is supplied per-call by the service.
 */
export class InMemoryKillSwitchStore implements KillSwitchStore {
  private state: KillSwitchState = { ...ARMED_STATE };
  private readonly events: KillSwitchEvent[] = [];
  private seq = 0;

  async getState(): Promise<KillSwitchState> {
    return { ...this.state, breaches: [...this.state.breaches] };
  }

  async saveState(state: KillSwitchState): Promise<void> {
    this.state = { ...state, breaches: [...state.breaches] };
  }

  async appendEvent(input: AppendEventInput): Promise<KillSwitchEvent> {
    const event: KillSwitchEvent = {
      id: `ks-evt-${++this.seq}`,
      at: input.at,
      action: input.action,
      source: input.source,
      reason: input.reason,
      actorMemberId: input.actorMemberId,
      breaches: [...input.breaches],
    };
    this.events.push(event);
    return { ...event, breaches: [...event.breaches] };
  }

  async listEvents(limit?: number): Promise<KillSwitchEvent[]> {
    const newestFirst = [...this.events].reverse();
    const sliced = limit === undefined ? newestFirst : newestFirst.slice(0, Math.max(0, limit));
    return sliced.map((e) => ({ ...e, breaches: [...e.breaches] }));
  }
}
