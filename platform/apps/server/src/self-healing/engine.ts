import type { SessionLogger } from "../runtime/manager.js";
import { recordLoopTickFailure, recordSelfHealingAction, recordSelfHealingTick } from "../observability/metrics.js";
import { decideHealth, decideRemediation, type RemediationDecision } from "./decide.js";
import { composeRunbook } from "./runbook.js";
import {
  filePostmortem,
  type OpsPostmortem,
  type PostmortemReporter,
  type PostmortemTimelineEntry,
} from "./reporter.js";
import type { SelfHealingCaps } from "./caps.js";
import { HEALTH_SIGNALS } from "./types.js";
import type {
  HealthBreach,
  HealthSignal,
  RemediationAction,
  RemediationRecord,
  VentureHealth,
  VentureSurface,
} from "./types.js";

/**
 * SelfHealingEngine (#193, ADR-0174) — ventures stay alive at 3am without the owner. Modelled on the
 * #112 SreEngine / #105 WatchdogEngine: an opt-in periodic timer (default off, started in `index.ts`
 * only when `SELF_HEALING_INTERVAL_MS > 0`) whose `tickAll()` probes every venture surface, evaluates
 * its health through the pure {@link decideHealth}, and for each breach picks a bounded action through
 * {@link decideRemediation}. Side effects live here; the decisions are pure.
 *
 * Gating mirrors the platform: maintenance (#99) pauses the whole pass BEFORE any probe; a workspace's
 * #17 kill switch halts its pass; `selfHealing.enabled` is default OFF and `autoRemediate` is an
 * independent second switch (off ⇒ every breach only escalates). Reversible/pre-committed actions
 * dispatch a remediation session through the #92 launcher (same #71 admission); destructive actions go
 * to the #13 approval queue; an incident auto-remediation cannot close self-files a postmortem issue
 * (#171 pattern) + an `ops_incident` flywheel row that feeds the #172 loop.
 */

/** The durable remediation store seam (real impl wraps `self_healing_remediations`; tests fake it). */
export interface RemediationStore {
  getOpen(
    workspaceId: string,
    surfaceKey: string,
    signal: HealthSignal,
  ): Promise<RemediationRecord | null>;
  open(input: {
    workspaceId: string;
    surfaceKey: string;
    signal: HealthSignal;
    observedValue: number;
    thresholdValue: number;
    now: Date;
  }): Promise<RemediationRecord>;
  /** Patch a row's decided fields + lifecycle (bumps `last_action_at`). */
  update(
    id: string,
    patch: Partial<{
      action: RemediationAction;
      reversibility: RemediationRecord["reversibility"];
      requiresApproval: boolean;
      status: RemediationRecord["status"];
      attempts: number;
      remediationSessionId: string | null;
      approvalRequestId: string | null;
      postmortemIssueRef: string | null;
      detail: string | null;
    }>,
    now: Date,
  ): Promise<void>;
  resolve(id: string, now: Date): Promise<RemediationRecord>;
  /** Open incidents for a workspace — the #104 console / daily-brief read surface. */
  listOpen(workspaceId: string): Promise<RemediationRecord[]>;
}

/** The session-launch surface for remediation — the #92 AutonomyLauncher satisfies it. */
export interface RemediationLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

/** Where to host a remediation session / post narration (a channel + agent). Null ⇒ skip launch. */
export interface RemediationTarget {
  resolve(
    workspaceId: string,
  ): Promise<{ channelId: string; agentMemberId: string; createdByMemberId: string } | null>;
}

/** The #13 approval seam — enqueue a human approval for a destructive or escalated remediation. */
export interface RemediationApprover {
  enqueue(input: {
    workspaceId: string;
    record: RemediationRecord;
    decision: RemediationDecision;
    breach: HealthBreach;
    correlatedDeployId: string | null;
  }): Promise<{ id: string }>;
}

/** Best-effort narration (never throws). */
export interface RemediationNotifier {
  notify(input: {
    workspaceId: string;
    record: RemediationRecord;
    kind: "remediating" | "escalated" | "resolved";
    detail: string;
  }): Promise<void>;
}

export interface SelfHealingEngineDeps {
  /** The opted-in work-list (the engine still gates each on `enabled`). */
  listWorkspaceIds: () => Promise<string[]>;
  caps: (workspaceId: string) => SelfHealingCaps;
  killSwitch: (workspaceId: string) => Promise<boolean>;
  /** The venture surfaces to monitor for a workspace (live deployments + the owner workspace). */
  surfaces: (workspaceId: string) => Promise<VentureSurface[]>;
  /** Production-grounded probe of one venture surface (#200 §3 — a real reading). */
  probe: (workspaceId: string, surface: VentureSurface) => Promise<VentureHealth>;
  /** Correlate a breach to a recent deploy (the rollback target), or null. */
  correlateDeploy: (workspaceId: string, surface: VentureSurface) => Promise<string | null>;
  store: RemediationStore;
  launcher: RemediationLauncher;
  target: RemediationTarget;
  approver: RemediationApprover;
  /** Build the postmortem reporters for a pass (pre-reads the dedup index in the real wiring). */
  reporters: (workspaceId: string) => Promise<PostmortemReporter[]>;
  notifier?: RemediationNotifier;
  /** Optional maintenance-pause check (#99). True ⇒ skip the whole pass before any probe. */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  now?: () => Date;
}

export interface AppliedRemediation {
  surfaceKey: string;
  signal: HealthSignal;
  action: RemediationAction | "resolve" | "noop";
  reason: string;
}

export interface WorkspaceSelfHealingResult {
  workspaceId: string;
  skipped?: "disabled" | "kill_switch";
  actions: AppliedRemediation[];
}

/** The check that, had it existed, would have caught each signal earlier — the #171 "missing check". */
const MISSING_CHECK: Record<HealthSignal, string> = {
  uptime: "a per-venture liveness probe of the live deployment URL with auto-restart on failure",
  error_rate: "a per-venture 5xx error-ratio alert wired to rollback-on-bad-deploy",
  queue_depth: "a per-venture queue-depth alert wired to scale-within-caps",
  stuck_agent: "a tighter wall-clock/idle cap on the agent watchdog for this venture",
};

export class SelfHealingEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: SelfHealingEngineDeps) {}

  /** Start the periodic loop. No-op if interval ≤ 0 or already started. */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tickAll(), intervalMs);
    this.timer.unref?.();
  }

  /** Stop the periodic loop (idempotent) — called on server shutdown. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One pass over every opted-in workspace. */
  async tickAll(): Promise<void> {
    try {
      if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
        this.deps.logger.warn({}, "self-healing tickAll skipped: maintenance mode active");
        return;
      }
      const now = this.deps.now?.() ?? new Date();
      const workspaceIds = await this.deps.listWorkspaceIds();
      for (const workspaceId of workspaceIds) {
        try {
          await this.tickWorkspace(workspaceId, now);
        } catch (err) {
          this.deps.logger.error({ err, workspaceId }, "self-healing tickAll: workspace tick failed");
        }
      }
    } catch (err) {
      recordLoopTickFailure("self_healing");
      this.deps.logger.error({ err }, "self-healing tickAll failed");
    }
  }

  /** One pass over a single workspace's venture surfaces. The config flag + kill switch gate it. */
  async tickWorkspace(workspaceId: string, now: Date): Promise<WorkspaceSelfHealingResult> {
    recordSelfHealingTick();
    const log = this.deps.logger.child({ workspaceId, component: "self-healing" });
    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, skipped: "disabled", actions: [] };
    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "self-healing tick skipped: kill switch engaged");
      recordSelfHealingAction("noop:kill_switch");
      return { workspaceId, skipped: "kill_switch", actions: [] };
    }

    const actions: AppliedRemediation[] = [];
    const surfaces = await this.deps.surfaces(workspaceId);
    for (const surface of surfaces) {
      const health = await this.deps.probe(workspaceId, surface);
      const verdict = decideHealth(health, caps.thresholds);
      const breachBySignal = new Map(verdict.breaches.map((b) => [b.signal, b]));

      for (const signal of HEALTH_SIGNALS) {
        const open = await this.deps.store.getOpen(workspaceId, surface.surfaceKey, signal);
        const breach = breachBySignal.get(signal);

        if (!breach) {
          // Recovered: resolve any open incident for this signal.
          if (open) {
            await this.resolveIncident(workspaceId, open, now, log);
            actions.push({ surfaceKey: surface.surfaceKey, signal, action: "resolve", reason: "recovered" });
          }
          continue;
        }

        const record = open ?? (await this.openIncident(workspaceId, surface, breach, now));
        const applied = await this.remediate(workspaceId, surface, record, breach, caps, now, log);
        actions.push({ surfaceKey: surface.surfaceKey, signal, action: applied.action, reason: applied.reason });
      }
    }

    const nonNoop = actions.filter((a) => a.action !== "noop").length;
    log.info({ count: nonNoop }, "self-healing tick complete");
    return { workspaceId, actions };
  }

  private async openIncident(
    workspaceId: string,
    surface: VentureSurface,
    breach: HealthBreach,
    now: Date,
  ): Promise<RemediationRecord> {
    return this.deps.store.open({
      workspaceId,
      surfaceKey: surface.surfaceKey,
      signal: breach.signal,
      observedValue: breach.observed,
      thresholdValue: breach.threshold,
      now,
    });
  }

  /** Decide + apply the bounded remediation for one open breach. */
  private async remediate(
    workspaceId: string,
    surface: VentureSurface,
    record: RemediationRecord,
    breach: HealthBreach,
    caps: SelfHealingCaps,
    now: Date,
    log: SessionLogger,
  ): Promise<{ action: RemediationAction; reason: string }> {
    const correlated =
      breach.signal === "uptime" || breach.signal === "error_rate"
        ? await this.safeCorrelate(workspaceId, surface, log)
        : null;
    const decision = decideRemediation({
      signal: breach.signal,
      killSwitch: false, // gated above
      attempts: record.attempts,
      correlatedDeployId: correlated,
      caps,
    });
    const detail = `${decision.reason}: observed ${breach.observed} vs ${breach.threshold}`;
    const base = {
      action: decision.action,
      reversibility: decision.reversibility,
      requiresApproval: decision.requiresApproval,
      detail,
    };
    recordSelfHealingAction(decision.action);

    if (decision.action === "none") {
      await this.deps.store.update(record.id, { ...base, status: "firing" }, now);
      return { action: "none", reason: decision.reason };
    }

    if (decision.action === "escalate") {
      const approvalId = await this.safeEnqueue(workspaceId, record, decision, breach, correlated, log);
      const issueRef = await this.fileEscalationPostmortem(workspaceId, surface, record, breach, decision, correlated, now, log);
      await this.deps.store.update(
        record.id,
        { ...base, status: "escalated", approvalRequestId: approvalId, postmortemIssueRef: issueRef },
        now,
      );
      await this.safeNotify(workspaceId, record, "escalated", detail, log);
      return { action: "escalate", reason: decision.reason };
    }

    const destructiveGated =
      (decision.action === "rollback" || decision.action === "scale_up") && decision.requiresApproval;
    if (destructiveGated) {
      const approvalId = await this.safeEnqueue(workspaceId, record, decision, breach, correlated, log);
      await this.deps.store.update(record.id, { ...base, status: "escalated", approvalRequestId: approvalId }, now);
      await this.safeNotify(workspaceId, record, "escalated", detail, log);
      return { action: decision.action, reason: decision.reason };
    }

    // Reversible (restart) or pre-committed bounded action — dispatch a remediation session.
    const sessionId = await this.dispatchSession(workspaceId, surface, breach, decision, correlated, log);
    await this.deps.store.update(
      record.id,
      { ...base, status: "remediating", attempts: record.attempts + 1, remediationSessionId: sessionId },
      now,
    );
    await this.safeNotify(workspaceId, record, "remediating", detail, log);
    return { action: decision.action, reason: decision.reason };
  }

  /** Launch the remediation agent with the runbook bundle (data, never argv). Best-effort. */
  private async dispatchSession(
    workspaceId: string,
    surface: VentureSurface,
    breach: HealthBreach,
    decision: RemediationDecision,
    correlated: string | null,
    log: SessionLogger,
  ): Promise<string | null> {
    try {
      const target = await this.deps.target.resolve(workspaceId);
      if (!target) {
        log.warn({ surfaceKey: surface.surfaceKey }, "self-healing dispatch skipped: no channel/agent target");
        return null;
      }
      const task = composeRunbook({
        ventureLabel: surface.label,
        surfaceKey: surface.surfaceKey,
        signal: breach.signal,
        action: decision.action,
        observed: breach.observed,
        threshold: breach.threshold,
        correlatedDeployId: correlated,
        requiresApproval: decision.requiresApproval,
      });
      const { id } = await this.deps.launcher.launch({
        workspaceId,
        channelId: target.channelId,
        agentMemberId: target.agentMemberId,
        createdByMemberId: target.createdByMemberId,
        task,
        harnessEnv: { AGENT_SELF_HEALING: "1" },
      });
      return id;
    } catch (err) {
      log.error({ err, surfaceKey: surface.surfaceKey }, "self-healing dispatch failed");
      return null;
    }
  }

  /** File the postmortem (issue + flywheel) for an incident auto-remediation could not close. */
  private async fileEscalationPostmortem(
    workspaceId: string,
    surface: VentureSurface,
    record: RemediationRecord,
    breach: HealthBreach,
    decision: RemediationDecision,
    correlated: string | null,
    now: Date,
    log: SessionLogger,
  ): Promise<string | null> {
    const timeline: PostmortemTimelineEntry[] = [
      {
        at: record.openedAt.toISOString(),
        event: `incident opened (${breach.signal} breach: observed ${breach.observed} vs ${breach.threshold})`,
      },
    ];
    if (record.remediationSessionId) {
      timeline.push({
        at: record.lastActionAt.toISOString(),
        event: `auto-remediation attempted (${record.action ?? "?"}, session ${record.remediationSessionId})`,
      });
    }
    timeline.push({ at: now.toISOString(), event: `escalated to a human (${decision.reason})` });

    const pm: OpsPostmortem = {
      signature: `${workspaceId}|${surface.surfaceKey}|${breach.signal}`,
      workspaceId,
      surfaceKey: surface.surfaceKey,
      ventureLabel: surface.label,
      signal: breach.signal,
      action: decision.action,
      observed: breach.observed,
      threshold: breach.threshold,
      timeline,
      rootCause: correlated
        ? `Likely the recent deploy \`${correlated}\` — it correlates in time with the ${breach.signal} breach.`
        : `Unresolved ${breach.signal} breach on the live surface; auto-remediation (${decision.reason}) could not close it.`,
      missingCheck: MISSING_CHECK[breach.signal],
    };
    try {
      const reporters = await this.deps.reporters(workspaceId);
      await filePostmortem(pm, reporters);
    } catch (err) {
      log.error({ err, surfaceKey: surface.surfaceKey }, "self-healing postmortem filing failed");
    }
    // The issue ref is owned by the GitHub reporter's dedup index; we don't thread it back here (the
    // marker is the durable dedup key). Returning null keeps the row's ref null unless a future wiring
    // surfaces it — the postmortem still exists + dedupes by signature.
    return null;
  }

  private async resolveIncident(
    workspaceId: string,
    open: RemediationRecord,
    now: Date,
    log: SessionLogger,
  ): Promise<void> {
    recordSelfHealingAction("resolve");
    const resolved = await this.deps.store.resolve(open.id, now);
    await this.safeNotify(workspaceId, resolved, "resolved", "recovered", log);
  }

  private async safeCorrelate(
    workspaceId: string,
    surface: VentureSurface,
    log: SessionLogger,
  ): Promise<string | null> {
    try {
      return await this.deps.correlateDeploy(workspaceId, surface);
    } catch (err) {
      log.error({ err, surfaceKey: surface.surfaceKey }, "self-healing correlate failed");
      return null;
    }
  }

  private async safeEnqueue(
    workspaceId: string,
    record: RemediationRecord,
    decision: RemediationDecision,
    breach: HealthBreach,
    correlated: string | null,
    log: SessionLogger,
  ): Promise<string | null> {
    try {
      const { id } = await this.deps.approver.enqueue({
        workspaceId,
        record,
        decision,
        breach,
        correlatedDeployId: correlated,
      });
      return id;
    } catch (err) {
      log.error({ err, incidentId: record.id }, "self-healing approval enqueue failed");
      return null;
    }
  }

  private async safeNotify(
    workspaceId: string,
    record: RemediationRecord,
    kind: "remediating" | "escalated" | "resolved",
    detail: string,
    log: SessionLogger,
  ): Promise<void> {
    if (!this.deps.notifier) return;
    try {
      await this.deps.notifier.notify({ workspaceId, record, kind, detail });
    } catch (err) {
      log.error({ err, incidentId: record.id }, "self-healing notify failed");
    }
  }
}
