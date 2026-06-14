import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { loadConfig } from "../config/loader.js";
import { resolveRealworldCaps } from "../realworld/caps.js";
import { realWorldReadinessNeeded } from "../realworld/decide.js";
import { connectedAccountKinds } from "../realworld/default.js";
import type { RealWorldActuatorService } from "../realworld/service.js";
import { listArtifacts } from "../db/repositories/realworld-artifacts.js";

/**
 * Real-world tool surface routes (#231, ADR-0231). Read-only and `/me/*`-scoped to the caller's
 * workspace (#3). Surfaces what the fleet CAN do in the real world right now: each tool's gate decision,
 * exactly which external accounts the owner must still connect before a venture can do real work, and
 * the receipts of what's actually been published/parked/blocked. No writes here — publishing routes
 * through the #13 gate (`realworld.publish`), never a REST mutation.
 */
export async function realworldRoutes(
  app: FastifyInstance,
  opts: { service: RealWorldActuatorService },
): Promise<void> {
  const { service } = opts;

  app.get("/me/realworld", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const wid = identity.workspaceId;
    const enabled = resolveRealworldCaps(loadConfig(wid).realworld).enabled;
    const [availability, connectedKinds, artifacts] = await Promise.all([
      service.availability(wid),
      connectedAccountKinds(wid),
      listArtifacts(wid, 20),
    ]);
    return {
      enabled,
      neededAccounts: realWorldReadinessNeeded(connectedKinds),
      availability,
      artifacts,
    };
  });
}
