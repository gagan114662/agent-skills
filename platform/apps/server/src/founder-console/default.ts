import { FounderConsoleService } from "./service.js";
import type { Verdict } from "./aggregate.js";
import type { Scale } from "../scale/default.js";
import type { BillingManager } from "../billing/manager.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { windowKey, nextWindowKey, recentWindowKeys } from "../scale/usage.js";
import { listEvaluations } from "../db/repositories/venture.js";
import { getUsage, getUsageTrend } from "../db/repositories/tenant-usage.js";
import { listRequests } from "../db/repositories/approvals.js";
import { getControls } from "../db/repositories/autonomy.js";
import { listPostmortems } from "../db/repositories/sre.js";
import { getMaintenanceState } from "../maintenance/flag.js";
import { ownedBoundaries, listBoundaryChanges } from "../db/repositories/gate-evidence.js";
import {
  flywheelFingerprintStore,
  flywheelDispatchStore,
} from "../db/repositories/flywheel.js";
import { listEvents, listExperiments } from "../db/repositories/growth.js";
import { resolveGrowthCaps } from "../growth/caps.js";
import { funnelFromEvents, scoreGrowth } from "../growth/score.js";
import { loadConfig } from "../config/loader.js";

/**
 * Production wiring for the Founder Console (#104, ADR-0050). Every read seam is backed by an EXISTING
 * repo/manager — no new query authority beyond the additive workspace-scoped `listEvaluations` read.
 * The console shares the live `scale` (so its fleet/budget numbers match what admission enforces) and
 * the live `billingManager` (so revenue matches the billing surface). Read-only throughout.
 */
export function createDefaultFounderConsoleService(deps: {
  scale: Scale;
  billing: BillingManager;
  now?: () => Date;
}): FounderConsoleService {
  const { scale, billing } = deps;
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
    now: deps.now,
  });
}
