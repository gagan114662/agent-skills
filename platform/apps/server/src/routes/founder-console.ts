import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { FounderConsoleService } from "../founder-console/service.js";

export interface FounderConsoleRoutesOptions {
  service: FounderConsoleService;
}

/**
 * The Founder Console surface (#104, ADR-0050): one READ-ONLY aggregation endpoint giving the owner
 * fleet status, the venture pipeline (#96), revenue/willingness-to-pay (#98), budget burn (#71), the
 * pending #13 approval queue (with decision-SLA ages), and the kill/maintenance switches — everything
 * the daily review needs in one read. Tenant-scoped via the #19 guard (`assertWorkspace`) so a caller
 * only ever sees their own tenant's numbers. No mutations: approve/kill/maintenance flip through their
 * existing endpoints, never here.
 */
export async function founderConsoleRoutes(
  app: FastifyInstance,
  opts: FounderConsoleRoutesOptions,
): Promise<void> {
  app.get("/workspaces/:wid/founder-console", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return opts.service.get(wid);
  });
}
