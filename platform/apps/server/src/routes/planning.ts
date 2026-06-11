import type { FastifyInstance } from "fastify";
import { requireIdentity, assertWorkspace } from "../auth/guard.js";
import type { PlanningService } from "../planning/service.js";
import { isBacklogSource, type BacklogEvidence } from "../planning/types.js";

/**
 * Product Planning Loop routes (#115, ADR-0115) under `/workspaces/:wid/planning`. Thin adapters over
 * {@link PlanningService} — identity + the #19 `assertWorkspace` IDOR boundary, then a single service
 * call. Recording items + reading the ranked backlog are always available; the tick drafts a spec for
 * the top item and proposes a build session through the venture-gated #96 launcher (or #13-gates a
 * sensitive one). Default-OFF: a disabled workspace's tick is a no-op.
 */
export interface PlanningRoutesOptions {
  service: PlanningService;
}

/** Coerce a request body's evidence bag into the typed {@link BacklogEvidence} (missing counts → 0/1). */
function readEvidence(raw: unknown): BacklogEvidence {
  const e = (raw ?? {}) as Record<string, unknown>;
  const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
  return {
    signalCount: num(e.signalCount, 0),
    severityTier: num(e.severityTier, 0),
    corroboratingSources: num(e.corroboratingSources, 0),
    effortPoints: num(e.effortPoints, 1),
  };
}

export async function planningRoutes(app: FastifyInstance, opts: PlanningRoutesOptions): Promise<void> {
  const { service } = opts;

  /** Record a backlog item from evidence (RICE inputs are derived from the counts). */
  app.post("/workspaces/:wid/planning/items", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;

    const body = (req.body ?? {}) as {
      title?: string;
      description?: string;
      source?: string;
      sourceRef?: string;
      ideaId?: string;
      isPivot?: boolean;
      evidence?: unknown;
      targetChannelId?: string;
      targetAgentMemberId?: string;
    };
    if (!body.title) return reply.code(400).send({ error: "title is required" });
    if (!isBacklogSource(body.source)) {
      return reply
        .code(400)
        .send({ error: "source must be one of customer_voice, growth, verifier, manual" });
    }
    const item = await service.addItem(wid, {
      title: body.title,
      description: body.description,
      source: body.source,
      sourceRef: body.sourceRef,
      ideaId: body.ideaId ?? null,
      isPivot: body.isPivot ?? false,
      evidence: readEvidence(body.evidence),
      targetChannelId: body.targetChannelId ?? null,
      targetAgentMemberId: body.targetAgentMemberId ?? null,
    });
    return reply.code(201).send(item);
  });

  /** The RICE-ranked backlog (the roadmap): each item + its score, breakdown, and rank position. */
  app.get("/workspaces/:wid/planning/backlog", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.backlogView(wid);
  });

  /** The drafted specs for the workspace (the repo-lifecycle-format bodies). */
  app.get("/workspaces/:wid/planning/specs", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    return service.listSpecs(wid);
  });

  /** Run one planning pass: rank → draft spec for the top item → propose a session (or #13-gate it). */
  app.post("/workspaces/:wid/planning/tick", async (req, reply) => {
    const id = await requireIdentity(req, reply);
    if (!id) return;
    const { wid } = req.params as { wid: string };
    if (!assertWorkspace(id, wid, reply)) return;
    const result = await service.tick(wid);
    return reply.code(200).send(result);
  });
}
