import { FounderConsoleService } from "./service.js";
import type { Verdict } from "./aggregate.js";
import type { Scale } from "../scale/default.js";
import type { BillingManager } from "../billing/manager.js";
import type { MoatService } from "../moat/service.js";
import type { CustomerVoiceService } from "../voice/service.js";
import type { SupportDeskService } from "../support/service.js";
import { resolveMoatCaps } from "../moat/caps.js";
import type { PortfolioService } from "../portfolio/service.js";
import { resolvePortfolioCaps } from "../portfolio/caps.js";
import type { DiscoveryService } from "../discovery/service.js";
import { loadConfig } from "../config/loader.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { windowKey, nextWindowKey, recentWindowKeys } from "../scale/usage.js";
import { listEvaluations } from "../db/repositories/venture.js";
import { getUsage, getUsageTrend } from "../db/repositories/tenant-usage.js";
import { listRequests } from "../db/repositories/approvals.js";
import { getControls } from "../db/repositories/autonomy.js";
import { listPostmortems, listIncidents } from "../db/repositories/sre.js";
import { listOpen as listOpenRemediations } from "../db/repositories/self-healing.js";
import { countEscalatedRevivals } from "../db/repositories/watchdog.js";
import { computeReliabilityInsights } from "../reliability/insights/aggregate.js";
import { getMaintenanceState } from "../maintenance/flag.js";
import { ownedBoundaries, listBoundaryChanges } from "../db/repositories/gate-evidence.js";
import {
  flywheelFingerprintStore,
  flywheelDispatchStore,
} from "../db/repositories/flywheel.js";
import { buildLoopRunStore } from "../db/repositories/build-loop.js";
import { listEvents, listExperiments } from "../db/repositories/growth.js";
import { resolveGrowthCaps } from "../growth/caps.js";
import { funnelFromEvents, scoreGrowth } from "../growth/score.js";
import { listBacklogItems } from "../db/repositories/planning.js";
import { resolvePlanningCaps } from "../planning/caps.js";
import { rankBacklog } from "../planning/rice.js";
import { listOpenViolations } from "../db/repositories/constitution.js";
import { listSetupRequests } from "../db/repositories/setup-requests.js";
import { listServiceStatuses } from "../db/repositories/external-credentials.js";
import { getCredentialStatus } from "../db/repositories/agent-credentials.js";
import { decideRotationReminders } from "../onboarding/decide.js";
import type { ServiceKind } from "../onboarding/types.js";
import { realWorldReadinessNeeded } from "../realworld/decide.js";
import { resolveRealworldCaps } from "../realworld/caps.js";

/**
 * Production wiring for the Founder Console (#104, ADR-0050). Every read seam is backed by an EXISTING
 * repo/manager — no new query authority beyond the additive workspace-scoped `listEvaluations` read.
 * The console shares the live `scale` (so its fleet/budget numbers match what admission enforces) and
 * the live `billingManager` (so revenue matches the billing surface). Read-only throughout.
 */
export function createDefaultFounderConsoleService(deps: {
  scale: Scale;
  billing: BillingManager;
  /** The #103 moat service — surfaces per-venture moat + flags the stagnant ones (read-only). */
  moat?: MoatService;
  /** The #114 customer-voice service — surfaces the support inbox + churn/NPS pulse (read-only). */
  voice?: CustomerVoiceService;
  /** The #190 support-desk service — surfaces first-response SLA breaches + verified resolution (read-only). */
  supportDesk?: SupportDeskService;
  /** The #107 portfolio service — surfaces the launched-venture review decisions + sunset queue (read-only). */
  portfolio?: PortfolioService;
  /** The #222 discovery service — surfaces the 5-stage GTM pipeline + PQL count (read-only). */
  discovery?: DiscoveryService;
  now?: () => Date;
}): FounderConsoleService {
  const { scale, billing, moat, voice, supportDesk, portfolio, discovery } = deps;
  return new FounderConsoleService({
    fleet: {
      tenantInFlight: (workspaceId) => scale.admission.snapshot(workspaceId).tenant,
      globalInFlight: () => scale.admission.snapshot("").global,
    },
    venture: {
      evaluations: async (workspaceId) =>
        (await listEvaluations(workspaceId)).map((e) => ({
          ideaId: e.ideaId,
          status: e.status,
          terminalVerdict: e.terminalVerdict as Verdict | null,
          lastScore: e.lastScore,
        })),
    },
    revenue: {
      summary: async (workspaceId) => {
        const r = await billing.revenue(workspaceId);
        return {
          currency: r.currency,
          totalCents: r.totalCents,
          paymentCount: r.paymentCount,
          evidenceCount: r.evidenceCount,
        };
      },
    },
    budget: {
      window: (now) => windowKey(now),
      usage: (workspaceId, window) => getUsage(workspaceId, window),
      budgetCents: (workspaceId) => resolveScaleCaps(scale.config(workspaceId).scale).budgetCents,
    },
    // #113 cost forecast: the trend is the last 6 windows of tenant_usage; the caps come from the SAME
    // resolved scale policy admission enforces (so the infra ceiling + tenant concurrency match reality).
    forecast: {
      trend: (workspaceId, now) => getUsageTrend(workspaceId, recentWindowKeys(now, 6)),
      forecastWindow: (now) => nextWindowKey(now),
      infraBudgetCeilingCents: (workspaceId) =>
        resolveScaleCaps(scale.config(workspaceId).scale).infraBudgetCeilingCents,
      tenantConcurrency: (workspaceId) =>
        resolveScaleCaps(scale.config(workspaceId).scale).tenantConcurrency,
    },
    approvals: {
      pending: async (workspaceId) =>
        (await listRequests(workspaceId, { status: "pending" })).map((r) => ({
          id: r.id,
          actionType: r.actionType,
          summary: r.summary,
          amount: r.amount,
          createdAtMs: r.createdAt.getTime(),
        })),
    },
    switches: {
      killSwitch: async (workspaceId) => (await getControls(workspaceId)).killSwitch,
      maintenance: async () => {
        const m = await getMaintenanceState();
        return { enabled: m.enabled, since: m.since, reason: m.reason, unavailable: m.unavailable };
      },
    },
    // #112: the recent SRE postmortems, so the daily review links the durable trace each incident left.
    postmortems: {
      recent: async (workspaceId) =>
        (await listPostmortems(workspaceId)).map((i) => ({
          incidentId: i.id,
          service: i.service,
          sloKind: i.sloKind,
          path: i.postmortemPath as string,
          resolvedAtMs: (i.resolvedAt ?? i.openedAt).getTime(),
        })),
    },
    // #148: MTTR / frequency / noisiest components off the SAME `sre_incidents` rows, computed by the
    // pure insights module (so the console pane matches the public status page's view). Read-only.
    reliability: {
      insights: async (workspaceId) =>
        computeReliabilityInsights(await listIncidents(workspaceId, { limit: 200 }), new Date()),
    },
    gateBoundaries: {
      boundaries: async (workspaceId) => {
        const [owned, changes] = await Promise.all([
          ownedBoundaries(workspaceId),
          listBoundaryChanges(workspaceId),
        ]);
        return {
          owned,
          history: changes.map((c) => ({
            actionType: c.actionType,
            direction: c.direction,
            errorRate: c.errorRate,
            windowSize: c.windowSize,
            atMs: c.createdAt.getTime(),
            reason: c.reason,
          })),
        };
      },
    },
    // #117 self-healing flywheel pane: read-only fingerprint + dispatch state for the daily review.
    flywheel: {
      state: async (workspaceId) => {
        const [fingerprints, dispatches] = await Promise.all([
          flywheelFingerprintStore.listForConsole(workspaceId),
          flywheelDispatchStore.listForConsole(workspaceId),
        ]);
        return {
          fingerprints: fingerprints.map((f) => ({
            id: f.id,
            signature: f.signature,
            failureClass: f.failureClass,
            status: f.status,
            occurrenceCount: f.occurrenceCount,
            issueRef: f.issueRef,
            excludedFromAutoDispatch: f.excludedFromAutoDispatch,
            escalated: f.escalated,
          })),
          dispatches: dispatches.map((d) => ({
            id: d.id,
            fingerprintId: d.fingerprintId,
            mode: d.mode,
            status: d.status,
            reason: d.reason,
          })),
        };
      },
    },
    // #193 self-healing OPS signal: open per-venture incidents + the watchdog stuck-agent count. Any
    // escalated incident or stuck agent turns the console fleet-health dot red (the AC3 signal).
    selfHealingOps: {
      snapshot: async (workspaceId) => {
        const [open, stuckAgents] = await Promise.all([
          listOpenRemediations(workspaceId),
          countEscalatedRevivals(workspaceId),
        ]);
        return {
          openIncidents: open.filter((r) => r.status === "firing" || r.status === "remediating").length,
          escalatedIncidents: open.filter((r) => r.status === "escalated").length,
          stuckAgents,
        };
      },
    },
    // #172 self-shipping loop pane: read-only run state for the daily review (queue / in-flight / merged
    // / escalated). Reads the recent runs through the same store the route + engine use.
    buildLoop: {
      state: async (workspaceId) => {
        const runs = await buildLoopRunStore.listForConsole(workspaceId);
        return {
          runs: runs.map((r) => ({
            id: r.id,
            issueRef: r.issueRef,
            issueTitle: r.issueTitle,
            status: r.status,
            reviewRounds: r.reviewRounds,
            prRef: r.prRef,
            mergeRef: r.mergeRef,
            escalationReason: r.escalationReason,
          })),
        };
      },
    },
    // #102 growth loop pane: read the events + experiments, score the funnel off the SAME pure scorer
    // the routes use (so the console score matches the API), and reshape to the read-struct. Read-only.
    growth: {
      state: async (workspaceId) => {
        const [events, experiments] = await Promise.all([
          listEvents(workspaceId),
          listExperiments(workspaceId),
        ]);
        const caps = resolveGrowthCaps(loadConfig(workspaceId).growth);
        const funnel = funnelFromEvents(events);
        const { score } = scoreGrowth(funnel, caps);
        const acquisitionBySource = new Map<string, number>();
        for (const e of events) {
          if (e.kind !== "acquisition" || e.value <= 0) continue;
          const s = e.source || "(unattributed)";
          acquisitionBySource.set(s, (acquisitionBySource.get(s) ?? 0) + e.value);
        }
        const topSource =
          [...acquisitionBySource.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
        return {
          totalEvents: events.length,
          funnel,
          score,
          topSource,
          experiments: experiments.map((x) => ({
            status: x.status,
            hasExternalPost: x.approvalRequestId !== null,
          })),
        };
      },
    },
    // #222 customer discovery pipeline pane: the 5-stage GTM pipeline (outreach → … → post_sales) +
    // PQL count, computed off the SAME pure pipelineMetrics the discovery routes use (so the console +
    // API never disagree). Read-only. Absent ⇒ a zeroed pipeline (all stages 0).
    discovery: discovery
      ? {
          pipeline: async (workspaceId) => {
            const s = await discovery.pipelineSummary(workspaceId);
            return {
              stages: s.metrics.stages.map((st) => ({
                stage: st.stage,
                prospects: st.prospects,
                verifiedProspects: st.verifiedProspects,
              })),
              totalProspects: s.metrics.totalProspects,
              pqlCount: s.pqlCount,
            };
          },
        }
      : undefined,
    // #115 planning roadmap pane: read the backlog, rank it off the SAME pure RICE scorer the routes use
    // (so the console roadmap matches the API), and reshape to the read-struct with the why-ranked-here
    // evidence link per item. Read-only; `enabled` comes from the resolved planning caps (default OFF).
    planning: {
      state: async (workspaceId) => {
        const ranked = rankBacklog(await listBacklogItems(workspaceId));
        return {
          enabled: resolvePlanningCaps(loadConfig(workspaceId).planning).enabled,
          items: ranked.map((r) => ({
            id: r.item.id,
            title: r.item.title,
            source: r.item.source,
            sourceRef: r.item.sourceRef,
            score: r.score,
            position: r.position,
            status: r.item.status,
            isPivot: r.item.isPivot,
            awaitingApproval: r.item.approvalRequestId !== null,
          })),
        };
      },
    },
    // #103 moat accrual: per-venture moat roll-ups + the stagnation flag. The portfolio reuses the SAME
    // venture evaluation list the pipeline view reads, so a zero-accrual venture (no ledger rows) is
    // still scored + flagged. enabled/windowDays come from the resolved moat caps (default OFF).
    moat: moat
      ? {
          portfolio: async (workspaceId) => {
            const ideaIds = (await listEvaluations(workspaceId)).map((e) => e.ideaId);
            const rollups = await moat.portfolioMoat(workspaceId, ideaIds);
            return rollups.map((m) => ({
              ventureIdeaId: m.ventureIdeaId,
              score: m.score,
              stagnant: m.stagnant,
              accrualsInWindow: m.accrualsInWindow,
              lastAccrualAtMs: m.lastAccrualAtMs,
            }));
          },
          enabled: (workspaceId) => resolveMoatCaps(loadConfig(workspaceId).moat).enabled,
          windowDays: (workspaceId) => resolveMoatCaps(loadConfig(workspaceId).moat).stagnationWindowDays,
        }
      : undefined,
    // #146 constitution: surface the count of open (un-acknowledged) violations for the attention list.
    // Read-only over the durable feed the venture-loop sink writes; the top codes drive the message.
    constitution: {
      openViolations: async (workspaceId) => {
        const open = await listOpenViolations(workspaceId);
        return { openViolations: open.length, topCodes: [...new Set(open.map((v) => v.code))] };
      },
    },
    // #114 customer voice: the support inbox + churn/NPS pulse, computed off the SAME pure digest the
    // route uses (so the console + API never disagree). Read-only.
    voice: voice
      ? {
          snapshot: async (workspaceId) => {
            const digest = await voice.digest(workspaceId);
            return {
              ticketsNeedingHuman: digest.ticketsNeedingHuman,
              npsScore: digest.npsScore,
              highChurnRisk: digest.churnHigh,
              negativeSentiment: digest.sentiment.negative,
              totalSignals: digest.totalSignals,
              digestHeadline: digest.headline,
            };
          },
        }
      : undefined,
    // #190 support desk: first-response SLA breaches + reality-grounded resolution (verified via external
    // receipts vs UNVERIFIED status-only). Computed off the SAME pure sla/metrics the route uses. Read-only.
    supportSla: supportDesk
      ? {
          snapshot: async (workspaceId) => {
            const [breaches, metrics] = await Promise.all([
              supportDesk.slaBreaches(workspaceId),
              supportDesk.resolutionMetrics(workspaceId),
            ]);
            return {
              breaches: breaches.length,
              worstOverdueMinutes: breaches[0]?.overdueMinutes ?? 0,
              resolvedVerified: metrics.resolvedVerified,
              resolvedUnverified: metrics.resolvedUnverified,
            };
          },
        }
      : undefined,
    // #107 portfolio lifecycle: the launched-venture review decisions + the sunset gate queue. The pane
    // reduces these to the latest review per venture; `enabled` (default OFF) gates only its attention.
    portfolio: portfolio
      ? {
          reviews: async (workspaceId) =>
            (await portfolio.listReviews(workspaceId)).map((r) => ({
              ventureIdeaId: r.ventureIdeaId,
              decision: r.decision,
              status: r.status,
              score: r.score,
              netCents: r.netCents,
              createdAtMs: r.createdAt.getTime(),
            })),
          enabled: (workspaceId) => resolvePortfolioCaps(loadConfig(workspaceId).portfolio).enabled,
        }
      : undefined,
    // #192 external account onboarding: how many services still need the owner + the credential-hygiene
    // pulse (connected count, rotations due). Read-only over the onboarding repos; blocked setup also
    // shows in the pending-approval queue (it parks a #13 approval). offlineCapabilities stays 0 until a
    // capability registry is persisted (capability state is derived per-request by the pure core).
    setup: {
      snapshot: async (workspaceId) => {
        const [requests, creds, claude] = await Promise.all([
          listSetupRequests(workspaceId),
          listServiceStatuses(workspaceId),
          // #231: "Connect Claude" (#68) writes the `workspace_agent_credentials` vault, a DIFFERENT
          // table from the #192 `external_credentials` this pane reads — which is exactly why `connected`
          // read 0 with Claude wired. Fold the Claude subscription into the connected count so the
          // readiness signal reflects reality.
          getCredentialStatus(workspaceId),
        ]);
        const connectedSet = new Set(creds.filter((c) => c.connected).map((c) => c.serviceKey));
        const rotationDue = decideRotationReminders(
          creds
            .filter((c) => c.connected)
            .map((c) => ({
              serviceKey: c.serviceKey,
              connectedAtMs: c.connectedAtMs,
              rotationReminderDays: c.rotationReminderDays,
            })),
          (deps.now ?? (() => new Date()))().getTime(),
        ).length;
        // #231: what the owner must still connect before a venture can do REAL real-world work — the
        // external account KINDS the real-world tools act through, minus what's connected. Map each
        // connected service to its kind via its setup request, then ask the real-world readiness core.
        // Only surfaced once the owner opts into the real-world surface (default OFF keeps it quiet).
        const realworldEnabled = resolveRealworldCaps(loadConfig(workspaceId).realworld).enabled;
        const kindByKey = new Map<string, ServiceKind>(
          requests.map((r) => [r.serviceKey, r.serviceKind as ServiceKind]),
        );
        const connectedKinds = new Set<ServiceKind>();
        for (const key of connectedSet) {
          const kind = kindByKey.get(key);
          if (kind) connectedKinds.add(kind);
        }
        const needed = realworldEnabled ? realWorldReadinessNeeded(connectedKinds).length : 0;
        return {
          pendingSetup: requests.filter(
            (r) => !connectedSet.has(r.serviceKey) && r.status !== "dismissed",
          ).length,
          connected: connectedSet.size + (claude.connected ? 1 : 0),
          rotationDue,
          offlineCapabilities: 0,
          needed,
        };
      },
    },
    now: deps.now,
  });
}
