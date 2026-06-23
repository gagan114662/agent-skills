/**
 * The per-channel spend-governor service (issue #591) — orchestrates the pure {@link decideSpend} decision
 * over the persisted per-channel counters, the clock-driven period reset, and the alert + cap-raise lifecycle.
 * The shape enforces the #591 acceptance criteria:
 *   - tracks COMMITTED + PROJECTED spend PER CHANNEL within the current period (the store record);
 *   - BLOCKS further spend once committed+projected reach the channel cap ({@link authorizeSpend} returns
 *     `allowed:false`) — the money gate; spend can never exceed the cap on the governor's own authority;
 *   - keeps CURRENT SPEND ALWAYS VISIBLE per channel ({@link status} / {@link statuses});
 *   - requires an explicit, RECORDED human approval to RAISE a channel cap ({@link requestRaise} →
 *     {@link approveRaise}) — the approval-gated override; lowering is always safe and immediate ({@link lowerCap}).
 *
 * Caps refill each PERIOD: the injected clock + configured period length drive {@link rollPeriod}, so a
 * channel's counters reset to 0 at each period boundary before any decision is made.
 *
 * IO lives only in the injected `store`/`alertSink`/`now` seams, so the service is unit-tested with an
 * in-memory store and a fake sink (no database). When the governor is disabled (the default), it is inert:
 * {@link authorizeSpend} allows everything and reserves nothing.
 */

import {
  applyLowerCap,
  applyRaiseCap,
  applyRelease,
  applyReserve,
  applySettle,
  channelSpendStatus,
  decideSpend,
  periodKeyFor,
  rollPeriod,
  validateRaise,
  type ChannelSpendDecision,
  type ChannelSpendStatus,
} from "./governor.js";
import { resolveSpendGovernorCaps, type SpendGovernorCaps } from "./caps.js";
import type { CapRaise, CapRaiseStatus, ChannelRecord, ChannelSpendStore } from "./store.js";

/** An alert raised when a channel's utilization crosses the threshold or its cap is hit. */
export interface AlertEvent {
  workspaceId: string;
  channel: string;
  /** `threshold` — utilization crossed the warn line; `blocked` — the cap is reached and spend is blocked. */
  kind: "threshold" | "blocked";
  status: ChannelSpendStatus;
  message: string;
}

/** Best-effort notification seam — a failing alert never blocks or reverses a spend decision. */
export interface AlertSink {
  alert(event: AlertEvent): Promise<void>;
}

export interface SpendGovernorDeps {
  store: ChannelSpendStore;
  alertSink: AlertSink;
  /** Resolved governor caps (master switch + period + alert threshold). Defaults to the env-resolved caps. */
  caps?: SpendGovernorCaps;
  /** Clock seam (drives period reset + decision timestamps). Defaults to `Date.now`-backed `new Date()`. */
  now?: () => Date;
}

/** The result of authorizing a spend against a channel cap. */
export interface AuthorizeResult {
  allowed: boolean;
  requiresApproval: boolean;
  status: ChannelSpendStatus;
  decision: ChannelSpendDecision;
}

/** A channel's identity paired with its live status — the always-visible "current spend" row. */
export interface ChannelStatusRow extends ChannelSpendStatus {
  channel: string;
}

/** The result of a cap-raise decision (approve/reject) — the updated raise + the resulting status. */
export interface RaiseDecisionResult {
  raise: CapRaise;
  status: ChannelSpendStatus;
}

export class SpendGovernorService {
  private readonly store: ChannelSpendStore;
  private readonly alertSink: AlertSink;
  private readonly caps: SpendGovernorCaps;
  private readonly now: () => Date;

  constructor(deps: SpendGovernorDeps) {
    this.store = deps.store;
    this.alertSink = deps.alertSink;
    this.caps = deps.caps ?? resolveSpendGovernorCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the governor is enforcing (the master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /** The integer period bucket the current instant falls in (drives the per-period reset). */
  private currentPeriodKey(): number {
    return periodKeyFor(this.now().getTime(), this.caps.periodMs);
  }

  /** Load a channel record and roll it into the current period (resetting counters if the period changed). */
  private async loadRolled(workspaceId: string, channel: string): Promise<ChannelRecord> {
    const record = await this.store.getRecord(workspaceId, channel);
    return rollPeriod(record, this.currentPeriodKey());
  }

  /** The live status of one channel's cap (period-rolled). */
  async status(workspaceId: string, channel: string): Promise<ChannelSpendStatus> {
    const record = await this.loadRolled(workspaceId, channel);
    return channelSpendStatus(record, this.caps.alertThresholdBps);
  }

  /** Live status of EVERY channel in the workspace — the always-visible current-spend view. */
  async statuses(workspaceId: string): Promise<ChannelStatusRow[]> {
    const key = this.currentPeriodKey();
    const rows = await this.store.listRecords(workspaceId);
    return rows.map((r) => ({
      channel: r.channel,
      ...channelSpendStatus(rollPeriod(r, key), this.caps.alertThresholdBps),
    }));
  }

  /**
   * Authorize a prospective `cents` spend on `channel`. When the governor is enabled and the spend fits, it is
   * RESERVED (added to projected) and allowed; when it would cross the cap it is BLOCKED (`allowed:false`) and
   * an alert fires — the spend must wait for a human-approved cap raise. When the governor is disabled it
   * allows everything and reserves nothing.
   */
  async authorizeSpend(workspaceId: string, channel: string, cents: number): Promise<AuthorizeResult> {
    const record = await this.loadRolled(workspaceId, channel);
    const decision = decideSpend(record, cents);

    if (!this.caps.enabled) {
      return {
        allowed: true,
        requiresApproval: false,
        status: channelSpendStatus(record, this.caps.alertThresholdBps),
        decision: { ...decision, allowed: true, requiresApproval: false, reason: "spend governor disabled" },
      };
    }

    if (!decision.allowed) {
      const status = channelSpendStatus(record, this.caps.alertThresholdBps);
      // Persist the (possibly period-reset) record so a roll that happened on read is durable.
      await this.store.saveRecord(workspaceId, channel, record);
      await this.fireAlert(workspaceId, channel, status, "blocked");
      return { allowed: false, requiresApproval: decision.requiresApproval, status, decision };
    }

    const next = applyReserve(record, cents);
    await this.store.saveRecord(workspaceId, channel, next);
    const status = await this.maybeAlert(workspaceId, channel, next);
    return { allowed: true, requiresApproval: false, status, decision };
  }

  /** Settle a prior reservation: drop `reservedCents` from projected, add `actualCents` to committed. */
  async settle(workspaceId: string, channel: string, reservedCents: number, actualCents: number): Promise<ChannelSpendStatus> {
    const record = await this.loadRolled(workspaceId, channel);
    const next = applySettle(record, reservedCents, actualCents);
    await this.store.saveRecord(workspaceId, channel, next);
    return this.maybeAlert(workspaceId, channel, next);
  }

  /** Release a reservation that will not be spent (the action was cancelled). */
  async release(workspaceId: string, channel: string, cents: number): Promise<ChannelSpendStatus> {
    const record = await this.loadRolled(workspaceId, channel);
    const next = applyRelease(record, cents);
    await this.store.saveRecord(workspaceId, channel, next);
    return this.maybeAlert(workspaceId, channel, next);
  }

  /** Lower a channel cap immediately — tightening never needs approval. */
  async lowerCap(workspaceId: string, channel: string, toCents: number): Promise<ChannelSpendStatus> {
    const record = await this.loadRolled(workspaceId, channel);
    const next = applyLowerCap(record, toCents);
    await this.store.saveRecord(workspaceId, channel, next);
    return this.maybeAlert(workspaceId, channel, next);
  }

  /**
   * Request a cap RAISE for a channel. Validated as a strict increase over the current cap, then parked as a
   * `pending` cap-raise — it does NOT take effect until {@link approveRaise} records a human approval.
   */
  async requestRaise(
    workspaceId: string,
    channel: string,
    requestedByMemberId: string,
    toCents: number,
  ): Promise<CapRaise> {
    const record = await this.loadRolled(workspaceId, channel);
    const v = validateRaise(record.capCents, toCents);
    if (!v.ok) throw new SpendGovernorError(v.reason);
    return this.store.createRaise({
      workspaceId,
      channel,
      fromCents: record.capCents,
      toCents: Math.trunc(toCents),
      requestedByMemberId,
    });
  }

  /** A workspace's cap-raise requests, newest first, optionally filtered by status. */
  async listRaises(workspaceId: string, status?: CapRaiseStatus): Promise<CapRaise[]> {
    return this.store.listRaises(workspaceId, status);
  }

  /**
   * Approve a pending cap-raise — the recorded human approval that overrides the block. Applies the new
   * (higher) ceiling to the channel and resets the alert high-water mark so a future re-cross alerts again.
   * Throws if the raise is missing, already decided, or no longer a valid raise (e.g. the cap was lowered past
   * the target meanwhile).
   */
  async approveRaise(
    workspaceId: string,
    raiseId: string,
    decidedByMemberId: string,
    reason: string | null = null,
  ): Promise<RaiseDecisionResult> {
    const raise = await this.store.getRaise(workspaceId, raiseId);
    if (!raise) throw new SpendGovernorError("cap-raise request not found");
    if (raise.status !== "pending") throw new SpendGovernorError(`cap-raise already ${raise.status}`);

    const record = await this.loadRolled(workspaceId, raise.channel);
    const v = validateRaise(record.capCents, raise.toCents);
    if (!v.ok) throw new SpendGovernorError(`cannot apply raise: ${v.reason}`);

    const next: ChannelRecord = { ...applyRaiseCap(record, raise.toCents), alertedBps: 0 };
    await this.store.saveRecord(workspaceId, raise.channel, next);
    const decided = await this.store.updateRaise(workspaceId, raiseId, {
      status: "approved",
      decidedByMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) throw new SpendGovernorError("cap-raise could not be recorded as approved");
    return { raise: decided, status: channelSpendStatus(next, this.caps.alertThresholdBps) };
  }

  /** Reject a pending cap-raise — the cap is unchanged. */
  async rejectRaise(
    workspaceId: string,
    raiseId: string,
    decidedByMemberId: string,
    reason: string | null = null,
  ): Promise<RaiseDecisionResult> {
    const existing = await this.store.getRaise(workspaceId, raiseId);
    const decided = await this.store.updateRaise(workspaceId, raiseId, {
      status: "rejected",
      decidedByMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) throw new SpendGovernorError("cap-raise request not found or already decided");
    return { raise: decided, status: await this.status(workspaceId, existing?.channel ?? decided.channel) };
  }

  /**
   * Fire an alert at most once per SEVERITY level so a climbing-but-already-warned channel is not spammed.
   * `alertedBps` records the highest severity already alerted: 0 (none) → the threshold (warned) → 10000
   * (blocked). A threshold alert fires on the first crossing of the warn line; a distinct blocked alert still
   * fires when the cap is later reached. The mark resets once utilization falls back below the threshold (or
   * the period rolls), so a later re-crossing alerts again. Returns the resulting status.
   */
  private async maybeAlert(workspaceId: string, channel: string, record: ChannelRecord): Promise<ChannelSpendStatus> {
    const status = channelSpendStatus(record, this.caps.alertThresholdBps);
    if (!status.alerting) {
      if (record.alertedBps !== 0) await this.store.saveRecord(workspaceId, channel, { ...record, alertedBps: 0 });
      return status;
    }
    const level = status.blocked ? 10_000 : this.caps.alertThresholdBps;
    if (level > record.alertedBps) {
      await this.store.saveRecord(workspaceId, channel, { ...record, alertedBps: level });
      await this.fireAlert(workspaceId, channel, status, status.blocked ? "blocked" : "threshold");
    }
    return status;
  }

  /** Best-effort: a thrown alert never blocks or reverses the spend decision that triggered it. */
  private async fireAlert(
    workspaceId: string,
    channel: string,
    status: ChannelSpendStatus,
    kind: AlertEvent["kind"],
  ): Promise<void> {
    const pct = (status.utilizationBps / 100).toFixed(1);
    const cap = `$${(status.capCents / 100).toFixed(2)}`;
    const message =
      kind === "blocked"
        ? `Spend cap reached for channel "${channel}" in workspace ${workspaceId}: ${cap} committed/projected this period — further spend is blocked until the cap is raised.`
        : `Spend on channel "${channel}" at ${pct}% for workspace ${workspaceId} — approaching the ${cap} cap.`;
    try {
      await this.alertSink.alert({ workspaceId, channel, kind, status, message });
    } catch {
      // best-effort
    }
  }
}

/** A governor operation rejected for a stated reason (mapped to 409 at the route layer). */
export class SpendGovernorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpendGovernorError";
  }
}
