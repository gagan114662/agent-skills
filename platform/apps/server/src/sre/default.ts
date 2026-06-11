import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve as resolvePath } from "node:path";
import { loadConfig } from "../config/loader.js";
import { resolveSreCaps } from "./caps.js";
import {
  SreEngine,
  type PostmortemWriter,
  type SreBundleSource,
  type SreEscalator,
  type SreNotifier,
  type TriageTarget,
} from "./engine.js";
import { observeService } from "./slo.js";
import type { ServiceSignal } from "./types.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import { sreIncidentStore } from "../db/repositories/sre.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { listLiveSessions } from "../db/repositories/agent-sessions.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { snapshotHttpMetrics } from "../observability/metrics.js";
import { pingDb } from "../db/index.js";
import { pingRedis } from "../redis/index.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { channelPoster } from "../runtime/default.js";
import { createReliabilityNotifier } from "../reliability/default.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for the SRE Loop (#112). Every seam is real: alert evaluation reads the existing
 * `/metrics` series + health probes (no vendor); the triage launch reuses the #92 launcher verbatim
 * (so it passes the same #71 admission); escalation is the #13 queue; the postmortem is written under
 * docs/postmortems/. The loop is default-OFF (config `sre.enabled` + `SRE_INTERVAL_MS`), so wiring it
 * changes nothing until an operator declares SLOs and opts in.
 */

/** The runbook links the failure bundle always offers (the #99 DR restore runbook for data-plane). */
const DATA_PLANE_RUNBOOKS = ["docs/playbooks/restore-runbook.md"];

/**
 * Read one signal per declared service off `/metrics` + health probes. The platform services map to:
 *  - `api`:   HTTP availability (success ÷ total) + p95 from the request-duration histogram.
 *  - `db` / `redis`: health-only (the same ping the `/readyz` probe uses) → availability 0 when down.
 * A service the caller declares but we have no signal for is simply absent from the map.
 */
async function readSignals(): Promise<Map<string, ServiceSignal>> {
  const http = snapshotHttpMetrics();
  const [dbOk, redisOk] = await Promise.all([pingDb(), pingRedis()]);
  const signals = new Map<string, ServiceSignal>();
  signals.set("api", {
    service: "api",
    windowRequests: http.requests,
    windowErrors: http.errors,
    p95LatencyMs: http.p95LatencyMs,
    queueLagSeconds: 0,
    healthy: true,
  });
  signals.set("db", healthOnly("db", dbOk));
  signals.set("redis", healthOnly("redis", redisOk));
  return signals;
}

function healthOnly(service: string, healthy: boolean): ServiceSignal {
  return { service, windowRequests: 0, windowErrors: 0, p95LatencyMs: 0, queueLagSeconds: 0, healthy };
}

/**
 * Resolve where to host triage / post the incident notification for a workspace: a channel + an agent
 * member, derived from the workspace's live sessions (an active workspace has one). Null ⇒ the loop
 * still opens the durable incident + escalates, but skips the channel-bound triage/notification.
 */
async function resolveOpsTarget(
  workspaceId: string,
): Promise<{ channelId: string; agentMemberId: string; createdByMemberId: string } | null> {
  const live = await listLiveSessions();
  const session = live.find((s) => s.workspaceId === workspaceId);
  if (!session) return null;
  return {
    channelId: session.channelId,
    agentMemberId: session.agentMemberId,
    createdByMemberId: session.createdByMemberId ?? session.agentMemberId,
  };
}

const triageTarget: TriageTarget = { resolve: resolveOpsTarget };

/** Failure-bundle context: trace hints from recent live sessions + the data-plane runbooks. */
const bundleSource: SreBundleSource = {
  context: async (workspaceId) => {
    const live = await listLiveSessions();
    const traceHints = live
      .filter((s) => s.workspaceId === workspaceId)
      .slice(0, 5)
      .map((s) => `session:${s.id}`);
    return { recentDeploys: [], traceHints, runbookLinks: DATA_PLANE_RUNBOOKS };
  },
};

/** #13: enqueue a human approval for risky remediation of a critical incident. */
const approvalEscalator: SreEscalator = {
  escalate: async ({ workspaceId, incident, reason }) => {
    // The approvals queue requires a real requester member (#13 FK). Resolve one from the workspace's
    // ops target; with none, we cannot enqueue an approval (the incident stays durable + firing).
    const target = await resolveOpsTarget(workspaceId);
    if (!target) throw new Error("sre escalate: no requester member available");
    const req = await createRequest({
      workspaceId,
      requesterMemberId: target.agentMemberId,
      actionType: "sre.remediate",
      payload: {
        incidentId: incident.id,
        service: incident.service,
        sloKind: incident.sloKind,
        observedValue: incident.observedValue,
        targetValue: incident.targetValue,
        reason,
      },
      amount: null,
      summary:
        `SRE remediation approval: ${incident.service} ${incident.sloKind} critical breach ` +
        `(observed ${incident.observedValue}, target ${incident.targetValue}) — risky remediation needs a human.`,
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { incidentId: incident.id, reason } }],
    });
    return { id: req.id };
  },
};

/** Best-effort incident notification: post into the workspace's ops channel (never throws). */
const channelNotifier: SreNotifier = {
  notify: async ({ workspaceId, incident, kind }) => {
    const target = await resolveOpsTarget(workspaceId);
    if (!target) return;
    const emoji = kind === "resolved" ? "✅" : "🚨";
    const verb = kind === "opened" ? "OPENED" : kind === "repaged" ? "STILL FIRING" : "RESOLVED";
    await channelPoster.post({
      workspaceId,
      channelId: target.channelId,
      agentMemberId: target.agentMemberId,
      body:
        `${emoji} SRE incident ${verb}: ${incident.service} ${incident.sloKind} ` +
        `(observed ${incident.observedValue}, target ${incident.targetValue}, severity ${incident.severity}).`,
    });
  },
};

/** Write a drafted postmortem under docs/postmortems/ relative to the process cwd. */
const filePostmortemWriter: PostmortemWriter = {
  write: async (path, markdown) => {
    const full = resolvePath(process.cwd(), path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, markdown, "utf8");
  },
};

/** Build the production SreEngine. The background timer is started in `index.ts`. */
export function createDefaultSreEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
): SreEngine {
  return new SreEngine({
    readSignals,
    listWorkspaceIds,
    caps: (workspaceId) => resolveSreCaps(loadConfig(workspaceId).sre),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    incidents: sreIncidentStore,
    // Triage = launch through the SAME #92 launcher autonomy/watchdog use (so it passes the same #71
    // admission chokepoint). No new launch authority.
    triage: autonomyLauncherFrom(sessionManager),
    triageTarget,
    bundle: bundleSource,
    escalator: approvalEscalator,
    // #148: the reliability coordinator IS the notifier. For an opted-in workspace it runs the
    // incident.io-class surface (war-room channel, AI investigation, owner paging); for everyone else
    // it delegates to `channelNotifier` — byte-for-byte today's #112 ops-channel post.
    notifier: createReliabilityNotifier({
      fallback: channelNotifier,
      poster: async (workspaceId) => {
        const target = await resolveOpsTarget(workspaceId);
        return target ? { agentMemberId: target.agentMemberId } : null;
      },
      channelPost: async (input) => {
        await channelPoster.post(input);
      },
      logger,
    }),
    postmortems: filePostmortemWriter,
    // #99: pause the loop during maintenance (same Redis flag the write-gate + other loops read).
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}

/** Exposed for the game-day drill: read the live service signals once. */
export { readSignals, observeService };
