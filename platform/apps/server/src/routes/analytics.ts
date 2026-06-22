import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { defaultAnalyticsService } from "../analytics/default.js";
import type { AnalyticsService } from "../analytics/service.js";
import { defaultFunnelService, FUNNEL_DEFAULT_WINDOW_DAYS } from "../analytics/funnel/default.js";
import type { FunnelService } from "../analytics/funnel/service.js";
import type { RawFunnelEvent } from "../analytics/funnel/schema.js";

/**
 * Analytics routes (#270, #604) under `/me/analytics/*` — thin adapters scoped to the caller's
 * workspace (#3).
 *
 *  - `GET  /me/analytics`             — #270 install status + the latest externally-grounded reading (or
 *     "not connected" when the layer is off / awaiting its first reading).
 *  - `POST /me/analytics/install`     — idempotently (re)install the analytics tag now. This is the explicit
 *     entry point for the "no tag or code work by the user" promise; the console scorecard also installs
 *     lazily on read, so an owner never has to call this.
 *  - `POST /me/analytics/funnel/track` — #604 the ONE ingest door shared by the marketing site and the
 *     product: record one full-funnel event (`visit|signup|activation|paid`) with its channel + agent.
 *  - `GET  /me/analytics/funnel`       — #604 the ONE funnel view: per-stage counts, stage-to-stage
 *     conversion rates, and the same funnel broken down by channel and by agent over a trailing window.
 *
 * Installing/reading analytics and recording/reading the funnel are not money (no charge, no irreversible
 * send) and produce no egress, so these carry no #13 gate.
 */
export interface AnalyticsRoutesOptions {
  /** Tests inject a service over fakes; default builds the real config/provider/store-backed one. */
  service?: AnalyticsService;
  /** Tests inject a funnel service over the in-memory store; default is the process singleton. */
  funnelService?: FunnelService;
}

export async function analyticsRoutes(
  app: FastifyInstance,
  opts: AnalyticsRoutesOptions = {},
): Promise<void> {
  const service = opts.service ?? defaultAnalyticsService();
  const funnel = opts.funnelService ?? defaultFunnelService();

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

  /**
   * #604 funnel ingest — the single door both the marketing site and the product post events through.
   * The body is the raw funnel event; the service validates + normalizes it (a bad stage/surface/value
   * is rejected here, recording nothing) so the funnel schema stays consistent across both surfaces.
   */
  app.post("/me/analytics/funnel/track", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const body = (req.body ?? {}) as RawFunnelEvent;
    try {
      const event = await funnel.track(id.workspaceId, body);
      return reply.code(201).send({ event });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : "invalid funnel event" });
    }
  });

  /**
   * #604 the one funnel view for the caller's workspace over a trailing window (`?windowDays=`, default 7;
   * `0` ⇒ full history): per-stage counts, the conversion rates, and the channel + agent breakdowns.
   */
  app.get("/me/analytics/funnel", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const raw = (req.query as { windowDays?: string }).windowDays;
    const parsed = raw === undefined ? FUNNEL_DEFAULT_WINDOW_DAYS : Number(raw);
    const windowDays = Number.isFinite(parsed) && parsed >= 0 ? parsed : FUNNEL_DEFAULT_WINDOW_DAYS;
    return funnel.view(id.workspaceId, windowDays);
  });
}
