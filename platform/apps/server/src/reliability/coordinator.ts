/**
 * The IncidentCoordinator (#148, ADR-0148) IS the #112 `SreNotifier` — wiring it requires NO change to
 * the SRE engine. The engine already calls `notify({ kind: "opened" | "repaged" | "resolved" })` at
 * exactly the three lifecycle moments this surface needs. On those calls the coordinator runs the
 * incident.io-class behavior:
 *   - opened   → ensure the `#incident-NNN` war-room, post the timeline, run the AI investigation
 *                (correlate → render → post + persist), and page the owner.
 *   - repaged  → post a still-firing line + escalate the page (suppressed if acked / quiet / capped).
 *   - resolved → post the postmortem summary + send a closure page.
 *
 * When `reliability.enabled` is FALSE for the workspace, it **delegates to the fallback notifier** —
 * byte-for-byte the #112 ops-channel post — so the default deployment is unchanged. Every side effect
 * is best-effort: a war-room or paging failure is logged, never thrown (the engine's `safeNotify` also
 * guards, but we keep paging independent of the chat post).
 */
import type { SessionLogger } from "../runtime/manager.js";
import type { IncidentRecord } from "../sre/types.js";
import type { SreNotifier } from "../sre/engine.js";
import type { ReliabilityCaps } from "./caps.js";
import type { ReliabilityOverlay } from "../db/repositories/reliability.js";
import type { PageKind, PageSeverity } from "./paging/decide.js";
import {
  correlateIncident,
  type DeploySignal,
  type FingerprintSignal,
  type SaturationSignal,
} from "./investigation/correlate.js";
import { renderInvestigationNote } from "./investigation/render.js";
import {
  incidentChannelName,
  detectedMessage,
  repagedMessage,
  resolvedMessage,
} from "./timeline.js";

/** The coordinator's view of the pager (pre-bound to `source: "sre"` in wiring). */
export interface IncidentPager {
  page(input: {
    workspaceId: string;
    incidentId: string;
    kind: PageKind;
    severity: PageSeverity;
    lastPagedAt: Date | null;
    ackedAt: Date | null;
    subject: string;
    body: string;
  }): Promise<{ delivered: boolean; reason: string }>;
}

export interface InvestigationData {
  recentDeploys: DeploySignal[];
  fingerprints: FingerprintSignal[];
  saturation: SaturationSignal | null;
}

export interface IncidentCoordinatorDeps {
  caps(workspaceId: string): ReliabilityCaps;
  /** Today's #112 notifier — used verbatim when reliability is off for the workspace. */
  fallback: SreNotifier;
  overlay: {
    ensure(workspaceId: string, incidentId: string): Promise<ReliabilityOverlay>;
    setChannel(id: string, channelId: string): Promise<void>;
    setNote(id: string, note: string): Promise<void>;
    recordPaged(id: string, now: Date): Promise<void>;
  };
  channels: {
    create(workspaceId: string, name: string): Promise<{ id: string }>;
    post(input: { workspaceId: string; channelId: string; agentMemberId: string; body: string }): Promise<void>;
    /** The agent member to post the war-room timeline as, or null when no live agent exists. */
    poster(workspaceId: string): Promise<{ agentMemberId: string } | null>;
  };
  investigation: {
    gather(workspaceId: string, incident: IncidentRecord): Promise<InvestigationData>;
  };
  pager: IncidentPager;
  logger: SessionLogger;
  now?: () => Date;
}

export class IncidentCoordinator implements SreNotifier {
  private readonly now: () => Date;
  constructor(private readonly deps: IncidentCoordinatorDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async notify(input: {
    workspaceId: string;
    incident: IncidentRecord;
    kind: "opened" | "repaged" | "resolved";
  }): Promise<void> {
    const caps = this.deps.caps(input.workspaceId);
    // Default path: reliability off ⇒ the plain #112 ops-channel post, unchanged.
    if (!caps.enabled) {
      await this.deps.fallback.notify(input);
      return;
    }

    const overlay = await this.deps.overlay.ensure(input.workspaceId, input.incident.id);
    if (input.kind === "opened") await this.onOpened(input.workspaceId, input.incident, overlay, caps);
    else if (input.kind === "repaged") await this.onRepaged(input.workspaceId, input.incident, overlay, caps);
    else await this.onResolved(input.workspaceId, input.incident, overlay, caps);
  }

  private async onOpened(
    workspaceId: string,
    incident: IncidentRecord,
    overlay: ReliabilityOverlay,
    caps: ReliabilityCaps,
  ): Promise<void> {
    // 1. War-room channel + timeline + investigation (best-effort — never blocks the page).
    const poster = await this.safe(() => this.deps.channels.poster(workspaceId), null, workspaceId, incident.id);
    if (poster) {
      try {
        const channel = overlay.channelId
          ? { id: overlay.channelId }
          : await this.deps.channels.create(workspaceId, incidentChannelName(overlay.seq));
        if (!overlay.channelId) await this.deps.overlay.setChannel(overlay.id, channel.id);
        await this.deps.channels.post({ workspaceId, channelId: channel.id, agentMemberId: poster.agentMemberId, body: detectedMessage(incident) });

        const data = await this.deps.investigation.gather(workspaceId, incident);
        const note = correlateIncident({
          incident: {
            service: incident.service,
            sloKind: incident.sloKind,
            severity: incident.severity,
            observedValue: incident.observedValue,
            targetValue: incident.targetValue,
            openedAt: incident.openedAt,
          },
          recentDeploys: data.recentDeploys,
          fingerprints: data.fingerprints,
          saturation: data.saturation,
          deployWindowMs: caps.deployWindowMs,
        });
        const md = renderInvestigationNote(note);
        await this.deps.channels.post({ workspaceId, channelId: channel.id, agentMemberId: poster.agentMemberId, body: md });
        await this.deps.overlay.setNote(overlay.id, md);
      } catch (err) {
        this.deps.logger.error({ err, incidentId: incident.id }, "reliability war-room/investigation failed");
      }
    } else {
      this.deps.logger.warn({ incidentId: incident.id }, "reliability war-room skipped: no live agent to post as");
    }

    // 2. Page the owner (independent of the war-room — paging is the point).
    await this.pageOwner(workspaceId, incident, overlay, "opened");
  }

  private async onRepaged(
    workspaceId: string,
    incident: IncidentRecord,
    overlay: ReliabilityOverlay,
    _caps: ReliabilityCaps,
  ): Promise<void> {
    await this.postToWarRoom(workspaceId, overlay, repagedMessage(incident), incident.id);
    await this.pageOwner(workspaceId, incident, overlay, "repaged");
  }

  private async onResolved(
    workspaceId: string,
    incident: IncidentRecord,
    overlay: ReliabilityOverlay,
    _caps: ReliabilityCaps,
  ): Promise<void> {
    await this.postToWarRoom(
      workspaceId,
      overlay,
      resolvedMessage(incident, incident.postmortemPath ?? "(pending)"),
      incident.id,
    );
    await this.pageOwner(workspaceId, incident, overlay, "resolved");
  }

  /** Post into the existing war-room (no-op when there is no channel yet or no agent to post as). */
  private async postToWarRoom(
    workspaceId: string,
    overlay: ReliabilityOverlay,
    body: string,
    incidentId: string,
  ): Promise<void> {
    if (!overlay.channelId) return;
    const poster = await this.safe(() => this.deps.channels.poster(workspaceId), null, workspaceId, incidentId);
    if (!poster) return;
    await this.safe(
      () => this.deps.channels.post({ workspaceId, channelId: overlay.channelId as string, agentMemberId: poster.agentMemberId, body }),
      undefined,
      workspaceId,
      incidentId,
    );
  }

  private async pageOwner(
    workspaceId: string,
    incident: IncidentRecord,
    overlay: ReliabilityOverlay,
    kind: "opened" | "repaged" | "resolved",
  ): Promise<void> {
    try {
      const result = await this.deps.pager.page({
        workspaceId,
        incidentId: incident.id,
        kind,
        severity: incident.severity,
        lastPagedAt: overlay.lastPagedAt,
        ackedAt: overlay.ackedAt,
        subject: `[ipop] ${incident.service} ${incident.sloKind} ${kind} (${incident.severity})`,
        body:
          `Incident ${kind}: ${incident.service} ${incident.sloKind} — observed ${incident.observedValue}, ` +
          `target ${incident.targetValue}, severity ${incident.severity}.`,
      });
      if (result.delivered) await this.deps.overlay.recordPaged(overlay.id, this.now());
    } catch (err) {
      this.deps.logger.error({ err, incidentId: incident.id }, "reliability page failed");
    }
  }

  private async safe<T>(fn: () => Promise<T>, fallback: T, workspaceId: string, incidentId: string): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      this.deps.logger.error({ err, workspaceId, incidentId }, "reliability coordinator step failed");
      return fallback;
    }
  }
}
