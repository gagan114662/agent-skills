/**
 * The fleet dead-man's switch service (issue #592) — orchestrates the pure {@link evaluateTripwires} decision
 * over the persisted {@link KillSwitchStore} and the alert lifecycle. The shape enforces the #592 acceptance:
 *   - watches the fleet-wide guard metrics (spend/hr, error rate, bounce rate) each cycle ({@link evaluate});
 *   - AUTO-ENGAGES the global switch — pausing ALL agents — the first cycle a tripwire breaches, and ALERTS
 *     the user in that same cycle;
 *   - exposes a MANUAL global kill ({@link engage}) to halt the fleet immediately, and a recorded human
 *     {@link disengage} to resume;
 *   - exposes {@link isFleetPaused} — the single gate the admission chokepoint / engine ticks consult before
 *     letting an agent act.
 *
 * IO lives only in the injected `store`/`alertSink`/`now` seams, so the service is unit-tested with an
 * in-memory store and a fake sink (no database). When the switch is disabled (the default), it is inert:
 * {@link evaluate} never trips and {@link isFleetPaused} is always false — today's behavior is unchanged.
 *
 * Engaging is **idempotent** and engaging→engaged transitions exactly once, so the alert fires exactly once per
 * engagement (no high-water-mark bookkeeping needed): a fleet that stays tripped is not re-alerted every cycle.
 */

import { resolveKillSwitchCaps, type KillSwitchCaps } from "./caps.js";
import {
  evaluateTripwires,
  summarizeBreaches,
  type GuardMetrics,
  type TripwireBreach,
  type TripwireEvaluation,
} from "./tripwire.js";
import {
  ARMED_STATE,
  type KillSwitchEvent,
  type KillSwitchSource,
  type KillSwitchState,
  type KillSwitchStore,
} from "./store.js";

/** An alert raised when the switch engages (or is released). */
export interface KillSwitchAlert {
  /** `engaged` — the fleet was just halted; `resumed` — it was just released back to running. */
  kind: "engaged" | "resumed";
  /** What drove it: a tripwire breach or a human. A `resumed` event is always `manual`. */
  source: KillSwitchSource;
  reason: string;
  /** The breaches that engaged the switch (empty for a manual engage / a resume). */
  breaches: TripwireBreach[];
  at: Date;
  message: string;
}

/** Best-effort notification seam — a failing alert never blocks or reverses a switch decision. */
export interface KillSwitchAlertSink {
  alert(event: KillSwitchAlert): Promise<void>;
}

export interface KillSwitchServiceDeps {
  store: KillSwitchStore;
  alertSink: KillSwitchAlertSink;
  /** Resolved caps (master switch + tripwire ceilings). Defaults to the env-resolved caps. */
  caps?: KillSwitchCaps;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** The live status of the switch, for a status endpoint / operator view. */
export interface KillSwitchStatusReport {
  enabled: boolean;
  /** True when the fleet is halted. */
  paused: boolean;
  status: KillSwitchState["status"];
  engagedAt: Date | null;
  engagedReason: string | null;
  source: KillSwitchSource | null;
  engagedByMemberId: string | null;
  breaches: TripwireBreach[];
}

/** The result of one dead-man's-switch evaluation cycle. */
export interface EvaluateResult {
  /** True only on the cycle a tripwire FIRST engaged the switch (the armed→engaged transition). */
  tripped: boolean;
  /** True whenever the fleet is halted after this cycle (already-engaged ⇒ still true). */
  paused: boolean;
  /** This cycle's tripwire evaluation. */
  evaluation: TripwireEvaluation;
}

/** The result of a manual engage / disengage. */
export interface SwitchActionResult {
  status: KillSwitchStatusReport;
  /** The audit-log event recorded (null when the call was a no-op, e.g. engaging an already-engaged switch). */
  event: KillSwitchEvent | null;
}

export class KillSwitchService {
  private readonly store: KillSwitchStore;
  private readonly alertSink: KillSwitchAlertSink;
  private readonly caps: KillSwitchCaps;
  private readonly now: () => Date;

  constructor(deps: KillSwitchServiceDeps) {
    this.store = deps.store;
    this.alertSink = deps.alertSink;
    this.caps = deps.caps ?? resolveKillSwitchCaps();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the dead-man's switch is armed (the master switch). When false the service is fully inert. */
  isEnabled(): boolean {
    return this.caps.enabled;
  }

  /**
   * The authoritative gate every agent admission / engine tick consults: is the fleet halted right now? When
   * the switch is disabled this is always false (unchanged behavior). A manual engage halts the fleet even
   * while disabled is impossible — engaging requires the switch enabled — so a disabled deployment can never
   * be stuck paused.
   */
  async isFleetPaused(): Promise<boolean> {
    if (!this.caps.enabled) return false;
    return (await this.store.getState()).status === "engaged";
  }

  /** The live status of the switch. */
  async status(): Promise<KillSwitchStatusReport> {
    const state = await this.store.getState();
    return this.report(state);
  }

  /** The audit log, newest first. */
  async history(limit?: number): Promise<KillSwitchEvent[]> {
    return this.store.listEvents(limit);
  }

  /**
   * One dead-man's-switch cycle. Reads the fleet metrics, evaluates the tripwires, and — when the switch is
   * armed and a tripwire breaches — ENGAGES the global switch (pausing all agents) and alerts the user in this
   * same cycle. Already-engaged ⇒ no re-engage, no re-alert. Disabled ⇒ inert (never trips).
   */
  async evaluate(metrics: GuardMetrics): Promise<EvaluateResult> {
    const evaluation = evaluateTripwires(metrics, this.caps.thresholds);

    if (!this.caps.enabled) {
      return { tripped: false, paused: false, evaluation };
    }

    const state = await this.store.getState();
    if (state.status === "engaged") {
      // Already halted — keep it halted, don't re-alert.
      return { tripped: false, paused: true, evaluation };
    }

    if (!evaluation.breached) {
      return { tripped: false, paused: false, evaluation };
    }

    await this.commitEngage("tripwire", summarizeBreaches(evaluation.breaches), null, evaluation.breaches);
    return { tripped: true, paused: true, evaluation };
  }

  /**
   * The MANUAL global kill — halt the entire fleet immediately. Idempotent: engaging an already-engaged switch
   * is a no-op (no duplicate alert / audit row). Requires the switch to be enabled (a disabled deployment has
   * no fleet to pause through this service); throws {@link KillSwitchError} otherwise so the caller learns the
   * switch is off rather than silently believing the fleet halted.
   */
  async engage(input: { reason: string; byMemberId: string }): Promise<SwitchActionResult> {
    if (!this.caps.enabled) {
      throw new KillSwitchError("dead-man's switch is disabled — enable it before engaging");
    }
    const state = await this.store.getState();
    if (state.status === "engaged") {
      return { status: this.report(state), event: null }; // already halted
    }
    const reason = input.reason.trim() || "manual global kill-switch";
    const event = await this.commitEngage("manual", reason, input.byMemberId, []);
    return { status: await this.status(), event };
  }

  /**
   * Release the switch — resume the fleet. This is a RECORDED human action: it always names the member who
   * resumed (and an optional reason), and it is written to the audit log. Throws if the switch is not currently
   * engaged (there is nothing to resume).
   */
  async disengage(input: { reason?: string; byMemberId: string }): Promise<SwitchActionResult> {
    const state = await this.store.getState();
    if (state.status !== "engaged") {
      throw new KillSwitchError("dead-man's switch is not engaged — nothing to resume");
    }
    const at = this.now();
    const reason = (input.reason ?? "").trim() || "manual resume";
    await this.store.saveState({ ...ARMED_STATE });
    const event = await this.store.appendEvent({
      action: "disengage",
      source: "manual",
      reason,
      actorMemberId: input.byMemberId,
      breaches: [],
      at,
    });
    await this.fireAlert({
      kind: "resumed",
      source: "manual",
      reason,
      breaches: [],
      at,
      message: `Fleet dead-man's switch RELEASED by ${input.byMemberId} — agents may resume. (${reason})`,
    });
    return { status: await this.status(), event };
  }

  /** Persist the engaged state, write the audit row, and fire the (single) alert. Shared by auto + manual. */
  private async commitEngage(
    source: KillSwitchSource,
    reason: string,
    byMemberId: string | null,
    breaches: TripwireBreach[],
  ): Promise<KillSwitchEvent> {
    const at = this.now();
    const next: KillSwitchState = {
      status: "engaged",
      engagedAt: at,
      engagedReason: reason,
      source,
      engagedByMemberId: byMemberId,
      breaches,
    };
    await this.store.saveState(next);
    const event = await this.store.appendEvent({
      action: "engage",
      source,
      reason,
      actorMemberId: byMemberId,
      breaches,
      at,
    });
    const who = source === "manual" ? `manually by ${byMemberId}` : "by a tripwire breach";
    await this.fireAlert({
      kind: "engaged",
      source,
      reason,
      breaches,
      at,
      message: `🛑 Fleet dead-man's switch ENGAGED ${who} — ALL agents paused. ${reason}`,
    });
    return event;
  }

  /** Best-effort: a thrown alert never blocks or reverses the switch decision that triggered it. */
  private async fireAlert(alert: KillSwitchAlert): Promise<void> {
    try {
      await this.alertSink.alert(alert);
    } catch {
      // best-effort — the fleet is already paused; a failed notification must not unpause it.
    }
  }

  private report(state: KillSwitchState): KillSwitchStatusReport {
    return {
      enabled: this.caps.enabled,
      paused: this.caps.enabled && state.status === "engaged",
      status: state.status,
      engagedAt: state.engagedAt,
      engagedReason: state.engagedReason,
      source: state.source,
      engagedByMemberId: state.engagedByMemberId,
      breaches: state.breaches,
    };
  }
}

/** A switch operation rejected for a stated reason (mapped to 409 at a route layer). */
export class KillSwitchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KillSwitchError";
  }
}
