/**
 * The spend-cap governor service (issue #670) — orchestrates the pure {@link decideSpend} decision over the
 * persisted {@link BudgetStore} counters and the alert + cap-raise lifecycle. The shape enforces the #670
 * acceptance criteria:
 *   - tracks COMMITTED + PROJECTED spend per workspace (the store record);
 *   - HALTS further spend once committed+projected reach the cap ({@link authorizeSpend} returns `allowed:false`);
 *   - ALERTS the user when utilization crosses the configured threshold or the cap is hit (the {@link AlertSink});
 *   - requires an explicit, RECORDED human approval to RAISE the cap ({@link requestRaise} → {@link approveRaise});
 *     lowering the cap is always safe and immediate ({@link lowerCap}).
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
  decideSpend,
  spendStatus,
  validateRaise,
  type SpendDecision,
  type SpendStatus,
} from "./governor.js";
import { resolveBudgetGovernorCaps, type BudgetGovernorCaps } from "./caps.js";
import type { BudgetStore, CapRaise, CapRaiseStatus, GovernorRecord } from "./store.js";

/** An alert raised when utilization crosses the threshold or the cap is hit. */
export interface AlertEvent {
  workspaceId: string;
  /** `threshold` — utilization crossed the warn line; `halt` — the cap is reached and spend is blocked. */
  kind: "threshold" | "halt";
  status: SpendStatus;
  message: string;
}

/** Best-effort notification seam — a failing alert never blocks or reverses a spend decision. */
export interface AlertSink {
  alert(event: AlertEvent): Promise<void>;
}

export interface BudgetGovernorDeps {
  store: BudgetStore;
  alertSink: AlertSink;
  /** Resolved governor caps (master switch + alert threshold). Defaults to the env-resolved caps. */
  caps?: BudgetGovernorCaps;
  /** Clock seam for decision timestamps (cap-raise decisions). Defaults to `Date.now`. */
  now?: () => Date;
}

/** The result of authorizing a spend against the cap. */
export interface AuthorizeResult {
  allowed: boolean;
  requiresApproval: boolean;
  status: SpendStatus;
  decision: SpendDecision;
}

/** The result of a cap-raise decision (approve/reject) — the updated raise + the resulting status. */
export interface RaiseDecisionResult {
  raise: CapRaise;
  status: SpendStatus;
}

export class BudgetGovernorService {
  private readonly store: BudgetStore;
  private readonly alertSink: AlertSink;
  private readonly caps: BudgetGovernorCaps;
  private readonly now: () => Date;

  constructor(deps: BudgetGovernorDeps) {
    this.store = deps.store;
    this.alertSink = deps.alertSink;
    this.caps = deps.caps ?? resolveBudgetGovernorCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the governor is enforcing (the master switch). */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /** The live status of a workspace's cap. */
  async status(workspaceId: string): Promise<SpendStatus> {
    const record = await this.store.getRecord(workspaceId);
    return spendStatus(record, this.caps.alertThresholdBps);
  }

  /**
   * Authorize a prospective `cents` spend. When the governor is enabled and the spend fits, it is RESERVED
   * (added to projected) and allowed; when it would cross the cap it is HALTED (`allowed:false`) and an alert
   * fires. When the governor is disabled it allows everything and reserves nothing.
   */
  async authorizeSpend(workspaceId: string, cents: number): Promise<AuthorizeResult> {
    const record = await this.store.getRecord(workspaceId);
    const decision = decideSpend(record, cents);

    if (!this.caps.enabled) {
      return {
        allowed: true,
        requiresApproval: false,
        status: spendStatus(record, this.caps.alertThresholdBps),
        decision: { ...decision, allowed: true, requiresApproval: false, reason: "spend cap governor disabled" },
      };
    }

    if (!decision.allowed) {
      const status = spendStatus(record, this.caps.alertThresholdBps);
      await this.fireAlert(workspaceId, status, "halt");
      return { allowed: false, requiresApproval: decision.requiresApproval, status, decision };
    }

    const next = applyReserve(record, cents);
    await this.store.saveRecord(workspaceId, next);
    const status = await this.maybeAlert(workspaceId, next);
    return { allowed: true, requiresApproval: false, status, decision };
  }

  /** Settle a prior reservation: drop `reservedCents` from projected, add `actualCents` to committed. */
  async settle(workspaceId: string, reservedCents: number, actualCents: number): Promise<SpendStatus> {
    const record = await this.store.getRecord(workspaceId);
    const next = applySettle(record, reservedCents, actualCents);
    await this.store.saveRecord(workspaceId, next);
    return this.maybeAlert(workspaceId, next);
  }

  /** Release a reservation that will not be spent (the action was cancelled). */
  async release(workspaceId: string, cents: number): Promise<SpendStatus> {
    const record = await this.store.getRecord(workspaceId);
    const next = applyRelease(record, cents);
    await this.store.saveRecord(workspaceId, next);
    return this.maybeAlert(workspaceId, next);
  }

  /** Lower the cap immediately — tightening never needs approval. */
  async lowerCap(workspaceId: string, toCents: number): Promise<SpendStatus> {
    const record = await this.store.getRecord(workspaceId);
    const next = applyLowerCap(record, toCents);
    await this.store.saveRecord(workspaceId, next);
    return this.maybeAlert(workspaceId, next);
  }

  /**
   * Request a cap RAISE. Validated as a strict increase over the current cap, then parked as a `pending`
   * cap-raise — it does NOT take effect until {@link approveRaise} records a human approval.
   */
  async requestRaise(workspaceId: string, requestedByMemberId: string, toCents: number): Promise<CapRaise> {
    const record = await this.store.getRecord(workspaceId);
    const v = validateRaise(record.capCents, toCents);
    if (!v.ok) throw new BudgetGovernorError(v.reason);
    return this.store.createRaise({
      workspaceId,
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
   * Approve a pending cap-raise — the recorded human approval. Applies the new (higher) ceiling and resets
   * the alert high-water mark so a future re-cross alerts again. Throws if the raise is missing, already
   * decided, or no longer a valid raise (e.g. the cap was lowered past the target meanwhile).
   */
  async approveRaise(
    workspaceId: string,
    raiseId: string,
    decidedByMemberId: string,
    reason: string | null = null,
  ): Promise<RaiseDecisionResult> {
    const raise = await this.store.getRaise(workspaceId, raiseId);
    if (!raise) throw new BudgetGovernorError("cap-raise request not found");
    if (raise.status !== "pending") throw new BudgetGovernorError(`cap-raise already ${raise.status}`);

    const record = await this.store.getRecord(workspaceId);
    const v = validateRaise(record.capCents, raise.toCents);
    if (!v.ok) throw new BudgetGovernorError(`cannot apply raise: ${v.reason}`);

    const next: GovernorRecord = { ...applyRaiseCap(record, raise.toCents), alertedBps: 0 };
    await this.store.saveRecord(workspaceId, next);
    const decided = await this.store.updateRaise(workspaceId, raiseId, {
      status: "approved",
      decidedByMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) throw new BudgetGovernorError("cap-raise could not be recorded as approved");
    return { raise: decided, status: spendStatus(next, this.caps.alertThresholdBps) };
  }

  /** Reject a pending cap-raise — the cap is unchanged. */
  async rejectRaise(
    workspaceId: string,
    raiseId: string,
    decidedByMemberId: string,
    reason: string | null = null,
  ): Promise<RaiseDecisionResult> {
    const decided = await this.store.updateRaise(workspaceId, raiseId, {
      status: "rejected",
      decidedByMemberId,
      decidedAt: this.now(),
      reason,
    });
    if (!decided) throw new BudgetGovernorError("cap-raise request not found or already decided");
    return { raise: decided, status: await this.status(workspaceId) };
  }

  /**
   * Fire an alert at most once per SEVERITY level so a climbing-but-already-warned workspace is not spammed.
   * `alertedBps` records the highest severity level already alerted: 0 (none) → the threshold (warned) →
   * 10000 (halted). A threshold alert fires on the first crossing of the warn line; a distinct halt alert
   * still fires when the cap is later reached. The mark resets once utilization falls back below the
   * threshold, so a later re-crossing alerts again. Returns the resulting status.
   */
  private async maybeAlert(workspaceId: string, record: GovernorRecord): Promise<SpendStatus> {
    const status = spendStatus(record, this.caps.alertThresholdBps);
    if (!status.alerting) {
      if (record.alertedBps !== 0) await this.store.saveRecord(workspaceId, { ...record, alertedBps: 0 });
      return status;
    }
    // The severity level this status warrants: halt outranks a threshold warning.
    const level = status.halted ? 10_000 : this.caps.alertThresholdBps;
    if (level > record.alertedBps) {
      await this.store.saveRecord(workspaceId, { ...record, alertedBps: level });
      await this.fireAlert(workspaceId, status, status.halted ? "halt" : "threshold");
    }
    return status;
  }

  /** Best-effort: a thrown alert never blocks or reverses the spend decision that triggered it. */
  private async fireAlert(workspaceId: string, status: SpendStatus, kind: AlertEvent["kind"]): Promise<void> {
    const pct = (status.utilizationBps / 100).toFixed(1);
    const message =
      kind === "halt"
        ? `Spend cap reached for workspace ${workspaceId}: $${(status.capCents / 100).toFixed(2)} committed/projected — further spend is halted until the cap is raised.`
        : `Spend cap at ${pct}% for workspace ${workspaceId} — approaching the $${(status.capCents / 100).toFixed(2)} ceiling.`;
    try {
      await this.alertSink.alert({ workspaceId, kind, status, message });
    } catch {
      // best-effort
    }
  }
}

/** A governor operation rejected for a stated reason (mapped to 409 at the route layer). */
export class BudgetGovernorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetGovernorError";
  }
}
