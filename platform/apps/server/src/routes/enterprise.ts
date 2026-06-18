import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { EnterpriseService } from "../enterprise/service.js";
import { listEnterpriseBudgetCaps } from "../db/repositories/enterprise.js";
import { capStatus } from "../enterprise/budget.js";

/**
 * Enterprise layer read surface (#340, ADR-0340) under `/me/enterprise/*`, scoped to the caller's workspace
 * (#3). It lets a customer SEE the cost-control layer that lets ipop sell the fleet:
 *
 *  - `GET /me/enterprise/usage` — metered usage rolled up per department agent + a per-customer total, with
 *    the verified share broken out (premortem §2: only externally-grounded receipts count toward billing).
 *  - `GET /me/enterprise/caps` — the pre-committed per-agent / per-customer budget caps + their live status
 *    (remaining headroom, utilization, exhausted).
 *
 * All read-only; no #13 gate (reading status is not money). Spend that would breach a cap is gated by the
 * service through the `enterprise.budget_breach` money action, not here.
 */
export interface EnterpriseRoutesOptions {
  service: EnterpriseService;
}

export async function enterpriseRoutes(
  app: FastifyInstance,
  opts: EnterpriseRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // Metered usage per agent + per customer (the per-agent + per-customer surfaces, with verified totals).
  app.get("/me/enterprise/usage", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const [byAgent, customer] = await Promise.all([
      service.usageByAgent(id.workspaceId),
      service.usageByCustomer(id.workspaceId),
    ]);
    return { byAgent, customer };
  });

  // The pre-committed budget caps + their live status.
  app.get("/me/enterprise/caps", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const caps = await listEnterpriseBudgetCaps(id.workspaceId);
    return { caps: caps.map((c) => ({ ...c, status: capStatus(c) })) };
  });
}
