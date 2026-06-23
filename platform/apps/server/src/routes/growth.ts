import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import { GrowthService, GrowthExperimentNotFoundError } from "../growth/service.js";
import { isGrowthEventKind } from "../growth/types.js";
import { isMarketingSendKind } from "../marketing/external-send.js";

/**
 * Growth Loop routes (#102, ADR-0102) under `/workspaces/:wid/growth`. Thin adapters over
 * {@link GrowthService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service
 * call. Event ingest + reads are always available; the external-post promotion builds the existing
 * `external.send` descriptor and submits it to the #13 gate (a human posts — agents never publish).
 */
export interface GrowthRoutesOptions {
  service: GrowthService;
}

export async function growthRoutes(app: FastifyInstance, opts: GrowthRoutesOptions): Promise<void> {
  const { service } = opts;

  /** Instrumentation ingest: record one growth event (acquisition/activation/conversion/retention). */
  app.post("/workspaces/:wid/growth/events", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      ideaId?: string;
      kind?: string;
      source?: string;
      value?: number;
      metadata?: Record<string, unknown>;
      occurredAt?: string;
    };
    if (!isGrowthEventKind(body.kind)) {
      return reply
        .code(400)
        .send({ error: "kind must be one of acquisition, activation, conversion, retention" });
    }
    const event = await service.recordEvent(wid, {
      ideaId: body.ideaId ?? null,
      kind: body.kind,
      source: body.source,
      value: body.value,
      metadata: body.metadata,
      occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
    });
    return reply.code(201).send(event);
  });

  /** The workspace growth summary: funnel + score + top sources + experiments + next experiments. */
  app.get("/workspaces/:wid/growth", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.summary(wid);
  });

  /** The per-venture growth summary (#96/#107): the same roll-up scoped to one idea. */
  app.get("/workspaces/:wid/growth/ventures/:vid", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, vid } = req.params as { wid: string; vid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.summary(wid, vid);
  });

  /** A marketing agent (#123) proposes a channel experiment. */
  app.post("/workspaces/:wid/growth/experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      ideaId?: string;
      channel?: string;
      hypothesis?: string;
      targetQuery?: string;
    };
    if (!body.channel || !body.hypothesis) {
      return reply.code(400).send({ error: "channel and hypothesis are required" });
    }
    const experiment = await service.proposeExperiment(wid, {
      ideaId: body.ideaId ?? null,
      channel: body.channel,
      hypothesis: body.hypothesis,
      targetQuery: body.targetQuery,
      proposedByMemberId: id.memberId,
    });
    return reply.code(201).send(experiment);
  });

  /** List the workspace's channel experiments. */
  app.get("/workspaces/:wid/growth/experiments", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.listExperiments(wid);
  });

  /** Pause losing campaign/content experiments after a fair sample and report the reason to the user. */
  app.post("/workspaces/:wid/growth/experiments/auto-pause", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const paused = await service.autoPauseUnderperformers(wid);
    return reply.send({ paused });
  });

  /**
   * Promote an experiment to an external post → builds the `external.send` descriptor and submits it to
   * the #13 gate (a pending approval a human must approve + post). 202 with the gated request id.
   */
  app.post("/workspaces/:wid/growth/experiments/:eid/external-post", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid, eid } = req.params as { wid: string; eid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      kind?: string;
      summary?: string;
      target?: string;
      amountCents?: number;
    };
    if (!isMarketingSendKind(body.kind)) {
      return reply
        .code(400)
        .send({ error: "kind must be one of social.post, email.send, ad.spend" });
    }
    if (!body.summary) {
      return reply.code(400).send({ error: "summary is required" });
    }
    try {
      const result = await service.requestExternalPost(wid, eid, {
        requesterMemberId: id.memberId,
        kind: body.kind,
        summary: body.summary,
        target: body.target,
        amountCents: body.amountCents,
      });
      return reply.code(202).send({
        approvalRequestId: result.approvalRequestId,
        experiment: result.experiment,
      });
    } catch (err) {
      if (err instanceof GrowthExperimentNotFoundError) {
        return reply.code(404).send({ error: err.message });
      }
      throw err;
    }
  });
}
