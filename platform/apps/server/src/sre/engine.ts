import type { SessionLogger } from "../runtime/manager.js";
import { recordSreAction, recordSreTick } from "../observability/metrics.js";
import { evaluateSlo, observeService } from "./slo.js";
import { decideAlert } from "./decide.js";
import { cooldownElapsed } from "./guards.js";
import { composeFailureBundle } from "./bundle.js";
import { draftPostmortem, postmortemPath, type PostmortemTimelineEntry } from "./postmortem.js";
import type { SreCaps } from "./caps.js";
import type {
  BundleContext,
  IncidentRecord,
  ServiceSignal,
  SloKind,
  SreAction,
} from "./types.js";

/**
 * SreEngine (#112, ADR-0112) — the agent on-call loop. Modelled on the #17 AutonomyEngine / #105
 * WatchdogEngine: an opt-in periodic timer (default off, started in `index.ts` only when
 * `SRE_INTERVAL_MS > 0`) whose `tickAll()` reads one signal per service off `/metrics` + health,
 * then for each opted-in workspace evaluates its declared SLOs through the pure {@link evaluateSlo} +
 * {@link decideAlert}. Side effects live here; the decision is pure.
 *
 * Gating mirrors the rest of the platform: maintenance (#99) pauses the whole pass BEFORE any signal
 * read; a workspace's #17 kill switch halts its pass; the `sre.enabled` config flag is default OFF so
 * an un-opted-in deployment is unchanged. Opening an incident reuses the #92 launcher for triage (so
 * it passes the same #71 admission), the incident is durable (`sre_incidents`), and a `critical`
 * breach escalates risky remediation to the #13 approvals queue.
 */

/** The durable incident store seam (real impl wraps the `sre_incidents` repo; tests fake it). */
export interface SreIncidentStore {
  /** The open incident for this service+SLO, or null when there is none. */
  getOpen(workspaceId: string, service: string, sloKind: SloKind): Promise<IncidentRecord | null>;
  /** Open a fresh incident row (status `firing`). */
  open(input: {
    workspaceId: string;
    service: string;
    sloKind: SloKind;
    severity: IncidentRecord["severity"];
    observedValue: number;
    targetValue: number;
    budgetRemaining: number;
    now: Date;
  }): Promise<IncidentRecord>;
  /** Attach the launched triage session to the incident. */
  attachTriage(id: string, triageSessionId: string): Promise<void>;
  /** Mark the incident escalated (a #13 remediation approval was enqueued). */
  markEscalated(id: string): Promise<void>;
  /** Record a re-page (bump the cooldown reference). */
  recordNotified(id: string, now: Date): Promise<void>;
  /** Resolve the incident + record the drafted postmortem path. */
  resolve(input: { id: string; postmortemPath: string; now: Date }): Promise<IncidentRecord>;
}

/** The session-launch surface for triage — the #92 {@link AutonomyLauncher} satisfies it. */
export interface TriageLauncher {
  launch(input: {
    workspaceId: string;
    channelId: string;
    agentMemberId: string;
    createdByMemberId: string;
    task: string;
    harnessEnv?: Record<string, string>;
  }): Promise<{ id: string }>;
}

/** Where to host a triage session in a workspace (a channel + an agent member). Null ⇒ skip launch. */
export interface TriageTarget {
  resolve(
    workspaceId: string,
  ): Promise<{ channelId: string; agentMemberId: string; createdByMemberId: string } | null>;
}

/** The #13 escalation seam — enqueue a human approval for risky remediation of a critical incident. */
export interface SreEscalator {
  escalate(input: {
    workspaceId: string;
    incident: IncidentRecord;
    reason: string;
  }): Promise<{ id: string }>;
}

/** Best-effort incident notification (never throws). */
export interface SreNotifier {
  notify(input: {
    workspaceId: string;
    incident: IncidentRecord;
    kind: "opened" | "repaged" | "resolved";
  }): Promise<void>;
}

/** The failure-bundle context source (recent deploys, trace hints, runbook links). */
export interface SreBundleSource {
  context(workspaceId: string, incident: IncidentRecord): Promise<BundleContext>;
}

/** Writes a drafted postmortem markdown under docs/postmortems/. */
export interface PostmortemWriter {
  write(path: string, markdown: string): Promise<void>;
}

export interface SreEngineDeps {
  /** Read one raw signal per service off `/metrics` + health probes, keyed by service name. */
  readSignals: (now: Date) => Promise<Map<string, ServiceSignal>>;
  /** The opted-in work-list: workspace ids to evaluate (the engine still gates each on `enabled`). */
  listWorkspaceIds: () => Promise<string[]>;
  /** Resolve the per-workspace SRE caps (config; default OFF). */
  caps: (workspaceId: string) => SreCaps;
  /** The #17 kill switch for a workspace (halts its pass). */
  killSwitch: (workspaceId: string) => Promise<boolean>;
  incidents: SreIncidentStore;
  triage: TriageLauncher;
  triageTarget: TriageTarget;
  bundle: SreBundleSource;
  escalator: SreEscalator;
  notifier: SreNotifier;
  postmortems: PostmortemWriter;
  /**
   * Optional maintenance-pause check (#99). When it resolves true, `tickAll()` skips the whole pass
   * BEFORE any signal read. Absent ⇒ never paused.
   */
  maintenancePaused?: () => Promise<boolean>;
  logger: SessionLogger;
  /** Clock seam — defaults to `Date.now` based; tests inject a fixed clock. */
  now?: () => Date;
}

export interface AppliedAlert {
  service: string;
  sloKind: SloKind;
  action: SreAction;
  reason: string;
}

export interface WorkspaceSreResult {
  workspaceId: string;
  /** Set when the whole workspace pass was skipped (disabled | kill_switch); else undefined. */
  skipped?: "disabled" | "kill_switch";
  actions: AppliedAlert[];
}

/** `YYYY-MM-DD` in UTC — the postmortem path's date segment. */
function dateStr(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export class SreEngine {
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: SreEngineDeps) {}

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

  /** One pass: read service signals, then evaluate each opted-in workspace's SLOs. */
  async tickAll(): Promise<void> {
    // #99: maintenance pauses the loop on the same Redis flag the HTTP write-gate reads. Checked
    // BEFORE any signal read so a maintenance window stops all SRE work immediately.
    if (this.deps.maintenancePaused && (await this.deps.maintenancePaused())) {
      this.deps.logger.warn({}, "sre tickAll skipped: maintenance mode active");
      return;
    }
    const now = this.deps.now?.() ?? new Date();
    const signals = await this.deps.readSignals(now);
    const workspaceIds = await this.deps.listWorkspaceIds();
    for (const workspaceId of workspaceIds) {
      try {
        await this.tickWorkspace(workspaceId, signals, now);
      } catch (err) {
        this.deps.logger.error({ err, workspaceId }, "sre tickAll: workspace tick failed");
      }
    }
  }

  /**
   * One pass over a single workspace's declared SLOs. The config flag and the kill switch gate the
   * whole pass; then each service+SLO is evaluated + applied independently. Returns a result for tests.
   */
  async tickWorkspace(
    workspaceId: string,
    signals: Map<string, ServiceSignal>,
    now: Date,
  ): Promise<WorkspaceSreResult> {
    recordSreTick();
    const log = this.deps.logger.child({ workspaceId, component: "sre" });

    const caps = this.deps.caps(workspaceId);
    if (!caps.enabled) return { workspaceId, skipped: "disabled", actions: [] };

    if (await this.deps.killSwitch(workspaceId)) {
      log.warn({}, "sre tick skipped: kill switch engaged");
      recordSreAction("noop:kill_switch");
      return { workspaceId, skipped: "kill_switch", actions: [] };
    }

    const actions: AppliedAlert[] = [];
    for (const svc of caps.services) {
      const signal = signals.get(svc.service);
      if (!signal) continue; // no signal for this service this tick — nothing to evaluate.
      const observations = observeService(signal);

      for (const target of svc.targets) {
        const obs = observations.find((o) => o.kind === target.kind);
        if (!obs) continue;
        const evaluation = evaluateSlo(target, obs);
        const open = await this.deps.incidents.getOpen(workspaceId, svc.service, target.kind);

        const decision = decideAlert({
          breached: evaluation.breached,
          severity: evaluation.severity,
          hasOpenIncident: open !== null,
          killSwitch: false, // gated above
          cooldownElapsed: open
            ? cooldownElapsed(now.getTime() - open.lastNotifiedAt.getTime(), caps.cooldownMs)
            : false,
        });

        await this.apply(workspaceId, svc.service, target.kind, evaluation, open, decision.action, decision.reason, now, log);
        actions.push({ service: svc.service, sloKind: target.kind, action: decision.action, reason: decision.reason });
      }
    }

    log.info({ count: actions.filter((a) => a.action !== "noop").length }, "sre tick complete");
    return { workspaceId, actions };
  }

  /** Apply a single decided action: the incident writes + the triage launch / escalation / postmortem. */
  private async apply(
    workspaceId: string,
    service: string,
    sloKind: SloKind,
    evaluation: { observedValue?: number; value: number; target: number; severity: IncidentRecord["severity"]; budgetRemaining: number },
    open: IncidentRecord | null,
    action: SreAction,
    reason: string,
    now: Date,
    log: SessionLogger,
  ): Promise<void> {
    if (action === "noop") {
      recordSreAction(`noop:${reason}`);
      return;
    }

    if (action === "notify" && open) {
      await this.safeNotify(workspaceId, open, "repaged", log);
      await this.deps.incidents.recordNotified(open.id, now);
      recordSreAction("notify");
      return;
    }

    if (action === "resolve" && open) {
      await this.resolveIncident(workspaceId, open, now, log);
      recordSreAction("resolve");
      return;
    }

    // open | escalate — a fresh breach. Open the durable incident, notify, launch triage.
    const incident = await this.deps.incidents.open({
      workspaceId,
      service,
      sloKind,
      severity: evaluation.severity,
      observedValue: evaluation.value,
      targetValue: evaluation.target,
      budgetRemaining: evaluation.budgetRemaining,
      now,
    });
    await this.safeNotify(workspaceId, incident, "opened", log);
    await this.launchTriage(workspaceId, incident, log);

    if (action === "escalate") {
      // Risky remediation of a critical incident never auto-runs — enqueue a #13 human approval.
      try {
        await this.deps.escalator.escalate({ workspaceId, incident, reason });
        await this.deps.incidents.markEscalated(incident.id);
      } catch (err) {
        log.error({ err, incidentId: incident.id }, "sre escalation failed");
      }
    }
    recordSreAction(action);
  }

  /** Launch the triage agent session with the failure bundle (data, never argv). Best-effort. */
  private async launchTriage(
    workspaceId: string,
    incident: IncidentRecord,
    log: SessionLogger,
  ): Promise<void> {
    try {
      const target = await this.deps.triageTarget.resolve(workspaceId);
      if (!target) {
        log.warn({ incidentId: incident.id }, "sre triage skipped: no channel/agent target");
        return;
      }
      const ctx = await this.deps.bundle.context(workspaceId, incident);
      const replacement = await this.deps.triage.launch({
        workspaceId,
        channelId: target.channelId,
        agentMemberId: target.agentMemberId,
        createdByMemberId: target.createdByMemberId,
        task: composeFailureBundle(incident, ctx),
        harnessEnv: { AGENT_SRE_TRIAGE: "1" },
      });
      await this.deps.incidents.attachTriage(incident.id, replacement.id);
    } catch (err) {
      log.error({ err, incidentId: incident.id }, "sre triage launch failed");
    }
  }

  /** Draft + write the postmortem, resolve the row, notify. */
  private async resolveIncident(
    workspaceId: string,
    open: IncidentRecord,
    now: Date,
    log: SessionLogger,
  ): Promise<void> {
    const resolved: IncidentRecord = { ...open, status: "resolved", resolvedAt: now };
    const timeline: PostmortemTimelineEntry[] = [
      { at: open.openedAt.toISOString(), event: `incident opened (${open.sloKind} breached)` },
    ];
    if (open.triageSessionId) {
      timeline.push({ at: open.openedAt.toISOString(), event: `triage agent launched (${open.triageSessionId})` });
    }
    timeline.push({ at: now.toISOString(), event: "SLO recovered — incident resolved" });

    const path = postmortemPath(open, dateStr(now));
    try {
      await this.deps.postmortems.write(path, draftPostmortem(resolved, timeline));
    } catch (err) {
      log.error({ err, incidentId: open.id }, "sre postmortem write failed");
    }
    await this.deps.incidents.resolve({ id: open.id, postmortemPath: path, now });
    await this.safeNotify(workspaceId, resolved, "resolved", log);
  }

  private async safeNotify(
    workspaceId: string,
    incident: IncidentRecord,
    kind: "opened" | "repaged" | "resolved",
    log: SessionLogger,
  ): Promise<void> {
    try {
      await this.deps.notifier.notify({ workspaceId, incident, kind });
    } catch (err) {
      log.error({ err, incidentId: incident.id }, "sre notify failed");
    }
  }
}
