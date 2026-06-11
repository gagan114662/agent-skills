import type { FastifyInstance, FastifyReply } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import {
  PortfolioService,
  PortfolioReviewNotFoundError,
  PortfolioNotSunsetError,
  PortfolioSunsetStateError,
  PortfolioSunsetNotApprovedError,
} from "../portfolio/service.js";

/**
 * Portfolio Lifecycle Loop routes (#107): the portfolio dashboard + the gated SUNSET lifecycle under
 * `/workspaces/:wid/portfolio`. Thin adapters over {@link PortfolioService} — identity + the #19
 * `assertWorkspace` IDOR boundary, then a single service call. `review` runs the per-venture tick;
 * `GET` is the dashboard projection (#104 also surfaces a compact pane); `sunset` requests the
 * #13-gated kill; `execute` finalizes it after a human approves.
 */
export interface PortfolioRoutesOptions {
  service: PortfolioService;
}

export async function portfolioRoutes(
  app: FastifyInstance,
  opts: PortfolioRoutesOptions,
): Promise<void> {
  const { service } = opts;

  /** Run the portfolio review tick: score every launched venture + persist a review per venture. */
  app.post("/workspaces/:wid/portfolio/review", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const reviews = await service.reviewPortfolio(wid, { createdByMemberId: id.memberId });
    return reply.code(201).send({ reviews });
  });

  /** The portfolio dashboard: every venture's latest decision, KPIs, burn, and net economics. */
  app.get("/workspaces/:wid/portfolio", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return reply.send({ reviews: await service.listReviews(wid) });
  });

  /** Request the #13-gated SUNSET (kill) of a launched venture from a SUNSET review. */
  app.post("/workspaces/:wid/portfolio/reviews/:id/sunset", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { wid, id } = req.params as { wid: string; id: string };
    if (!assertWorkspace(identity, wid, reply)) return;
    try {
      const result = await service.requestSunset(wid, id, { requesterMemberId: identity.memberId });
      // gated ⇒ 202 Accepted (a human must approve); opted-out auto-execute ⇒ 200.
      return reply.code(result.gated ? 202 : 200).send(result);
    } catch (err) {
      return sunsetError(reply, err);
    }
  });

  /** Finalize a gated SUNSET after the human decision: kill + post-mortem (approved) or reject. */
  app.post("/workspaces/:wid/portfolio/reviews/:id/execute", async (req, reply) => {
    const identity = await requireIdentity(req, reply);
    if (!identity) return;
    const { wid, id } = req.params as { wid: string; id: string };
    if (!assertWorkspace(identity, wid, reply)) return;
    try {
      const result = await service.executeSunset(wid, id, { actorMemberId: identity.memberId });
      return reply.send(result);
    } catch (err) {
      return sunsetError(reply, err);
    }
  });
}

/** Map the service's domain errors onto HTTP codes (404 not-found, 409 wrong-state, else rethrow). */
function sunsetError(reply: FastifyReply, err: unknown): unknown {
  if (err instanceof PortfolioReviewNotFoundError) {
    return reply.code(404).send({ error: err.message });
  }
  if (
    err instanceof PortfolioNotSunsetError ||
    err instanceof PortfolioSunsetStateError ||
    err instanceof PortfolioSunsetNotApprovedError
  ) {
    return reply.code(409).send({ error: err.message });
  }
  throw err;
}
