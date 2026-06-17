import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { defaultAnalyticsService } from "../analytics/default.js";
import type { AnalyticsService } from "../analytics/service.js";

/**
 * Analytics routes (#270) under `/me/analytics/*` — thin adapters over {@link AnalyticsService}, scoped to
 * the caller's workspace (#3).
 *
 *  - `GET  /me/analytics`         — install status + the latest externally-grounded reading (or "not
 *     connected" when the layer is off / awaiting its first reading).
 *  - `POST /me/analytics/install` — idempotently (re)install the analytics tag now. This is the explicit
 *     entry point for the "no tag or code work by the user" promise; the console scorecard also installs
 *     lazily on read, so an owner never has to call this.
 *
 * Installing/reading analytics is not money (no charge, no irreversible send), so these carry no #13 gate.
 */
export interface AnalyticsRoutesOptions {
  /** Tests inject a service over fakes; default builds the real config/provider/store-backed one. */
  service?: AnalyticsService;
}

export async function analyticsRoutes(
  app: FastifyInstance,
  opts: AnalyticsRoutesOptions = {},
): Promise<void> {
  const service = opts.service ?? defaultAnalyticsService();

  app.get("/me/analytics", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    return service.summary(id.workspaceId);
  });

  app.post("/me/analytics/install", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const install = await service.ensureInstalled(id.workspaceId);
    return { install };
  });
}
