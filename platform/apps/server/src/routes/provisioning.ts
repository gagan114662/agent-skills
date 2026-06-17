import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { ProvisioningService } from "../provisioning/service.js";
import { listProvisioningUsage } from "../db/repositories/provisioning-usage.js";
import { verifiedCostCents } from "../provisioning/usage.js";

/**
 * Central provisioning read surface (#267) under `/me/provisioning/*`, scoped to the caller's workspace
 * (#3). It exists so a customer can SEE that ipop provisions the paid APIs centrally — "real keyword data:
 * billed into your plan, no API key needed" — WITHOUT ever touching a secret. There is deliberately NO
 * connect/paste endpoint here: the customer never provisions a key; the central credentials are managed
 * out-of-band in the owner workspace's #192 vault.
 *
 *  - `GET /me/provisioning` lists every capability + its state (provisioned / unavailable / customer_spend
 *    / disabled). Never carries a key — only the provider id + a human one-liner.
 *  - `GET /me/provisioning/usage` returns recent metered usage + the verified billable total (premortem
 *    §2: only externally-grounded rows count).
 *
 * All read-only; no #13 gate (reading status is not money). The customer's OWN spend stays a money-gated
 * `provisioning.customer_spend` — handled by the per-department adapters, not here.
 */
export interface ProvisioningRoutesOptions {
  service: ProvisioningService;
}

export async function provisioningRoutes(
  app: FastifyInstance,
  opts: ProvisioningRoutesOptions,
): Promise<void> {
  const { service } = opts;

  // What's provisioned for this workspace. Read-only, never a secret.
  app.get("/me/provisioning", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const capabilities = await service.status(id.workspaceId);
    return { capabilities };
  });

  // Recent metered usage + the verified billable total (the "billed into the plan" ledger).
  app.get("/me/provisioning/usage", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const usage = await listProvisioningUsage(id.workspaceId, { limit: 100 });
    return { usage, verifiedCostCents: verifiedCostCents(usage) };
  });
}
