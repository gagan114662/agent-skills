import type { FastifyInstance } from "fastify";
import { requireIdentity } from "../auth/guard.js";
import { defaultAnalyticsService } from "../analytics/default.js";
import type { AnalyticsService } from "../analytics/service.js";
import { defaultFunnelService, FUNNEL_DEFAULT_WINDOW_DAYS } from "../analytics/funnel/default.js";
import type { FunnelService } from "../analytics/funnel/service.js";
import type { RawFunnelEvent } from "../analytics/funnel/schema.js";
import { createDefaultRevenueAnalyticsService } from "../analytics/revenue/default.js";
import { DEFAULT_WINDOW_DAYS } from "../analytics/revenue/service.js";
import type { RevenueAnalyticsService } from "../analytics/revenue/service.js";
import { isAttributionModel, type AttributionModel } from "../analytics/revenue/types.js";

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
 *  - `GET  /me/analytics/revenue`      — #615 the ONE glanceable revenue/pipeline/spend dashboard: revenue,
 *     paying customers, open pipeline, operating spend, net, a daily trend, and the multi-touch channel +
 *     agent attribution breakdowns over a trailing window.
 *  - `GET  /me/analytics/attribution/journeys`     — #614 every paying customer's multi-touch journey in the
 *     window (the full chain of agent actions + channels), highest-revenue first.
 *  - `GET  /me/analytics/attribution/journey/:ref` — #614 acceptance: ONE paying customer's end-to-end
 *     journey with its multi-touch credit split, or `404` when the ref is not a paying customer.
 *
 * Installing/reading analytics, recording/reading the funnel, and reading the revenue dashboard are not money
 * (no charge, no irreversible send) and produce no egress, so these carry no #13 gate.
 */
export interface AnalyticsRoutesOptions {
  /** Tests inject a service over fakes; default builds the real config/provider/store-backed one. */
  service?: AnalyticsService;
  /** Tests inject a funnel service over the in-memory store; default is the process singleton. */
  funnelService?: FunnelService;
  /** Tests inject a revenue service over fakes; default builds the real exposure/receipt/cost-backed one. */
  revenueService?: RevenueAnalyticsService;
}

/** Parse `?model=` into an {@link AttributionModel}, falling back to the module default (linear). */
function parseModel(raw: unknown): AttributionModel | undefined {
  return typeof raw === "string" && isAttributionModel(raw) ? raw : undefined;
}

/** Parse `?windowDays=` into a non-negative integer (`0` ⇒ full history), defaulting when absent/invalid. */
function parseWindowDays(raw: unknown): number {
  if (raw === undefined) return DEFAULT_WINDOW_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_WINDOW_DAYS;
}

export async function analyticsRoutes(
  app: FastifyInstance,
  opts: AnalyticsRoutesOptions = {},
): Promise<void> {
  const service = opts.service ?? defaultAnalyticsService();
  const funnel = opts.funnelService ?? defaultFunnelService();
  const revenue = opts.revenueService ?? createDefaultRevenueAnalyticsService();

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

  /**
   * #615 the one glanceable revenue/pipeline/spend dashboard for the caller's workspace over a trailing
   * window (`?windowDays=`, default 30; `0` ⇒ full history). `?model=` selects the multi-touch attribution
   * model for the channel/agent breakdowns (`first_touch|last_touch|linear|position_based`, default linear).
   */
  app.get("/me/analytics/revenue", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const q = req.query as { windowDays?: string; model?: string; topJourneys?: string };
    const topParsed = q.topJourneys === undefined ? undefined : Number(q.topJourneys);
    return revenue.dashboard(id.workspaceId, {
      windowDays: parseWindowDays(q.windowDays),
      model: parseModel(q.model),
      topJourneys: topParsed !== undefined && Number.isFinite(topParsed) && topParsed > 0 ? Math.floor(topParsed) : undefined,
    });
  });

  /**
   * #614 every paying customer's multi-touch journey in the window (`?windowDays=`, default 30; `0` ⇒ full
   * history; `?model=` as above): the full chain of agent actions + channels that influenced them, ordered
   * highest-revenue first.
   */
  app.get("/me/analytics/attribution/journeys", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const q = req.query as { windowDays?: string; model?: string };
    const journeys = await revenue.journeys(id.workspaceId, {
      windowDays: parseWindowDays(q.windowDays),
      model: parseModel(q.model),
    });
    return { journeys };
  });

  /**
   * #614 acceptance: ONE paying customer's end-to-end journey by tracking ref (`?model=` as above), with its
   * multi-touch credit split. `404` when the ref is not a paying customer (no payment), so the caller can
   * tell "no such customer" from "a customer with an empty chain".
   */
  app.get<{ Params: { ref: string } }>("/me/analytics/attribution/journey/:ref", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const model = parseModel((req.query as { model?: string }).model);
    const journey = await revenue.customerJourney(id.workspaceId, req.params.ref, model);
    if (!journey) {
      return reply.code(404).send({ error: "no paying customer for this tracking ref" });
    }
    return { journey };
  });
}
