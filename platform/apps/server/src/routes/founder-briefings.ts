import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { FounderBriefingsService } from "../founder-briefings/service.js";
import { listBriefingDeliveries } from "../db/repositories/founder-briefings.js";

export interface FounderBriefingsRoutesOptions {
  service: FounderBriefingsService;
}

/**
 * The Founder Briefings surface (#173, ADR-0173): READ-ONLY endpoints that render the daily brief, the
 * weekly founder report (per-venture P&L), and the unified decision queue into the Founder Console —
 * the same views the scheduled tick delivers as a digest. Tenant-scoped via the #19 guard
 * (`assertWorkspace`) so a caller only ever sees their own tenant's report. No mutations: delivery is
 * driven by the engine/tick, never a request; approvals/kills/prices flip through their own endpoints.
 */
export async function founderBriefingsRoutes(
  app: FastifyInstance,
  opts: FounderBriefingsRoutesOptions,
): Promise<void> {
  app.get("/workspaces/:wid/founder-briefings/daily", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return opts.service.dailyBrief(wid);
  });

  app.get("/workspaces/:wid/founder-briefings/weekly", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return opts.service.weeklyReport(wid);
  });

  app.get("/workspaces/:wid/founder-briefings/decision-queue", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return opts.service.decisionQueue(wid);
  });

  // The delivery audit (#148-style): what was sent, when, to which channels — the "zero polling" proof.
  app.get("/workspaces/:wid/founder-briefings/deliveries", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return { deliveries: await listBriefingDeliveries(wid) };
  });
}
