/**
 * Hot-prospect alerting service (issue #622) — the orchestrator that turns recent prospect activity into
 * gated, queued alerts. It composes the pure cores ({@link ./detect}, {@link ./alert}) over three injected
 * seams (signal source, approval gate, alert store), so it is fully unit-testable with in-memory fakes and a
 * fixed clock — no database, no network, no real notification.
 *
 * The shape enforces the #622 acceptance criteria and trust boundary:
 *   - {@link scan} detects every prospect whose windowed activity crossed the intent threshold ("visited
 *     pricing 3x today"), and for each NEW crossing (respecting the cooldown) builds an alert with a TAILORED
 *     follow-up and PARKS the outbound notification as a pending approval — it sends nothing itself;
 *   - dedup: a prospect that alerted within `cooldownMs` is skipped, so a still-hot prospect doesn't re-fire
 *     every scan;
 *   - disabled (`HOT_PROSPECT_ALERTING_ENABLED=0`, the default): the service is inert — scan returns no
 *     alerts, parks no approvals, sends nothing.
 *
 * Outbound delivery is NOT this service's job: it only parks the approval. Sending happens later, when a human
 * approves the parked request and a bound notifier runs — see {@link ./notify}.
 */

import { buildAlert, DEFAULT_ROUTES } from "./alert.js";
import { resolveHotProspectPolicy, type HotProspectPolicy } from "./caps.js";
import { detectIntent } from "./detect.js";
import type { ApprovalGate } from "./notify.js";
import type { AlertStore } from "./store.js";
import type { SignalSource } from "./source.js";
import type { HotProspectAlert } from "./types.js";

export interface HotProspectDeps {
  source: SignalSource;
  store: AlertStore;
  gate: ApprovalGate;
  /** Resolved policy (master switch + windows + threshold + model). Defaults to the env-resolved policy. */
  policy?: HotProspectPolicy;
  /** Clock seam. Defaults to `Date.now`. */
  now?: () => Date;
}

/** A single raised alert in a scan result: the alert, the parked approval, and the stored record id. */
export interface RaisedAlert {
  alert: HotProspectAlert;
  /** The #13 approval the outbound notification is parked behind — sending is gated on this being approved. */
  approvalRequestId: string;
  /** The persisted alert record id. */
  recordId: string;
}

/** The outcome of a scan: whether the module was active, and every alert it raised this pass. */
export interface ScanResult {
  enabled: boolean;
  alerts: RaisedAlert[];
}

export class HotProspectService {
  private readonly source: SignalSource;
  private readonly store: AlertStore;
  private readonly gate: ApprovalGate;
  private readonly policy: HotProspectPolicy;
  private readonly now: () => Date;

  constructor(deps: HotProspectDeps) {
    this.source = deps.source;
    this.store = deps.store;
    this.gate = deps.gate;
    this.policy = deps.policy ?? resolveHotProspectPolicy();
    this.now = deps.now ?? (() => new Date());
  }

  /** Whether the module is active (the master switch). */
  isEnabled(): boolean {
    return this.policy.enabled;
  }

  /**
   * Scan a workspace's recent prospect activity and raise an alert for each NEW threshold crossing. For every
   * hot prospect not already alerted within the cooldown: build the alert + tailored follow-up, park the
   * outbound notification as a pending approval, and persist the record. Returns every alert raised this pass.
   *
   * When disabled, returns `{ enabled: false, alerts: [] }` and does nothing else — no source read, no parked
   * approval, no write.
   */
  async scan(workspaceId: string): Promise<ScanResult> {
    if (!this.policy.enabled) return { enabled: false, alerts: [] };

    const nowMs = this.now().getTime();
    const activities = await this.source.recentActivity(workspaceId);
    const raised: RaisedAlert[] = [];

    for (const activity of activities) {
      const detection = detectIntent(activity, this.policy, nowMs);
      if (!detection.isHot) continue;

      // Cooldown dedup: skip a prospect already alerted recently, so a still-hot prospect doesn't re-fire.
      const last = await this.store.lastAlertAt(workspaceId, activity.prospectId);
      if (last !== null) {
        const since = nowMs - Date.parse(last);
        if (Number.isFinite(since) && since < this.policy.cooldownMs) continue;
      }

      const alert = buildAlert(detection, activity, this.now().toISOString(), DEFAULT_ROUTES);

      // The ONLY outbound path: park a pending approval. Nothing is sent here.
      const parked = await this.gate.requestNotification({
        workspaceId,
        alert,
        routes: alert.routes,
      });

      const record = await this.store.record({
        workspaceId,
        prospectId: alert.prospectId,
        score: alert.score,
        reason: alert.reason,
        routes: alert.routes,
        approvalRequestId: parked.approvalRequestId,
        raisedAt: alert.raisedAt,
      });

      raised.push({ alert, approvalRequestId: parked.approvalRequestId, recordId: record.id });
    }

    return { enabled: true, alerts: raised };
  }

  /** Recent fired alerts for a workspace, newest first (read-back for a digest / UI). Empty when disabled. */
  async recentAlerts(workspaceId: string, limit?: number): ReturnType<AlertStore["recent"]> {
    if (!this.policy.enabled) return [];
    return this.store.recent(workspaceId, limit);
  }
}
