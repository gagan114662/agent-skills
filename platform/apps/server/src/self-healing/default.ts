import { loadConfig } from "../config/loader.js";
import { resolveSelfHealingCaps } from "./caps.js";
import {
  SelfHealingEngine,
  type RemediationApprover,
  type RemediationNotifier,
  type RemediationTarget,
} from "./engine.js";
import {
  flywheelPostmortemReporter,
  githubPostmortemReporter,
  parseMarker,
  type IssueClient,
  type PostmortemReporter,
} from "./reporter.js";
import type { VentureHealth, VentureSurface } from "./types.js";
import { autonomyLauncherFrom } from "../autonomy/default.js";
import { selfHealingStore } from "../db/repositories/self-healing.js";
import { listWorkspaceIds } from "../db/repositories/workspaces.js";
import { listLiveSessions } from "../db/repositories/agent-sessions.js";
import { listRecentDeploysForWorkspace } from "../db/repositories/deployments.js";
import { getControls } from "../db/repositories/autonomy.js";
import { createRequest } from "../db/repositories/approvals.js";
import { isMaintenanceActive } from "../maintenance/flag.js";
import { channelPoster } from "../runtime/default.js";
import { GitHubIssueProvider } from "../integrations/issues/github.js";
import { parseIssueRef } from "../integrations/issues/types.js";
import type { FailureEvent } from "../flywheel/types.js";
import type { SessionLogger, SessionManager } from "../runtime/manager.js";

/**
 * Production wiring for Self-Healing Ops (#193, ADR-0174). Every seam is real: surfaces come from the
 * #73 deployment rows; the probe is a REAL HTTP request to the live deployment URL (#200 §3 — checks
 * touch reality, never a self-reported estimate); the remediation session reuses the #92 launcher
 * verbatim (same #71 admission); destructive actions go to the #13 queue; postmortems self-file as
 * `agent-ok` issues (so the #181/#172 self-shipping loop picks them up) + an `ops_incident` flywheel row.
 *
 * The loop is default-OFF (`selfHealing.enabled` + `SELF_HEALING_INTERVAL_MS`), so wiring it changes
 * nothing until an operator opts in — and even then `autoRemediate` stays off (escalate-only) and
 * destructive actions stay approval-gated until the owner pre-commits them. Owner-workspace-first: ipop
 * opts in via the managed layer.
 */

const SELF_HEALING_LABEL = "self-healing";
const PROBE_TIMEOUT_MS = 5_000;

/** A live deployment URL is a venture surface (deduped by URL). */
async function resolveSurfaces(workspaceId: string): Promise<VentureSurface[]> {
  const deploys = await listRecentDeploysForWorkspace(workspaceId, 30);
  const seen = new Set<string>();
  const surfaces: VentureSurface[] = [];
  for (const d of deploys) {
    if (d.status !== "ready" || !d.url) continue;
    const key = hostOf(d.url);
    if (seen.has(key)) continue;
    seen.add(key);
    surfaces.push({ surfaceKey: key, label: key });
  }
  return surfaces;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * Production-grounded probe of one venture surface: a real HTTP GET of the live URL with a short
 * timeout. `reachable` is whether it answered with a 2xx/3xx. If the surface exposes a JSON health body
 * with numeric `errorRate`/`queueDepth`, those become real per-venture readings; otherwise they are
 * `null` (never breach). Stuck agents are owned by the #105 watchdog (its escalations turn the console
 * dot red directly), so this probe reports 0 for `stuckAgents`.
 */
async function probeSurface(workspaceId: string, surface: VentureSurface): Promise<VentureHealth> {
  const url = `https://${surface.surfaceKey}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    let errorRate: number | null = null;
    let queueDepth: number | null = null;
    try {
      const body = (await res.clone().json()) as { errorRate?: unknown; queueDepth?: unknown };
      if (typeof body.errorRate === "number") errorRate = body.errorRate;
      if (typeof body.queueDepth === "number") queueDepth = body.queueDepth;
    } catch {
      // Not a JSON health body — uptime is still a real reading; error/queue stay null (no breach).
    }
    return { reachable: res.ok, errorRate, queueDepth, stuckAgents: 0 };
  } catch {
    // A network error / timeout is a real "unreachable" reading (#200 §3) — not an absent probe.
    return { reachable: false, errorRate: null, queueDepth: null, stuckAgents: 0 };
  } finally {
    clearTimeout(timer);
  }
}

/** The most recent ready deploy for a workspace is the rollback target / correlation candidate. */
async function correlateDeploy(workspaceId: string): Promise<string | null> {
  const deploys = await listRecentDeploysForWorkspace(workspaceId, 10);
  const ready = deploys.find((d) => d.status === "ready" && d.providerDeploymentId);
  return ready?.id ?? null;
}

/** Resolve a channel+agent to host the remediation session / post narration (a live session). */
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

const target: RemediationTarget = { resolve: resolveOpsTarget };

/** #13: enqueue a human approval for a destructive (rollback/scale) or escalated remediation. */
const approver: RemediationApprover = {
  enqueue: async ({ workspaceId, record, decision, breach, correlatedDeployId }) => {
    const ops = await resolveOpsTarget(workspaceId);
    if (!ops) throw new Error("self-healing approval: no requester member available");
    const req = await createRequest({
      workspaceId,
      requesterMemberId: ops.agentMemberId,
      actionType: "self_healing.remediate",
      payload: {
        incidentId: record.id,
        surfaceKey: record.surfaceKey,
        signal: breach.signal,
        action: decision.action,
        reversibility: decision.reversibility,
        observed: breach.observed,
        threshold: breach.threshold,
        correlatedDeployId,
        reason: decision.reason,
      },
      amount: null,
      summary:
        `Self-healing remediation: ${decision.action} for ${record.surfaceKey} ` +
        `(${breach.signal} breach — observed ${breach.observed}, threshold ${breach.threshold}). ` +
        (decision.action === "escalate"
          ? "Auto-remediation could not close it — a human is needed."
          : "Destructive action — needs a human approval before it runs."),
      status: "pending",
      expiresAt: null,
      events: [{ type: "requested", detail: { incidentId: record.id, reason: decision.reason } }],
    });
    return { id: req.id };
  },
};

/** Best-effort narration: post into the workspace's ops channel (never throws). */
const notifier: RemediationNotifier = {
  notify: async ({ workspaceId, record, kind, detail }) => {
    const ops = await resolveOpsTarget(workspaceId);
    if (!ops) return;
    const emoji = kind === "resolved" ? "✅" : kind === "remediating" ? "🛠️" : "🚨";
    const verb =
      kind === "resolved" ? "RESOLVED" : kind === "remediating" ? "AUTO-REMEDIATING" : "ESCALATED";
    await channelPoster.post({
      workspaceId,
      channelId: ops.channelId,
      agentMemberId: ops.agentMemberId,
      body: `${emoji} Self-healing ${verb}: ${record.surfaceKey} ${record.signal} — ${detail}.`,
    });
  },
};

/** Build the postmortem reporters for a pass: the rich GitHub issue (when a token+repo exist) + flywheel. */
function reportersFactory(flywheelRecord: (event: FailureEvent) => Promise<unknown>) {
  return async (_workspaceId: string): Promise<PostmortemReporter[]> => {
    const reporters: PostmortemReporter[] = [flywheelPostmortemReporter({ record: flywheelRecord })];
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    const repo = parseRepo(process.env.GITHUB_REPOSITORY);
    if (token && repo) {
      const provider = new GitHubIssueProvider();
      const existingByMarker = new Map<string, string>();
      try {
        for (const issue of await provider.listOpenIssuesByLabel(repo, token, SELF_HEALING_LABEL)) {
          const sig = parseMarker(issue.body);
          if (sig && !existingByMarker.has(sig)) {
            existingByMarker.set(sig, `github:${repo.owner}/${repo.repo}#${issue.number}`);
          }
        }
      } catch {
        // A list failure must not stop the flywheel reporter — fail-soft (the marker dedups next pass).
      }
      const client: IssueClient = {
        createIssue: async (input) => {
          const created = await provider.createIssue(repo, token, input);
          return { number: created.number, ref: created.ref };
        },
        comment: async (ref, body) => void (await provider.postComment(parseIssueRef(ref), token, body)),
      };
      reporters.unshift(githubPostmortemReporter({ client, existingByMarker }));
    }
    return reporters;
  };
}

function parseRepo(slug: string | undefined): { owner: string; repo: string } | null {
  if (!slug) return null;
  const [owner, repo] = slug.split("/");
  return owner && repo ? { owner, repo } : null;
}

/** Build the production SelfHealingEngine. The background timer is started in `index.ts` (default-off). */
export function createDefaultSelfHealingEngine(
  logger: SessionLogger,
  sessionManager: SessionManager,
  flywheelRecord: (event: FailureEvent) => Promise<unknown>,
): SelfHealingEngine {
  return new SelfHealingEngine({
    listWorkspaceIds,
    caps: (workspaceId) => resolveSelfHealingCaps(loadConfig(workspaceId).selfHealing),
    killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
    surfaces: resolveSurfaces,
    probe: probeSurface,
    correlateDeploy: (workspaceId) => correlateDeploy(workspaceId),
    store: selfHealingStore,
    // The remediation session launches through the SAME #92 launcher the rest of the platform uses, so
    // it passes the same #71 admission chokepoint. No new launch authority.
    launcher: autonomyLauncherFrom(sessionManager),
    target,
    approver,
    reporters: reportersFactory(flywheelRecord),
    notifier,
    // #99: pause the loop during maintenance (same Redis flag the write-gate + other loops read).
    maintenancePaused: () => isMaintenanceActive(),
    logger,
  });
}
