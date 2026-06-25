import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { getUsage } from "../db/repositories/tenant-usage.js";
import { resolveScaleCaps, type ScalePlanBudget } from "../scale/caps.js";
import { budgetExceeded, windowKey } from "../scale/usage.js";
import { liveSpendRegistry } from "../scale/live-spend.js";
import type { Admission } from "../scale/admission.js";
import type { ResolvedConfig } from "../config/schema.js";

export interface ScaleRoutesOptions {
  /** The live admission instance — its in-flight counters back the dashboard. */
  admission: Admission;
  /** The tenant-config source — the SAME one admission enforces, so caps shown match caps enforced. */
  config?: (workspaceId: string) => ResolvedConfig;
  /** Active paid plan projection; must match admission's source so displayed budget equals enforced budget. */
  activePlans?: { getActive(workspaceId: string): Promise<ScalePlanBudget | undefined> };
  /** Injectable clock for the window (tests pin it). */
  now?: () => Date;
}

/**
 * Cloud-scale usage dashboard surface (#71). A workspace member reads their tenant's current-window
 * usage (sessions, compute-seconds, estimated cost), the resolved caps/budget, the live in-flight
 * concurrency (global + per-tenant + per-region), and whether they are over budget. Tenant-scoped
 * via the #19 guard (`assertWorkspace`) so a caller only ever sees their own tenant's numbers.
 */
export async function scaleRoutes(app: FastifyInstance, opts: ScaleRoutesOptions): Promise<void> {
  const now = opts.now ?? (() => new Date());
  const config = opts.config ?? ((workspaceId: string) => loadConfig(workspaceId));

  app.get("/workspaces/:wid/scale/usage", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const window = windowKey(now());
    const [usage, activePlan] = await Promise.all([
      getUsage(wid, window),
      opts.activePlans?.getActive(wid) ?? Promise.resolve(undefined),
    ]);
    const caps = resolveScaleCaps(config(wid).scale, activePlan);
    const inFlight = opts.admission.snapshot(wid);
    const liveSessions = liveSpendRegistry.list(wid);

    return {
      window,
      sessionsStarted: usage.sessionsStarted,
      computeSeconds: usage.computeSeconds,
      estimatedCostCents: usage.estimatedCostCents,
      caps: {
        tenantConcurrency: caps.tenantConcurrency,
        budgetCents: caps.budgetCents,
        warmPoolSize: caps.warmPoolSize,
        regions: caps.regions,
      },
      inFlight,
      liveSessions,
      overBudget: budgetExceeded(usage.estimatedCostCents, caps.budgetCents),
    };
  });
}
