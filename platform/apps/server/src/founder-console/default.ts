import { FounderConsoleService } from "./service.js";
import type { Verdict } from "./aggregate.js";
import type { Scale } from "../scale/default.js";
import type { BillingManager } from "../billing/manager.js";
import { resolveScaleCaps } from "../scale/caps.js";
import { windowKey } from "../scale/usage.js";
import { listEvaluations } from "../db/repositories/venture.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { listRequests } from "../db/repositories/approvals.js";
import { getControls } from "../db/repositories/autonomy.js";
import { getMaintenanceState } from "../maintenance/flag.js";

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
    now: deps.now,
  });
}
